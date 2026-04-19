// Minimal AWS SigV4 S3 client for Deno, targeting RunPod's S3-compatible
// endpoint. Supports GET (object download) and GET (bucket list via query).
// No external SDK — just fetch + Web Crypto.

function env(key: string): string {
  const v = Deno.env.get(key);
  if (!v) throw new Error(`${key} not configured`);
  return v;
}

function getConfig() {
  return {
    accessKey: env("RUNPOD_S3_ACCESS_KEY"),
    secretKey: env("RUNPOD_S3_SECRET_KEY"),
    endpoint: env("RUNPOD_S3_ENDPOINT"), // e.g. https://s3api-us-nc-2.runpod.io
    bucket: env("RUNPOD_S3_BUCKET"),
    region: env("RUNPOD_S3_REGION"),
  };
}

// ─── SigV4 helpers ──────────────────────────────────────────────────────────

async function sha256Hex(msg: string | Uint8Array): Promise<string> {
  const data = typeof msg === "string" ? new TextEncoder().encode(msg) : msg;
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSha256(
  key: Uint8Array | ArrayBuffer,
  msg: string
): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(msg)
  );
}

async function signingKey(
  secret: string,
  date: string,
  region: string,
  service: string
): Promise<ArrayBuffer> {
  const kSecret = new TextEncoder().encode(`AWS4${secret}`);
  const kDate = await hmacSha256(kSecret, date);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return await hmacSha256(kService, "aws4_request");
}

function amzDate(d = new Date()): { amz: string; date: string } {
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amz: iso, date: iso.slice(0, 8) };
}

// URI-encode per AWS rules (spaces → %20, keep unreserved, encode everything else)
function uriEncode(str: string, encodeSlash = true): string {
  let out = "";
  for (const ch of str) {
    if (
      (ch >= "A" && ch <= "Z") ||
      (ch >= "a" && ch <= "z") ||
      (ch >= "0" && ch <= "9") ||
      ch === "_" || ch === "-" || ch === "~" || ch === "."
    ) {
      out += ch;
    } else if (ch === "/" && !encodeSlash) {
      out += ch;
    } else {
      for (const b of new TextEncoder().encode(ch)) {
        out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
      }
    }
  }
  return out;
}

// ─── Signed request ─────────────────────────────────────────────────────────

async function signedFetch(
  method: "GET" | "HEAD" | "PUT",
  pathname: string,
  query: Record<string, string> = {},
  body?: Uint8Array,
  contentType = "application/octet-stream"
): Promise<Response> {
  const cfg = getConfig();
  const { amz, date } = amzDate();

  const url = new URL(cfg.endpoint);
  const host = url.host;
  const canonicalPath = pathname.startsWith("/")
    ? uriEncode(pathname, false)
    : "/" + uriEncode(pathname, false);

  const qKeys = Object.keys(query).sort();
  const canonicalQuery = qKeys
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join("&");

  const payloadHash = body ? await sha256Hex(body) : await sha256Hex("");

  let canonicalHeaders =
    `host:${host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${amz}\n`;
  let signedHeaders = "host;x-amz-content-sha256;x-amz-date";

  if (method === "PUT" && body) {
    canonicalHeaders =
      `content-type:${contentType}\n` + canonicalHeaders;
    signedHeaders = "content-type;" + signedHeaders;
  }

  const canonicalRequest = [
    method,
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${date}/${cfg.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amz,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const key = await signingKey(cfg.secretKey, date, cfg.region, "s3");
  const sigBuf = await hmacSha256(key, stringToSign);
  const signature = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const fullUrl = `${cfg.endpoint}${canonicalPath}${canonicalQuery ? "?" + canonicalQuery : ""}`;

  const headers: Record<string, string> = {
    Host: host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amz,
    Authorization: authorization,
  };
  if (method === "PUT" && body) {
    headers["Content-Type"] = contentType;
    headers["Content-Length"] = String(body.length);
  }

  return await fetch(fullUrl, { method, headers, body });
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface S3Object {
  key: string;
  size: number;
  lastModified: string;
  etag: string;
}

/**
 * List objects in the bucket under an optional prefix.
 * Default: returns up to 1000 entries.
 */
export async function listObjects(
  prefix = "",
  maxKeys = 1000,
  continuationToken?: string
): Promise<{ objects: S3Object[]; nextToken?: string; isTruncated: boolean }> {
  const cfg = getConfig();
  const query: Record<string, string> = {
    "list-type": "2",
    prefix,
    "max-keys": String(maxKeys),
  };
  if (continuationToken) query["continuation-token"] = continuationToken;

  const res = await signedFetch("GET", `/${cfg.bucket}`, query);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`S3 list failed (${res.status}): ${text.substring(0, 300)}`);
  }
  const xml = await res.text();

  // Simple XML parse — S3 ListObjectsV2 response is regular
  const objects: S3Object[] = [];
  const contentsRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m: RegExpExecArray | null;
  while ((m = contentsRegex.exec(xml))) {
    const block = m[1];
    const key = /<Key>([^<]+)<\/Key>/.exec(block)?.[1] || "";
    const size = parseInt(/<Size>([^<]+)<\/Size>/.exec(block)?.[1] || "0");
    const lastModified = /<LastModified>([^<]+)<\/LastModified>/.exec(block)?.[1] || "";
    const etag = (/<ETag>([^<]+)<\/ETag>/.exec(block)?.[1] || "").replace(/"/g, "");
    objects.push({ key, size, lastModified, etag });
  }

  const isTruncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const nextToken = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/
    .exec(xml)?.[1];

  return { objects, nextToken, isTruncated };
}

/**
 * Fetch a single object's bytes.
 */
export async function getObject(key: string): Promise<Uint8Array> {
  const cfg = getConfig();
  const cleanKey = key.startsWith("/") ? key.slice(1) : key;
  const res = await signedFetch("GET", `/${cfg.bucket}/${cleanKey}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`S3 get failed (${res.status}): ${text.substring(0, 300)}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Upload bytes to the bucket at the given key.
 */
export async function putObject(
  key: string,
  bytes: Uint8Array,
  contentType = "image/png"
): Promise<void> {
  const cfg = getConfig();
  const cleanKey = key.startsWith("/") ? key.slice(1) : key;
  const res = await signedFetch(
    "PUT",
    `/${cfg.bucket}/${cleanKey}`,
    {},
    bytes,
    contentType
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`S3 put failed (${res.status}): ${text.substring(0, 300)}`);
  }
}

/**
 * Raw LIST v2 call — returns the status + body for debugging.
 */
export async function rawS3List(prefix = ""): Promise<{
  status: number;
  url: string;
  body: string;
}> {
  const cfg = getConfig();
  const query: Record<string, string> = {
    "list-type": "2",
    prefix,
    "max-keys": "20",
  };
  const res = await signedFetch("GET", `/${cfg.bucket}`, query);
  const text = await res.text();
  return {
    status: res.status,
    url: `${cfg.endpoint}/${cfg.bucket}?list-type=2&prefix=${encodeURIComponent(prefix)}`,
    body: text.substring(0, 3000),
  };
}

/**
 * Check if an object exists (HEAD request).
 */
export async function objectExists(key: string): Promise<boolean> {
  try {
    const cfg = getConfig();
    const cleanKey = key.startsWith("/") ? key.slice(1) : key;
    const res = await signedFetch("HEAD", `/${cfg.bucket}/${cleanKey}`);
    return res.ok;
  } catch {
    return false;
  }
}
