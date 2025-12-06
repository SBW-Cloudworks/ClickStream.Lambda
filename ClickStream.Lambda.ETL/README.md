# ClickStream Lambda ETL

## 1. Objective
Hourly ETL (EventBridge trigger) reads clickstream JSON files in S3 `events/YYYY/MM/DD/HH/`, transforms them, and inserts into PostgreSQL DW.

## 2. Processing flow
1) Determine UTC hour (or override) to build prefix `events/YYYY/MM/DD/HH/`.
2) List objects under the prefix, read each JSON.
3) Parse and map fields:
   - `event_id`: use payload if present, otherwise generate UUID.
   - `event_timestamp`: prefer `_ingest.receivedAt`, then payload `event_timestamp`, fallback LastModified.
   - Core: `event_name`, `user_id`, `user_login_state`, `identity_source`, `client_id`, `session_id`, `is_first_visit`.
   - Product: `context_product_id/name/category/brand/price/discount_price/url_path`.
4) Batch insert into PostgreSQL (ON CONFLICT DO NOTHING on `event_id`), batch size configurable.
5) Log processed/inserted counts; skip and log malformed JSON.

## 3. Environment variables
- `RAW_BUCKET_NAME`: S3 bucket for raw clickstream.
- `DW_PG_HOST`, `DW_PG_PORT`, `DW_PG_USER`, `DW_PG_PASSWORD`, `DW_PG_DATABASE`: PostgreSQL DW connection (private IP).
- `DW_PG_SSL` (optional, "true"): enable TLS if needed.
- `TARGET_TABLE` (default `clickstream_events`).
- `MAX_RECORDS_PER_BATCH` (default 200).

## 4. VPC constraints
- Lambda in private subnet, no internet/NAT; only S3 via Gateway Endpoint and PostgreSQL via private IP/SG.
- Bundle dependencies (`@aws-sdk/client-s3`, `pg`) in the package or layer; no runtime downloads.
- PG host must be private; SG allows Lambda SG -> PG port.

## 5. Extensibility
- To store `element` (click metadata) or `_ingest` JSON, add columns and extend insert.
- Finalize enums/semantics for price/discount as needed.

## 6. Mapping code blocks (index.mjs)
- [0] Overview (S3 -> transform -> PG) + payload overrides.
- [1] Convert S3 stream to string.
- [2] Build prefix from UTC datetime.
- [3] Resolve prefix (overridePrefix > targetUtcHour > targetUtcDate > hoursBack with optional scope=day > default previous UTC hour).
- [4] Coerce numeric safely.
- [5] Validate table name.
- [6] Map raw JSON -> DW row (prefer `_ingest.receivedAt`, generate UUID if missing).
- [7] Build INSERT batch + ON CONFLICT DO NOTHING.
- [8] Ensure target table exists (CREATE TABLE IF NOT EXISTS) before insert.
- [9] Handler orchestration (env + VPC private, no internet).

## 7. Override prefix when testing (Lambda Console Test payload)
- Use Event JSON directly in the Test tab (no API Gateway needed).
- Optional fields:
  - `overridePrefix`: exact prefix, e.g. `"events/2025/12/06/05/"`.
  - `targetUtcHour`: ISO/epoch, e.g. `"2025-12-06T05:00:00Z"` -> scan hour 05 UTC.
  - `targetUtcDate`: ISO/epoch, e.g. `"2025-12-06"` -> scan the whole day (prefix `events/2025/12/06/`).
  - `hoursBack`: hours to go back from now (default 1), e.g. `2` -> UTC -2 hours.
  - `scope`: `"day"` to scan the whole day for `hoursBack`/`targetUtcDate` (otherwise hour scope).
- Priority: overridePrefix > targetUtcHour > targetUtcDate > hoursBack (+scope) > default previous UTC hour.

### Payload examples (ordered by priority)
- `overridePrefix` (scan exact prefix):
```json
{ "overridePrefix": "events/2025/12/06/05/" }
```
- `targetUtcHour` (scan one UTC hour):
```json
{ "targetUtcHour": "2025-12-06T05:00:00Z" }
```
- `targetUtcDate` (scan the full UTC day):
```json
{ "targetUtcDate": "2025-12-06" }
```
- `hoursBack` (scan previous N UTC hours):
```json
{ "hoursBack": 2 }
```
- `hoursBack` + `scope=day` (scan the whole UTC day at that offset):
```json
{ "hoursBack": 1, "scope": "day" }
```
