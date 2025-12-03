![sbwCloudworks](swbCloudworksBanner.png)
![ClickStreamDiagramV10](ClickStreamDiagramV10.png)
### Clickstream Analytics Platform for E-Commerce
# Lambda Ingest (HTTP API -> S3 Raw)
* Runtime: Node.js 20.x, arch x86_64  
* Entry point: `ClickStream.Lambda.Ingest/index.mjs` exporting `handler`  
* Trigger: API Gateway HTTP API v2 `POST /clickstream`  
* Writes raw events to S3 with UTC partitions: `events/YYYY/MM/DD/HH/event-<uuid>.json`  
* Required env: `RAW_BUCKET_NAME`  

---

## 1. Create Lambda (AWS Console)

#### Create function
1. AWS Console → Lambda → **Create function**
2. **Author from scratch**
3. **Function name** = `clickstream-lambda-ingest`
4. **Runtime** = `Node.js 20.x`
5. **Architecture** = `x86_64`
6. **Permissions → Execution role**  
   - Select: **Create a new role with basic Lambda permissions**
7. Scroll down → **Create function**

## 2. Upload deployment ZIP from repo

#### Prepare ZIP locally
Folder structure:
```

ClickStream.Lambda.Ingest/
└── index.mjs

```

Create ZIP (Windows PowerShell):

```powershell
Compress-Archive -Path index.mjs -DestinationPath lambda.zip -Force
```

#### Upload ZIP to Lambda

1. Open function → tab **Code**
2. Click **Upload from → .zip file**
3. Choose `lambda.zip`
4. Save

## 3. Update Handler

1. Tab: **Code**
2. Box: **Runtime settings** 
3. Field **Handler** = `index.handler`

## 4. Set environment variables

1. Open: **Configuration → Environment variables**
2. Click **Edit**
3. Add:

   * **Key:** `RAW_BUCKET_NAME`
   * **Value:** `<your-raw-clickstream-s3-bucket>`

Save changes.

## 5. Add S3 permission to execution role

1. Open: **Configuration → Permissions**
2. Click the IAM Role link (e.g., `clickstream-lambda-ingest-role-xxxxx`)
3. In IAM: **Add inline policy**
4. Choose **JSON** and paste:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:*:*:*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject"
      ],
      "Resource": "arn:aws:s3:::<RAW_BUCKET_NAME>/events/*"
    }
  ]
}
```

5. Replace `<RAW_BUCKET_NAME>`
6. Click **Review policy → Save**

## 6. (Important) Confirm Lambda stays *outside* VPC

1. Open: **Configuration → VPC**
2. Ensure value is:

   * **VPC:** `Not configured`

(*This is required so the ingest Lambda can write to S3 without VPC endpoints or NAT Gateway.*)

## 7. Test the Lambda (HTTP API v2 event)

1. Open: **Test** tab
2. Click **Create new test event**
3. Paste this sample input:

```json
{
  "version": "2.0",
  "routeKey": "POST /clickstream",
  "rawPath": "/clickstream",
  "rawQueryString": "",
  "headers": {
    "content-type": "application/json",
    "x-amzn-trace-id": "Root=1-67891233-abcdef012345678912345678",
    "user-agent": "Mozilla/5.0"
  },
  "requestContext": {
    "accountId": "123456789012",
    "apiId": "abc123",
    "requestId": "test-request-id",
    "stage": "$default",
    "http": {
      "method": "POST",
      "path": "/clickstream",
      "protocol": "HTTP/1.1",
      "sourceIp": "203.0.113.1",
      "userAgent": "Mozilla/5.0"
    }
  },
  "body": "{\"eventName\":\"view_product\",\"userId\":\"u-123\",\"sessionId\":\"s-abc\",\"pageUrl\":\"https://example.com/product/sku-1\",\"referrer\":\"https://google.com\",\"userLoginState\":\"guest\",\"product\":{\"id\":\"sku-1\",\"name\":\"Laptop\",\"category\":\"Computers\",\"brand\":\"SBW\",\"price\":1200,\"discountPrice\":999}}",
  "isBase64Encoded": false
}
```

4. Click **Test**
5. Expect:

   * Response: `200 OK`
   * S3 bucket contains:

     ```
     events/YYYY/MM/DD/HH/event-xxxx.json
     ```
---

# 🏗️ Architecture Summary

## 1. User-Facing Domain

### Frontend

- Built using **Next.js**
- Hosted on **AWS Amplify Hosting**
- Amplify internally leverages:
  - **Amazon CloudFront** (global CDN)
  - **Amazon S3** (static assets bucket)
- Authentication handled by:
  - **Amazon Cognito User Pool**

### Operational Database (OLTP)

- A standalone **EC2** instance running **PostgreSQL**
- Stores:
  - Users
  - Products
  - Orders
  - OrderItems
  - Inventory & transactional data
- Located in the **Public Subnet** so that Amplify’s SSR / API routes can connect via **Prisma** using `DATABASE_URL`

> Note: In a strict production design OLTP would typically be private (e.g. RDS in private subnet),  
> but this architecture intentionally allows public OLTP EC2 so that Amplify (which is not inside the VPC) can connect directly.

---

## 2. Ingestion & Data Lake Domain

### Ingestion Flow

1. The frontend records user behavior (page views, clicks, interactions).
2. Events are POSTed as JSON to **Amazon API Gateway (HTTP API)** at:
   ```http
   POST /clickstream
   ```
3. API Gateway invokes a **Lambda Ingest Function**.
4. Lambda Ingest:

   * Validates the payload
   * Enriches metadata (timestamps, user/session IDs, etc.)
   * Writes raw JSON into the **S3 Raw Clickstream Bucket**:

   ```text
   s3://<raw-clickstream-bucket>/events/YYYY/MM/DD/HH/events-<uuid>.json
   ```

### Batch ETL Flow

* **Amazon EventBridge** defines a **cron rule** (e.g. every 30 minutes).
* On each schedule:

  * EventBridge triggers **Lambda ETL** (configured inside the VPC).
  * Lambda ETL:

    * Reads the new raw files from **S3 Raw Bucket**
    * Cleans, normalizes, and sessionizes events
    * Converts NoSQL-style JSON into **SQL-ready analytic tables**
    * Inserts processed data into the **PostgreSQL Data Warehouse** hosted on EC2 in a private subnet

No additional “processed” S3 bucket is used — processed data is written directly to SQL tables in the DW.

---

## 3. Analytics & Data Warehouse Domain

The analytics environment uses **two EC2 instances**, each with a dedicated role.

### EC2 #1 — OLTP Database (Public Subnet)

* PostgreSQL database for the e-commerce application
* Serves live operational traffic:

  * Product listing
  * Cart/checkout
  * Orders, inventory, users
* Accessible over the internet only to:

  * Amplify SSR / backend
  * Admin / maintenance IPs (via Security Groups)

---

### EC2 #2 — Data Warehouse + R Shiny (Private Subnet)

#### PostgreSQL Data Warehouse

* Stores curated clickstream analytics schema:

  * event_id
  * event_timestamp
  * event_name
  * user_id
  * user_login_state
  * identity_source
  * client_id
  * session_id
  * is_first_visit
  * product_id
  * product_name
  * product_category
  * product_brand
  * product_price
  * product_discount_price
  * product_url_path
  * Aggregated metrics tables
* Located in a **Private Subnet** (no public IP)
* Receives data exclusively from **Lambda ETL** within the VPC

#### R Shiny Analytics Server

* Runs on the same EC2 instance as the DW
* Connects locally to the DW database
* Hosts interactive dashboards visualizing:

  * User journeys
  * Conversion funnels
  * Product engagement
  * Time-based activity trends

> OLTP and Analytics are fully separated, ensuring reporting queries do not impact transactional performance.

---

# 🔐 Networking & Security Design

## VPC Layout

* **VPC CIDR**: `10.0.0.0/16`
* **Internet Gateway (IGW)**:
  * Attached to the VPC
  * Provides bidirectional connectivity between the VPC and the public internet
  * Routes traffic for resources in the public subnet with public IP addresses

* **Subnets**:

  * **Public Subnet (10.0.1.0/24) - OLTP Layer**

    * EC2 PostgreSQL OLTP (with public IP)
    * Routes internet traffic via **Internet Gateway**
    * Allows inbound connections from external services (Amplify, admin IPs)
    * Allows outbound internet access for updates and external API calls

  * **Private Subnet 1 (10.0.2.0/24) - Analytics Layer**

    * EC2 Data Warehouse (PostgreSQL) - no public IP
    * EC2 R Shiny Server - no public IP
    * No direct internet access (no route to IGW)
    * Isolated from public internet for security

  * **Private Subnet 2 (10.0.3.0/24) - ETL Layer**

    * Lambda ETL (VPC-enabled) - no public IP
    * S3 Gateway VPC Endpoint (for private S3 access)
    * No direct internet access (no route to IGW)

## Routing

* **Public Route Table** (associated with Public Subnet)

  * `10.0.0.0/16` → Local (VPC internal routing)
  * `0.0.0.0/0` → **Internet Gateway** (default route to the internet)
  * Enables EC2 OLTP to:
    * Accept inbound connections from Amplify and admin IPs
    * Make outbound connections for software updates, external APIs, etc.

* **Private Route Table 1** (associated with Private Subnet 1 - Analytics)

  * `10.0.0.0/16` → Local (VPC internal routing only)
  * **No default route to Internet Gateway**
  * No direct internet access; fully isolated

* **Private Route Table 2** (associated with Private Subnet 2 - ETL)

  * `10.0.0.0/16` → Local (VPC internal routing)
  * Prefix list routes for S3 → **S3 Gateway VPC Endpoint**
  * **No default route to Internet Gateway**
  * S3 access via VPC endpoint (private AWS network)

**Key Design Decision**: No NAT Gateway is deployed.  
Private components (Data Warehouse, R Shiny, Lambda ETL) reach S3 exclusively through the S3 Gateway VPC Endpoint, eliminating NAT costs while maintaining security.

## Security Groups

* **SG-OLTP**

  * Inbound:

    * `5432/tcp` – from Amplify / trusted IPs (for Prisma)
    * `22/tcp` – from admin IP (for SSH)
  * Outbound: default (all allowed)

* **SG-DW**

  * Inbound:

    * `5432/tcp` – from Lambda ETL SG and Shiny SG
  * Outbound: default (all allowed)

* **SG-Shiny**

  * Inbound: restricted to admin/VPN only (or internal admin tools)
  * Outbound: permitted to DW (localhost or private IP)

* **SG-ETL-Lambda**

  * No inbound (Lambda does not accept inbound)
  * Outbound: allowed to S3 endpoint + DW SG via private networking

## External AWS Services (Outside VPC)

Several AWS managed services operate outside the customer VPC and interact with VPC resources:

* **AWS Amplify Hosting**
  * Hosts the Next.js frontend application
  * Connects to OLTP EC2 in public subnet via the Internet Gateway
  * Uses Prisma ORM to query PostgreSQL over the public internet
  * Secured by EC2 Security Group rules allowing specific IPs/ranges

* **Amazon CloudFront**
  * Distributes static assets globally
  * Pulls content from Amplify's managed S3 bucket
  * No direct VPC interaction

* **Amazon Cognito**
  * Regional service managing user authentication
  * Accessed by frontend via AWS SDK (HTTPS)
  * No direct VPC interaction

* **Amazon API Gateway (HTTP API)**
  * Entry point for clickstream event ingestion
  * Invokes Lambda Ingest function (outside VPC)
  * Lambda Ingest writes to S3 (no VPC configuration needed)

* **Amazon EventBridge**
  * Regional service triggering scheduled ETL jobs
  * Invokes Lambda ETL (VPC-enabled in Private Subnet 2)
  * No direct VPC interaction

> **Note**: Only Lambda ETL is VPC-enabled to access the Data Warehouse in the private subnet.  
> Lambda Ingest operates outside the VPC for simpler configuration and lower latency when writing to S3.

---

## IAM & Monitoring

* Dedicated IAM roles per Lambda function:

  * **Lambda Ingest Role**: S3 write-only (Raw bucket)
  * **Lambda ETL Role**: S3 read + DB access permissions + VPC execution role
* **CloudWatch Logs** for:

  * API Gateway access logs
  * Lambda Ingest & ETL logs
  * ETL execution metrics
  * VPC Flow Logs (optional, for network traffic analysis)

---

# 📦 S3 Buckets (2 Buckets Only)

1. **Amplify Assets Bucket**

   * Stores static website assets (JS, CSS, images, etc.)
   * Managed by Amplify Hosting

2. **Raw Clickstream Data Bucket**

   * Stores raw JSON clickstream events from Lambda Ingest
   * Partitioned by date/hour to support batch ETL

No additional “processed” bucket is required; all processed data is loaded directly into the PostgreSQL Data Warehouse.

---

# 🔁 Data Flow Summary

## User Interaction Flow

1. User accesses the web app via **CloudFront** (CDN) → **Amplify Hosting** (external to VPC)
2. User authenticates via **Amazon Cognito** (external to VPC)
3. User interacts with the UI; Amplify SSR/API routes query **OLTP EC2** via **Internet Gateway** using Prisma

## Clickstream Ingestion Flow

4. Frontend JavaScript sends clickstream events to **API Gateway** (HTTP API, external to VPC)
5. **API Gateway** invokes **Lambda Ingest** (external to VPC)
6. Lambda Ingest writes raw event JSON files into **S3 Raw Clickstream Bucket**

## Batch ETL Processing Flow

7. **EventBridge** (cron schedule, e.g., every 30 minutes) triggers **Lambda ETL**
8. **Lambda ETL** (VPC-enabled in Private Subnet 2):
   * Reads new raw event files from **S3 Raw Bucket** via **S3 Gateway VPC Endpoint** (private AWS network)
   * Cleans, normalizes, and sessionizes events
   * Converts NoSQL-style JSON into **SQL-ready analytic tables**
   * Connects to **PostgreSQL Data Warehouse** (EC2 in Private Subnet 1) via VPC internal routing
   * Inserts processed rows into DW tables (sessions, events, funnels, etc.)

## Analytics Access Flow

9. **R Shiny Server** (on same EC2 instance as DW in Private Subnet 1):
   * Connects to DW via localhost/private IP
   * Reads processed analytics data
   * Renders interactive dashboards
10. Admin accesses dashboards via secure/private access (VPN, bastion host, or AWS Systems Manager Session Manager)

---

## Architecture Flow Diagram Reference

The numbered flow in the architecture diagram illustrates:
- **(1)** User login via Cognito
- **(2-5)** User browsing via CloudFront → Amplify → API Gateway → Lambda Ingest
- **(6-8)** Amplify connecting to OLTP via Internet Gateway
- **(9-13)** Batch ETL processing from S3 → Lambda ETL → Data Warehouse → R Shiny

---

# 🧩 Key Features

* Batch clickstream ingestion using API Gateway + Lambda + S3
* Serverless ETL with EventBridge scheduling
* Clear separation between:

  * **OLTP** (online transaction processing)
  * **Analytics / Data Warehouse**
* R Shiny-based visual analytics, fully private
* Cost-optimized:

  * No NAT Gateway
  * S3 for raw storage
  * Lambda-based compute for ETL
* Direct PostgreSQL connectivity from Amplify using Prisma

---

# 🛠️ Tech Stack

### AWS Services

* **AWS Amplify Hosting** — Next.js hosting (SSR + static assets)
* **Amazon CloudFront** — CDN edge distribution
* **Amazon Cognito** — User authentication and identity
* **Amazon S3** — Static assets + raw clickstream data
* **Amazon API Gateway (HTTP API)** — Ingestion endpoint for events
* **AWS Lambda (Ingest & ETL)** — Serverless compute for data pipeline
* **Amazon EventBridge** — Scheduled ETL triggers (cron job)
* **Amazon EC2** — OLTP DB + DW + Shiny
* **Amazon VPC** — Network isolation (public & private subnets)
* **AWS IAM** — Access control
* **Amazon CloudWatch** — Logging & monitoring

### Databases

* **PostgreSQL (EC2 OLTP)** — Operational database for the e-commerce app
* **PostgreSQL (EC2 Data Warehouse)** — Analytical database for clickstream data

### Analytics

* **R Shiny Server** — Analytics dashboards
* **Custom ETL logic** — Lambda ETL transforming S3 JSON → SQL tables
