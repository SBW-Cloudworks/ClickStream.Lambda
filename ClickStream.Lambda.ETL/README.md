# ClickStream Lambda ETL

## 1. Mục tiêu
Lambda ETL chạy mỗi giờ (EventBridge trigger), đọc các file JSON clickstream ở S3 `events/YYYY/MM/DD/HH/`, transform và insert vào PostgreSQL DW.

## 2. Dòng xử lý (logic)
1) Xác định giờ UTC trước, tạo prefix `events/YYYY/MM/DD/HH/`.
2) List S3 objects theo prefix, đọc từng file JSON.
3) Parse và map trường:
   - `event_id`: dùng payload nếu có, không thì generate UUID.
   - `event_timestamp`: ưu tiên `_ingest.receivedAt` (ingest), sau đó `event_timestamp` trong payload, fallback `LastModified`.
   - Core: `event_name`, `user_id`, `user_login_state`, `identity_source`, `client_id`, `session_id`, `is_first_visit`.
   - Product: `context_product_id/name/category/brand/price/discount_price/url_path`.
4) Batch insert vào PostgreSQL (ON CONFLICT DO NOTHING theo `event_id`), batch size cấu hình.
5) Log số processed/inserted; skip và log khi JSON lỗi.

## 3. Biến môi trường
- `RAW_BUCKET_NAME`: bucket S3 raw clickstream.
- `DW_PG_HOST`, `DW_PG_PORT`, `DW_PG_USER`, `DW_PG_PASSWORD`, `DW_PG_DATABASE`: kết nối PostgreSQL DW (private IP).
- `DW_PG_SSL` (optional, "true"): bật TLS nếu cần.
- `TARGET_TABLE` (mặc định `clickstream_events`).
- `MAX_RECORDS_PER_BATCH` (mặc định 200).

## 4. Ràng buộc VPC
- Lambda trong private subnet, không internet/NAT; chỉ truy cập S3 qua Gateway Endpoint và PostgreSQL qua private IP/SG.
- Bundle dependencies (`@aws-sdk/client-s3`, `pg`) trong package hoặc layer; không tải runtime.
- PG host phải là private endpoint; SG cho phép Lambda SG -> PG port.

## 5. Mở rộng
- Nếu muốn lưu `element` (metadata click) hoặc `_ingest` JSON, cần thêm cột vào table và mở rộng insert.
- Enum/semantics giá/discount cần chốt để chuẩn hóa dữ liệu.

## 6. Mapping code blocks (index.mjs)
- [0] Tổng quan ETL (S3 -> transform -> PG).
- [1] Convert stream S3 sang string.
- [2] Prefix giờ UTC trước (`events/YYYY/MM/DD/HH/`).
- [3] Coerce numeric an toàn.
- [4] Bảo vệ tên bảng hợp lệ.
- [5] Map raw JSON -> row DW (ưu tiên `_ingest.receivedAt`, sinh UUID nếu thiếu).
- [6] Build INSERT batch + ON CONFLICT DO NOTHING.
- [7] Handler orchestration (đòi hỏi env + VPC private, không internet).
- [8] Ensure bảng đích tồn tại (CREATE TABLE IF NOT EXISTS) trước khi insert.
