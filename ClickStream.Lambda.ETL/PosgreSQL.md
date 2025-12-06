# PostgreSQL Data Warehouse – SBW_EC2_Shiny_and_DWH

> File này dùng để ghi lại **toàn bộ bước khởi tạo & cấu hình PostgreSQL** trên EC2 DWH.

---

## 1. Thông tin chung

* **OS**: Ubuntu 22.04 LTS
* **PostgreSQL**: 18 – cluster `18/main`
* **EC2 private IP**: `10.0.131.112`
* **VPC CIDR**: `10.0.0.0/16`
* **Port PostgreSQL**: `5432`

**Thông số cho Data Warehouse**

| Mục                 | Giá trị hiện tại     |
| ------------------- | -------------------- |
| DB name             | `clickstream_dw`     |
| DB owner (dùng ETL) | `postgres`           |
| Password            | `sbw@123`            |
| Host (Lambda dùng)  | `10.0.131.112`       |
| SSL                 | `false` (nội bộ VPC) |

---

## 2. Kiểm tra cluster PostgreSQL

```bash
# Liệt kê các cluster PostgreSQL hiện có
sudo pg_lsclusters
```

Kết quả kỳ vọng:

```text
Ver Cluster Port Status Owner    Data directory              Log file
18  main    5432 online postgres /var/lib/postgresql/18/main /var/log/postgresql/postgresql-18-main.log
```

Nếu cluster `18 main` **không online**:

```bash
# Start cluster
sudo pg_ctlcluster 18 main start
# hoặc
sudo systemctl start postgresql
```

Kiểm tra service:

```bash
sudo systemctl status postgresql
```

---

## 3. Đăng nhập psql

```bash
sudo -u postgres psql
```

Thoát:

```sql
\q
```

Xem version:

```sql
SELECT version();
```

---

## 4. Khởi tạo database & user cho Data Warehouse

> Thực hiện bên trong `psql` (sau khi chạy `sudo -u postgres psql`).

```sql
-- 1. Tạo database DWH
CREATE DATABASE clickstream_dw;

-- 2. Đặt / cập nhật mật khẩu cho user postgres (dùng chung cho WebDB & DWH)
ALTER USER postgres WITH PASSWORD 'sbw@123';

-- 3. Cấp quyền cho postgres trên DB DWH
GRANT ALL PRIVILEGES ON DATABASE clickstream_dw TO postgres;
```

Thoát:

```sql
\q
```

---

## 5. Cấu hình `postgresql.conf`

File đường dẫn:

```bash
sudo nano /etc/postgresql/18/main/postgresql.conf
```

Các giá trị quan trọng đã chỉnh:

```conf
# Lắng nghe mọi interface trong VPC (bảo vệ bằng SG)
listen_addresses = '0.0.0.0'

# Port mặc định
port = 5432

# Các thông số khác (giữ mặc định của Ubuntu/PG 18)
# max_connections, shared_buffers, work_mem ... => chưa custom
```

Sau khi sửa, **luôn nhớ restart**:

```bash
sudo systemctl restart postgresql
```

---

## 6. Cấu hình `pg_hba.conf`

File đường dẫn:

```bash
sudo nano /etc/postgresql/18/main/pg_hba.conf
```

Các rule chính:

```conf
# Local UNIX socket
local   all             postgres                                peer

# IPv4 local connections:
host    all             all             127.0.0.1/32            scram-sha-256

# IPv6 local connections:
host    all             all             ::1/128                 scram-sha-256

# Cho phép toàn bộ VPC 10.0.0.0/16 truy cập bằng password
host    all             all             10.0.0.0/16             md5
```

> Lưu ý: không cần canh thẳng cột, chỉ cần các field cách nhau bởi ít nhất 1 khoảng trắng.

Restart sau khi chỉnh:

```bash
sudo systemctl restart postgresql
```

---

## 7. Kiểm tra kết nối từ chính EC2

### 7.1. Kết nối qua localhost

```bash
psql -U postgres -d clickstream_dw
```

Nếu được hỏi password → nhập `sbw@123`.

### 7.2. Kết nối qua private IP (mô phỏng Lambda)

```bash
psql -h 10.0.131.112 -U postgres -d clickstream_dw
```

Nếu lệnh này chạy OK → Lambda trong cùng VPC/subnet + SG đúng là **sẽ connect được**.

---

## 8. Mapping sang ENV cho Lambda ETL

Các env đang/ sẽ dùng cho Lambda ETL:

```env
RAW_BUCKET_NAME=clickstream-s3-ingest
TARGET_TABLE=clickstream_events
MAX_RECORDS_PER_BATCH=100

DW_PG_HOST=10.0.131.112
DW_PG_PORT=5432
DW_PG_USER=postgres
DW_PG_PASSWORD=sbw@123
DW_PG_DATABASE=clickstream_dw
DW_PG_SSL=false
```

---

## 9. Ghi chú mở rộng (nếu muốn tinh chỉnh sau này)

* Khi cần **tune performance**:

  * `shared_buffers`
  * `work_mem`
  * `maintenance_work_mem`
  * `effective_cache_size`
* Khi cần **giới hạn quyền**:

  * Tạo user riêng `dw_user` chỉ dùng cho ETL
  * Chỉ GRANT trên `clickstream_dw`
* Khi thay đổi cấu hình:

  * Sửa `postgresql.conf` / `pg_hba.conf`
  * Chạy lại `sudo systemctl restart postgresql`

---