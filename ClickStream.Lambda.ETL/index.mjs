// [0] ClickStream Lambda ETL
//   1) Read raw clickstream JSON from S3 (previous UTC hour by default)
//   2) Allow override via test payload: overridePrefix, targetUtcHour, targetUtcDate, hoursBack, scope=hour|day
//   3) Transform to DW shape and insert into PostgreSQL
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { Client as PgClient } from "pg";
import { randomUUID } from "crypto";

const s3 = new S3Client({});

const DEFAULT_BATCH_SIZE = 200;

// [1] Convert S3 stream to string
const streamToString = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
};

// [2] Build prefix for a given UTC datetime
const prefixFromDate = (dt) => {
  const year = dt.getUTCFullYear().toString();
  const month = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(dt.getUTCDate()).padStart(2, "0");
  const hour = String(dt.getUTCHours()).padStart(2, "0");
  return { year, month, day, hour, prefix: `events/${year}/${month}/${day}/${hour}/` };
};

// [3] Decide prefix based on override payload or default (previous UTC hour)
const resolvePrefix = (event) => {
  // Highest priority: explicit overridePrefix
  if (event?.overridePrefix) {
    return { prefix: event.overridePrefix, reason: "overridePrefix" };
  }
  // Next: targetUtcHour ISO string or epoch (hour scope)
  if (event?.targetUtcHour) {
    const t = new Date(event.targetUtcHour);
    const { prefix } = prefixFromDate(t);
    return { prefix, reason: "targetUtcHour" };
  }
  // Next: targetUtcDate ISO string or epoch (day scope)
  if (event?.targetUtcDate) {
    const t = new Date(event.targetUtcDate);
    const { year, month, day } = prefixFromDate(t);
    return { prefix: `events/${year}/${month}/${day}/`, reason: "targetUtcDate" };
  }
  // Next: hoursBack (integer, default 1)
  const hoursBack = Number.isFinite(Number(event?.hoursBack)) ? Number(event.hoursBack) : 1;
  const now = new Date();
  const base = new Date(now);
  base.setUTCMinutes(0, 0, 0);
  base.setUTCHours(base.getUTCHours() - hoursBack);
  const { year, month, day, hour, prefix } = prefixFromDate(base);
  // scope=day to scan whole day of the computed date
  if (event?.scope === "day") {
    return { prefix: `events/${year}/${month}/${day}/`, reason: `hoursBack=${hoursBack},scope=day` };
  }
  return { prefix, reason: `hoursBack=${hoursBack},scope=hour` };
};

// [4] Coerce numeric fields safely
const coerceNumber = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

// [5] Protect against unsafe table names
const safeTableName = (name, fallback = "clickstream_events") => {
  const regex = /^[A-Za-z0-9_]+$/;
  return regex.test(name || "") ? name : fallback;
};

// [6] Map raw JSON (ingest payload + metadata) to DW row shape
const parseEvent = (raw, lastModified) => {
  if (!raw || typeof raw !== "object") return null;

  const product = raw.product || raw.context_product || {};
  const ingestTs = raw._ingest?.receivedAt ? new Date(raw._ingest.receivedAt) : null;
  const payloadTs = raw.event_timestamp
    ? new Date(raw.event_timestamp)
    : raw.eventTimestamp
    ? new Date(raw.eventTimestamp)
    : null;
  const fallbackTs = lastModified ? new Date(lastModified) : new Date();

  const eventTimestamp = ingestTs || payloadTs || fallbackTs;

  const event = {
    event_id: raw.event_id || raw.eventId || randomUUID(),
    event_timestamp: eventTimestamp.toISOString(),
    event_name: raw.eventName || raw.event_name || "unknown",
    user_id: raw.userId ?? raw.user_id ?? null,
    user_login_state: raw.userLoginState ?? raw.user_login_state ?? null,
    identity_source: raw.identity_source ?? raw.identitySource ?? null,
    client_id: raw.clientId ?? raw.client_id ?? null,
    session_id: raw.sessionId ?? raw.session_id ?? null,
    is_first_visit: raw.isFirstVisit ?? raw.is_first_visit ?? null,
    context_product_id: product.id ?? product.product_id ?? null,
    context_product_name: product.name ?? product.product_name ?? null,
    context_product_category: product.category ?? product.product_category ?? null,
    context_product_brand: product.brand ?? product.product_brand ?? null,
    context_product_price: coerceNumber(product.price ?? product.product_price),
    context_product_discount_price: coerceNumber(product.discountPrice ?? product.product_discount_price),
    context_product_url_path: product.urlPath ?? product.product_url_path ?? null,
  };

  return event;
};

// [7] Build parameterized INSERT for batch rows with ON CONFLICT DO NOTHING
const buildInsert = (rows, table) => {
  const cols = [
    "event_id",
    "event_timestamp",
    "event_name",
    "user_id",
    "user_login_state",
    "identity_source",
    "client_id",
    "session_id",
    "is_first_visit",
    "context_product_id",
    "context_product_name",
    "context_product_category",
    "context_product_brand",
    "context_product_price",
    "context_product_discount_price",
    "context_product_url_path",
  ];

  const values = [];
  const placeholders = rows.map((row, rowIdx) => {
    const base = rowIdx * cols.length;
    values.push(
      row.event_id,
      row.event_timestamp,
      row.event_name,
      row.user_id,
      row.user_login_state,
      row.identity_source,
      row.client_id,
      row.session_id,
      row.is_first_visit,
      row.context_product_id,
      row.context_product_name,
      row.context_product_category,
      row.context_product_brand,
      row.context_product_price,
      row.context_product_discount_price,
      row.context_product_url_path
    );
    const ph = cols.map((_, colIdx) => `$${base + colIdx + 1}`);
    return `(${ph.join(",")})`;
  });

  const sql = `
    INSERT INTO ${table} (${cols.join(",")})
    VALUES ${placeholders.join(",")}
    ON CONFLICT (event_id) DO NOTHING
  `;

  return { sql, values };
};

// [8] Ensure target table exists with expected columns
const ensureTableExists = async (pgClient, table) => {
  const createSql = `
    CREATE TABLE IF NOT EXISTS ${table} (
      event_id UUID PRIMARY KEY,
      event_timestamp TIMESTAMPTZ NOT NULL,
      event_name TEXT NOT NULL,
      user_id TEXT,
      user_login_state TEXT,
      identity_source TEXT,
      client_id TEXT,
      session_id TEXT,
      is_first_visit BOOLEAN,
      context_product_id TEXT,
      context_product_name TEXT,
      context_product_category TEXT,
      context_product_brand TEXT,
      context_product_price BIGINT,
      context_product_discount_price BIGINT,
      context_product_url_path TEXT
    )
  `;
  await pgClient.query(createSql);
};

// [9] Handler: orchestrates S3 -> transform -> PG insert, with prefix override support
export const handler = async (event = {}) => {
  const bucket = process.env.RAW_BUCKET_NAME;
  if (!bucket) {
    throw new Error("RAW_BUCKET_NAME env var is required");
  }

  const table = safeTableName(process.env.TARGET_TABLE, "clickstream_events");
  const batchSize = Number(process.env.MAX_RECORDS_PER_BATCH) || DEFAULT_BATCH_SIZE;

  const pgClient = new PgClient({
    host: process.env.DW_PG_HOST,
    port: Number(process.env.DW_PG_PORT || 5432),
    user: process.env.DW_PG_USER,
    password: process.env.DW_PG_PASSWORD,
    database: process.env.DW_PG_DATABASE,
    ssl: process.env.DW_PG_SSL === "true" ? { rejectUnauthorized: false } : undefined,
    max: 1,
  });

  const { prefix, reason } = resolvePrefix(event);
  console.log("ETL processing prefix", prefix, "reason", reason);

  const listResp = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
    })
  );

  const keys = (listResp.Contents || [])
    .map((obj) => ({
      key: obj.Key,
      lastModified: obj.LastModified,
    }))
    .filter((k) => !!k.key);
  console.log("S3 list result", {
    prefix,
    reason,
    keyCount: keys.length,
  });

  const events = [];

  // Fetch & parse each object
  for (const { key, lastModified } of keys) {
    try {
      console.log("Fetching object", key);
      const obj = await s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        })
      );
      const body = await streamToString(obj.Body);
      const parsed = JSON.parse(body);
      const evt = parseEvent(parsed, lastModified);
      if (evt) {
        events.push(evt);
      } else {
        console.warn("Skipped invalid event", key);
      }
    } catch (err) {
      console.error("Error processing object", key, err);
    }
  }

  console.log("Parsed events count", events.length);

  console.log("Connecting to PG", {
    host: process.env.DW_PG_HOST,
    port: process.env.DW_PG_PORT || 5432,
    database: process.env.DW_PG_DATABASE,
    user: process.env.DW_PG_USER ? "***" : "not set",
  });
  await pgClient.connect();
  console.log("Connected to PG");
  let inserted = 0;

  try {
    // Ensure table exists
    await ensureTableExists(pgClient, table);
    console.log("Ensured table exists", table);

    if (events.length === 0) {
      console.log("No valid events to insert");
      return { processed: keys.length, inserted: 0 };
    }

    for (let i = 0; i < events.length; i += batchSize) {
      const batch = events.slice(i, i + batchSize);
      const { sql, values } = buildInsert(batch, table);
      console.log("Inserting batch", { batchStart: i, batchSize: batch.length });
      await pgClient.query("BEGIN");
      await pgClient.query(sql, values);
      await pgClient.query("COMMIT");
      inserted += batch.length;
    }
  } catch (err) {
    await pgClient.query("ROLLBACK").catch(() => {});
    console.error("Database insert failed", err);
    throw err;
  } finally {
    await pgClient.end().catch(() => {});
  }

  console.log("ETL completed", { processed: keys.length, inserted });
  return { processed: keys.length, inserted };
};
