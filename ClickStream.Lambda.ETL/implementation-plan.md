# ClickStream Lambda ETL — Implementation Plan

## Context
- Ingest Lambda (`Lambda/ClickStream.Lambda.Ingest/Lambda-Ingest.mjs`) writes raw events to S3 at `events/YYYY/MM/DD/HH/event-<uuid>.json` with an `_ingest` block (receivedAt, sourceIp, userAgent, path, requestId, apiId, stage, traceId).
- Events arrive from frontend clickstream tracker (page_view, click, custom) and include client/session/user info plus element/product context.
- Dataframe target is described in `docs/clickstream_dataframe.md` (clickstream_events-style table in DW/PostgreSQL).
- ETL Lambda is triggered hourly by EventBridge; it should process the previous UTC hour folder.

## Goals
- Read raw JSON from S3 (previous hour partition), transform to a SQL-ready shape, and upsert/insert into PostgreSQL DW (EC2, private subnet).
- Generate stable `event_id` (UUID) if not present.
- Preserve ingest metadata for observability (optionally in a side table or JSON column).

## Assumptions / Config (env vars)
- `RAW_BUCKET_NAME` — S3 bucket for raw clickstream data.
- `DW_PG_HOST`, `DW_PG_PORT`, `DW_PG_USER`, `DW_PG_PASSWORD`, `DW_PG_DATABASE` — PostgreSQL DW connection.
- `DW_PG_SSL` (optional) — enable TLS if required.
- `TARGET_TABLE` (default `clickstream_events`).
- `MAX_RECORDS_PER_BATCH` (e.g., 500) for batch inserts.

## Input Mapping (raw -> DW)
- event_name -> event_name
- pageUrl -> page_url (derived from payload)
- referrer -> referrer
- userId -> user_id
- userLoginState -> user_login_state
- identity_source (if present in raw) -> identity_source; else NULL
- clientId -> client_id
- sessionId -> session_id
- isFirstVisit -> is_first_visit
- product -> context_product_* (id, name, category, brand, price, discountPrice, urlPath)
- element -> click metadata (optional: tag, id, role, text, dataset) — store as JSON if target table has a column, or omit if not modeled.
- _ingest.* -> store in a JSON column (e.g., ingest_metadata) or ignore if table does not include it.
- event_timestamp: use `_ingest.receivedAt` if present, else payload timestamp if available, else object LastModified as fallback.
- event_id: use payload-provided id if exists; otherwise generate UUID v4.

## Processing Steps
1) **Determine time window**
   - Compute previous UTC hour from invocation time.
   - Build prefix `events/YYYY/MM/DD/HH/`.
2) **List objects**
   - S3 ListObjectsV2 with the prefix; page through if needed.
3) **Fetch and parse**
   - For each object, GetObject, parse JSON; skip/record malformed items.
4) **Transform**
   - Map fields per above; coerce types (numbers, booleans, strings).
   - Generate `event_id`, `event_timestamp`.
   - Optional: normalize product price/discount, ensure integers/decimals as per DW schema.
5) **Persist**
   - Batch insert into PostgreSQL using parameterized INSERT (or INSERT ... ON CONFLICT DO NOTHING if reprocessing is possible).
   - Wrap in transaction per batch; retry on transient errors.
6) **Metrics/Logging**
   - Count processed/failed records; log failed keys for reprocessing.

## Error Handling & Idempotency
- If rerun, rely on primary key `event_id` (and/or unique on requestId+path) with ON CONFLICT DO NOTHING.
- Skip malformed JSON but log object key.
- If DB unavailable, surface error so Lambda can be retried; avoid partial commits by batching in transactions.

## Testing Plan
- Local unit: feed sample raw event JSON, validate transform output.
- Integration (optional via AWS SAM/LocalStack if available): mock S3 list/get and mock PG connection.
- Manual: drop a few sample files in `events/YYYY/MM/DD/HH/`, invoke handler, verify rows in DW.

## Open Questions
- Should click `element` metadata be stored (JSON column) or dropped?
- Definitive enum set for event_name/user_login_state/identity_source in DW.
- Price/discount semantics (integer cents vs decimal; absolute vs percent).

## VPC / Network Constraints
- Lambda ETL runs in a private subnet with no internet/NAT. Only allowed egress: S3 via Gateway Endpoint, PostgreSQL via VPC (private IP/SG).
- Package all dependencies with the Lambda (pg, aws-sdk v3); no runtime downloads.
- Use DW private endpoint/host + SG rules to allow Lambda SG -> PG port; no public DNS expected.
- If secrets come from env vars (no SSM/Secrets Manager endpoints), keep them bundled; if using SSM/Secrets Manager, ensure VPC endpoints are provisioned.
- Keep PG connection pool minimal (e.g., 1–2) and close after batch to avoid lingering connections.
