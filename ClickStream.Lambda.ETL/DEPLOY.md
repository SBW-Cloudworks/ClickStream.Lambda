# Deploy hướng dẫn (ClickStream Lambda ETL)

## Chuẩn bị
1) Cấu hình VPC:
   - Private subnet cho Lambda.
   - S3 Gateway VPC Endpoint cho bucket RAW.
   - Security Group cho Lambda cho phép outbound tới S3 endpoint và PostgreSQL SG.
   - PostgreSQL (DW) trong private subnet với SG cho phép inbound từ Lambda SG trên port 5432.
2) Biến môi trường (Lambda):
   - `RAW_BUCKET_NAME`
   - `DW_PG_HOST`, `DW_PG_PORT`, `DW_PG_USER`, `DW_PG_PASSWORD`, `DW_PG_DATABASE`
   - `DW_PG_SSL` (tùy chọn, "true")
   - `TARGET_TABLE` (tùy chọn, mặc định `clickstream_events`)
   - `MAX_RECORDS_PER_BATCH` (tùy chọn)
3) Runtime: Node.js 20.x (hoặc 18.x) cho Lambda.

## Đóng gói & Upload
1) Cài dependency local (prod only) — tham chiếu code blocks [0]-[7] trong `index.mjs`:
   ```powershell
   cd Lambda/ClickStream.Lambda.ETL
   npm install --production
   ```
   (không cần npm i khi runtime vì Lambda không có internet; `node_modules` sẽ đi kèm zip. Nếu muốn dùng layer, vẫn phải build local.)
2) Tạo zip kèm mã nguồn + node_modules:
   ```powershell
   Compress-Archive -Path index.mjs,package.json,package-lock.json,node_modules -DestinationPath lambda-etl.zip -Force
   ```
3) Upload zip lên Lambda (Console hoặc CLI):
   ```bash
   aws lambda update-function-code --function-name clickstream-lambda-etl --zip-file fileb://lambda-etl.zip
   ```

## Cấu hình Lambda
- Runtime: Node.js 20.x.
- Handler: `index.handler`.
- Memory/time: đề xuất 512–1024 MB, timeout 30–60s (tùy số file).
- VPC: gán private subnets + SG đã chuẩn bị.
- Env vars: nhập theo mục chuẩn bị.

## EventBridge trigger
- Rule cron mỗi giờ: `cron(5 * * * ? *)` (chạy phút 5 mỗi giờ, xử lý giờ trước).
- Target: Lambda ETL.
- Quyền: EventBridge được invoke Lambda (AWS tự cấu hình khi add target).

## Kiểm tra
1) Thả vài file mẫu vào `events/YYYY/MM/DD/HH/` trên S3 (folder giờ trước).
2) Invoke thử Lambda từ Console hoặc `aws lambda invoke`.
3) Kiểm tra CloudWatch Logs: processed/inserted count, lỗi parse/DB.
4) Xác nhận dòng dữ liệu xuất hiện trong bảng `clickstream_events` (PostgreSQL DW).

## Lưu ý
- Không có internet: mọi dependency phải nằm trong zip/layer.
- Dọn kết nối PG: handler đã đóng kết nối sau batch; keep pool nhỏ (max=1).
- Nếu cần Secrets Manager/SSM cho credential, phải có VPC Endpoint tương ứng hoặc inject env thủ công.
