import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";

const s3 = new S3Client({});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Credentials": "true",
  "Content-Type": "application/json",
};

export const handler = async (event = {}) => {
  console.log("Clickstream ingest invoked");

  try {
    const bucket = process.env.RAW_BUCKET_NAME;
    if (!bucket) {
      throw new Error("RAW_BUCKET_NAME env var is required");
    }

    const { requestContext = {}, headers = {} } = event;
    const http = requestContext.http || {};

    if (http.method !== "POST" || http.path !== "/clickstream") {
      throw new Error(`Unsupported route: ${http.method || "?"} ${http.path || "?"}`);
    }

    if (!event.body) {
      throw new Error("Missing request body");
    }

    let payload;
    try {
      payload = JSON.parse(event.body);
    } catch (parseErr) {
      throw new Error("Request body is not valid JSON");
    }

    const enriched = {
      ...payload,
      _ingest: {
        receivedAt: new Date().toISOString(),
        sourceIp: http.sourceIp,
        userAgent: http.userAgent,
        method: http.method,
        path: http.path,
        requestId: requestContext.requestId,
        apiId: requestContext.apiId,
        stage: requestContext.stage,
        traceId: headers["x-amzn-trace-id"] || headers["X-Amzn-Trace-Id"],
      },
    };

    const now = new Date();
    const year = now.getUTCFullYear().toString();
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    const day = String(now.getUTCDate()).padStart(2, "0");
    const hour = String(now.getUTCHours()).padStart(2, "0");
    const key = `events/${year}/${month}/${day}/${hour}/event-${randomUUID()}.json`;

    console.log(`Writing clickstream event to s3://${bucket}/${key}`);

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(enriched),
        ContentType: "application/json",
      })
    );

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ success: true }),
    };
  } catch (err) {
    console.error("Error ingesting clickstream event", err);

    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: "Internal error" }),
    };
  }
};
