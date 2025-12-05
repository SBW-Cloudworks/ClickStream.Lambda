# ClickStream Lambda Ingest

How `index.mjs` processes clickstream events via HTTP API and stores raw events in S3.

## Summary
- Runtime Node.js 22, entry `handler` in `index.mjs`.
- Triggered by API Gateway HTTP API v2, only accepts `POST /clickstream`.
- Writes JSON to the S3 bucket from env `RAW_BUCKET_NAME`, UTC partitions: `events/YYYY/MM/DD/HH/event-<uuid>.json`.
- Returns JSON `{"success": true}` with permissive CORS headers on every response.

## Processing flow
1. Read env var `RAW_BUCKET_NAME`; throw if missing.
2. Validate route/method: allow `routeKey === "POST /clickstream"` or HTTP method POST.
3. Require body and parse JSON; otherwise respond 400.
4. Log `eventName` and `userId` (if present) for quick debugging.
5. Enrich payload with `_ingest`:
   - `receivedAt`: ISO timestamp when Lambda received the request (UTC).
   - `sourceIp`, `userAgent`, `method`, `path` from `requestContext.http`.
   - `requestId`, `apiId`, `stage` from `requestContext`.
   - `traceId` from header `x-amzn-trace-id`.
6. Build S3 key by UTC hour and write JSON via `PutObject` (content-type `application/json`).
7. On success, return 200 `{ success: true }`.
8. Client errors (missing body, invalid JSON, wrong route/method) return 400 `{ success: false, message }`. Other errors return 500 `{ success: false, message: "Internal error" }`.

## Configuration requirements
- Env: `RAW_BUCKET_NAME=<raw-clickstream-bucket>`.
- Lambda IAM needs at least:
  - `s3:PutObject` on `arn:aws:s3:::<RAW_BUCKET_NAME>/events/*`
  - Basic CloudWatch Logs permissions.
- Keep ingest Lambda outside VPC (default) so it can write to S3 without extra networking setup.

## Sample request (API Gateway HTTP API v2)
```http
POST /clickstream HTTP/1.1
Host: <api-id>.execute-api.<region>.amazonaws.com
Content-Type: application/json

{
  "eventName": "view_product",
  "userId": "u-123",
  "sessionId": "s-abc",
  "pageUrl": "https://example.com/p/sku-1",
  "product": { "id": "sku-1", "name": "Laptop" }
}
```

## Expected result
- Response: `200 OK` with body `{"success":true}`.
- S3: new file at `events/YYYY/MM/DD/HH/event-<uuid>.json` containing the original payload plus `_ingest`.

## Quick call (curl)
```bash
curl -X POST "https://<api-id>.execute-api.<region>.amazonaws.com/clickstream" \
  -H "Content-Type: application/json" \
  -d '{"eventName":"view_product","userId":"u-123","sessionId":"s-abc"}'
```
