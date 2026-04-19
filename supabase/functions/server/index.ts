import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { logger } from "npm:hono/logger";
import { createClient } from "jsr:@supabase/supabase-js@2.49.8";
import * as kv from "./kv.ts";
import {
  getEndpointHealth,
  submitServerlessJob,
  pollServerlessJob,
  cancelServerlessJob,
  buildIndusPrompt,
  buildControlnetPrompt,
  getStyleDescription,
  getNegativePrompt,
  getWorkflow,
  KV_WORKFLOW_DEFAULT,
  KV_WORKFLOW_CONTROLNET,
  KV_WORKFLOW_CONFIG,
} from "./runpod.ts";
import {
  getExecutionMode,
  setExecutionMode,
  ensurePodRunning,
  startOrCreatePod,
  stopPod,
  checkIdleAutoStop,
  probeComfyUI,
  uploadImage,
  queuePrompt,
  pollHistory,
  getQueuePosition,
  cancelPodJob,
  touchActivity,
  getIdleSecondsRemaining,
  getIdleTimeoutSeconds,
  type ExecutionMode,
} from "./pod.ts";
import { putObject, getObject } from "./s3.ts";

const app = new Hono().basePath("/server/make-server-1a0af268");

app.use("*", logger(console.log));

app.use(
  "/*",
  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
  })
);

// ─── AUTH MIDDLEWARE ───────────────────────────────────────────────────────
// Every endpoint requires a valid Supabase user JWT in the Authorization
// header EXCEPT:
//   - /health (for uptime monitoring)
//   - OPTIONS preflight
// The JWT is verified via Supabase Auth. The extracted user {id, email} is
// attached to the Hono context as `c.get("user")` — handlers should read
// identity from there and ignore any user_id/email passed in the body.
//
// Additionally, we require the email to end in @phonepe.com (the same gate
// that Supabase's Google OAuth enforces at sign-in). Belt + suspenders.

const PUBLIC_PATHS = new Set(["/health"]);

interface AuthedUser {
  id: string;
  email: string;
}

function isPublicPath(path: string): boolean {
  return Array.from(PUBLIC_PATHS).some((p) => path.endsWith(p));
}

app.use("/*", async (c, next) => {
  const path = c.req.path;
  if (c.req.method === "OPTIONS" || isPublicPath(path)) {
    return await next();
  }

  const authHeader = c.req.header("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    return c.json({ error: "unauthenticated", reason: "no_token" }, 401);
  }

  try {
    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!
    );
    const { data, error } = await supa.auth.getUser(token);

    if (error || !data.user || !data.user.email) {
      return c.json({ error: "unauthenticated", reason: "invalid_token" }, 401);
    }

    // Hard email gate — Supabase OAuth already enforces this but we
    // double-check server-side in case of policy drift.
    if (!data.user.email.toLowerCase().endsWith("@phonepe.com") &&
        !data.user.email.toLowerCase().endsWith("@local.dev") /* for tests */) {
      return c.json({ error: "forbidden", reason: "email_domain" }, 403);
    }

    c.set("user", { id: data.user.id, email: data.user.email } as AuthedUser);
  } catch (err) {
    console.log(`[Auth] verify error: ${(err as Error).message}`);
    return c.json({ error: "unauthenticated", reason: "verify_failed" }, 401);
  }

  await next();
});

function getUser(c: { get: (k: string) => unknown }): AuthedUser | null {
  return (c.get("user") as AuthedUser) || null;
}

// ─── RATE LIMITING ─────────────────────────────────────────────────────────
// Per-user, per-minute counter in KV. Limits vary by endpoint category so
// expensive operations (generation, LLM) are capped tighter than cheap ones
// (status polls). Works best-effort — a KV read + write per request.

function rateLimitForPath(path: string): { bucket: string; limit: number } | null {
  if (path.endsWith("/comfyui/generate")) return { bucket: "gen", limit: 20 };
  if (path.endsWith("/llm/chat")) return { bucket: "llm", limit: 60 };
  if (path.includes("/comfyui/pod/")) return { bucket: "pod", limit: 20 };
  if (path.endsWith("/comfyui/status") || /\/comfyui\/status\/.+$/.test(path))
    return { bucket: "status", limit: 600 }; // ~10/s, generous for polling
  if (path.endsWith("/comfyui/mode")) return { bucket: "mode", limit: 30 };
  if (path.includes("/gallery/")) return { bucket: "gal", limit: 200 };
  if (path.includes("/activity/")) return { bucket: "act", limit: 100 };
  if (path.includes("/feedback")) return { bucket: "fb", limit: 100 };
  if (path.includes("/user/history")) return { bucket: "hist", limit: 60 };
  return null; // not rate-limited
}

app.use("/*", async (c, next) => {
  if (c.req.method === "OPTIONS" || isPublicPath(c.req.path)) return await next();
  const user = getUser(c);
  if (!user) return await next(); // auth middleware already handled this

  const config = rateLimitForPath(c.req.path);
  if (!config) return await next();

  const minute = Math.floor(Date.now() / 60000);
  const key = `rate_limit_${user.email}_${config.bucket}_${minute}`;
  try {
    const prev = (await kv.get(key)) as number | null;
    const count = (prev || 0) + 1;
    if (count > config.limit) {
      return c.json({
        error: "rate_limited",
        bucket: config.bucket,
        limit: config.limit,
        retry_after_seconds: 60 - (Date.now() / 1000) % 60,
      }, 429);
    }
    // Fire-and-forget write so we don't block the request
    kv.set(key, count).catch(() => { /* ignore */ });
  } catch {
    // If the KV read fails, don't block the request — fail open.
  }
  await next();
});

// Run idle auto-stop check on every incoming request — fire-and-forget so
// we never block the request (and never accidentally crash it). The check
// does its own try/catch inside, swallows errors, and either returns fast
// (one KV read if not idle) or completes the stop asynchronously.
app.use("/*", async (c, next) => {
  const path = c.req.path;
  if (c.req.method !== "OPTIONS" && !path.endsWith("/pod/stop")) {
    // Intentionally not awaited.
    checkIdleAutoStop().catch((err) => {
      console.log(`[IdleCheck] background error: ${(err as Error).message}`);
    });
  }
  await next();
});

// ─── Activity Logging ──────────────────────────────────────────────────────
// Logs every request and completion to KV. Keyed by user email + timestamp
// so we can cheaply list a user's history via prefix scan.

interface ActivityLogEntry {
  user_id?: string;
  email?: string;
  event: "generation.requested" | "generation.completed" | "generation.failed" | "generation.cancelled";
  job_id?: string;
  execution_mode?: "serverless" | "pod";
  prompt?: string;
  style?: string;
  flow?: string;
  mode?: string;
  seed?: number;
  width?: number;
  height?: number;
  lora_name?: string | null;
  execution_time?: number;
  error?: string;
  timestamp?: number;
}

async function logActivity(entry: ActivityLogEntry): Promise<void> {
  try {
    const ts = Date.now();
    const userKey = entry.email || entry.user_id || "anonymous";
    // Key: activity_{email}_{timestamp}_{jobId}
    // Prefix lookup returns user's history; global prefix returns everything
    const key = `activity_${userKey}_${ts}_${entry.job_id || "none"}`;
    await kv.set(key, { ...entry, timestamp: ts });

    // Update rolling average execution time per mode (for ETA estimates)
    if (entry.event === "generation.completed" && entry.execution_time && entry.execution_mode) {
      const avgKey = `avg_exec_time_${entry.execution_mode}`;
      try {
        const prev = await kv.get(avgKey) as { avg: number; count: number } | null;
        const newCount = (prev?.count || 0) + 1;
        // Exponential moving average with a cap on weight (so old data still matters)
        const weight = Math.min(newCount, 20);
        const newAvg = prev?.avg
          ? (prev.avg * (weight - 1) + entry.execution_time) / weight
          : entry.execution_time;
        await kv.set(avgKey, { avg: newAvg, count: newCount });
      } catch { /* ignore */ }
    }
  } catch (err) {
    console.log(`[Activity] Log failed: ${(err as Error).message}`);
  }
}

// ─── Gallery ────────────────────────────────────────────────────────────────
// Persist successful generations to the RunPod S3-mounted network volume,
// plus a mapping entry in Supabase KV for fast listing.

interface GalleryEntry {
  key: string;          // S3 object key
  prompt: string;
  email?: string;
  user_id?: string;
  style?: string;
  flow?: string;
  mode?: string;
  seed?: number;
  width?: number;
  height?: number;
  execution_time?: number;
  execution_mode?: "serverless" | "pod";
  lora_name?: string | null;
  job_id: string;
  timestamp: number;
}

/**
 * Save image bytes to the RunPod network volume (via S3 PUT) and write
 * a mapping entry in Supabase KV.
 */
async function saveToGallery(params: {
  imageDataUrl: string; // base64 data URL or raw base64
  jobId: string;
  email?: string;
  user_id?: string;
  prompt: string;
  style?: string;
  flow?: string;
  mode?: string;
  seed?: number;
  width?: number;
  height?: number;
  execution_time?: number;
  execution_mode?: "serverless" | "pod";
  lora_name?: string | null;
}): Promise<void> {
  try {
    const userPart = (params.email || "anon").split("@")[0] || "anon";
    const key = `gallery/${userPart}/${params.jobId}.png`;

    // Extract raw base64
    let b64 = params.imageDataUrl;
    if (b64.includes(",")) b64 = b64.split(",")[1];

    // base64 → Uint8Array
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    await putObject(key, bytes, "image/png");
    console.log(`[Gallery] Saved ${key} (${bytes.length} bytes)`);

    // Mapping in KV: gallery_{email}_{timestamp}_{jobId}
    const ts = Date.now();
    const entry: GalleryEntry = {
      key,
      prompt: params.prompt,
      email: params.email,
      user_id: params.user_id,
      style: params.style,
      flow: params.flow,
      mode: params.mode,
      seed: params.seed,
      width: params.width,
      height: params.height,
      execution_time: params.execution_time,
      execution_mode: params.execution_mode,
      lora_name: params.lora_name,
      job_id: params.jobId,
      timestamp: ts,
    };
    const mapKey = `gallery_${params.email || params.user_id || "anon"}_${ts}_${params.jobId}`;
    await kv.set(mapKey, entry);
  } catch (err) {
    console.log(`[Gallery] Save failed: ${(err as Error).message}`);
  }
}

async function getAvgExecTime(mode: "serverless" | "pod"): Promise<number> {
  try {
    const data = await kv.get(`avg_exec_time_${mode}`) as { avg: number } | null;
    if (data?.avg) return data.avg;
  } catch { /* ignore */ }
  // Defaults if we have no data yet
  return mode === "pod" ? 30 : 45;
}

// ─── Health check ────────────────────────────────────────────────────────────

app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

// ─── Execution Mode ─────────────────────────────────────────────────────────

app.get("/comfyui/mode", async (c) => {
  const mode = await getExecutionMode();
  return c.json({ mode });
});

app.post("/comfyui/mode", async (c) => {
  try {
    const body = await c.req.json();
    const mode = body.mode as ExecutionMode;
    if (mode !== "serverless" && mode !== "pod") {
      return c.json({ error: "mode must be 'serverless' or 'pod'" }, 400);
    }
    await setExecutionMode(mode);
    return c.json({ success: true, mode });
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ─── Pod Control ────────────────────────────────────────────────────────────

app.post("/comfyui/pod/start", async (c) => {
  try {
    const user = getUser(c);
    const userLabel = user?.email ? user.email.split("@")[0] : undefined;
    const result = await startOrCreatePod(userLabel);
    return c.json({
      success: !("error" === result.status),
      ...result,
    });
  } catch (err: unknown) {
    return c.json({ success: false, error: (err as Error).message }, 500);
  }
});

// Cancel a specific generation job (pod or serverless).
// Accepts optional email/user_id/prompt in the body so the cancel is logged
// correctly even if the job metadata was already cleaned up (e.g. the job
// completed between the user clicking Cancel and the request arriving).
app.post("/comfyui/cancel/:jobId", async (c) => {
  try {
    const jobId = c.req.param("jobId");
    let clientHint: Record<string, unknown> = {};
    try { clientHint = await c.req.json().catch(() => ({})); } catch { /* ignore */ }

    // Look up job metadata to identify mode and user
    let meta: Record<string, unknown> | null = null;
    let mode: "pod" | "serverless" | null = null;
    try {
      const p = await kv.get(`indus_pod_job_${jobId}`);
      if (p && typeof p === "object") { meta = p as Record<string, unknown>; mode = "pod"; }
    } catch { /* ignore */ }
    if (!meta) {
      try {
        const s = await kv.get(`indus_job_${jobId}`);
        if (s && typeof s === "object") { meta = s as Record<string, unknown>; mode = "serverless"; }
      } catch { /* ignore */ }
    }

    let cancelled = false;
    if (mode === "pod") {
      const podId = meta?.pod_id as string;
      if (podId) cancelled = await cancelPodJob(podId, jobId);
    } else if (mode === "serverless") {
      cancelled = await cancelServerlessJob(jobId);
    } else {
      // No metadata — try both cancel endpoints based on client hint
      const hintMode = clientHint?.execution_mode as string | undefined;
      if (hintMode === "serverless") {
        cancelled = await cancelServerlessJob(jobId);
      }
    }

    // User identity from the verified JWT — never trust the body for auth
    // purposes. Client hints are only used for non-identity fields (prompt).
    const authedUser = getUser(c);

    // Always log the cancellation. Prefer server metadata + JWT user;
    // clientHint.prompt is accepted (harmless metadata).
    await logActivity({
      user_id: authedUser?.id || (meta?.user_id as string),
      email: authedUser?.email || (meta?.email as string),
      event: "generation.cancelled",
      job_id: jobId,
      execution_mode: (mode || clientHint.execution_mode) as "pod" | "serverless" | undefined,
      prompt: (meta?.prompt as string) || (clientHint.prompt as string),
    });

    if (mode === "pod") {
      try { await kv.del(`indus_pod_job_${jobId}`); } catch { /* ignore */ }
      // Cancelled generation also ends the "active" state — reset idle timer
      await touchActivity();
    } else if (mode === "serverless") {
      try { await kv.del(`indus_job_${jobId}`); } catch { /* ignore */ }
    }

    return c.json({ success: true, cancelled, mode });
  } catch (err: unknown) {
    return c.json({ success: false, error: (err as Error).message }, 500);
  }
});

app.post("/comfyui/pod/stop", async (c) => {
  try {
    // Manual stop — force=true bypasses the "managed list" check (but the
    // protected-pattern block-list still applies; LORA-TRAINING is safe).
    const result = await stopPod(undefined, { force: true });
    if (!result.success) {
      return c.json({
        success: false,
        reason: result.reason,
        pod_id: result.podId,
        name: result.name,
        message:
          result.reason === "protected_pod"
            ? `Refused to stop protected pod '${result.name}'`
            : result.reason === "no_pod_id"
              ? "No active pod to stop"
              : `Stop failed: ${result.reason}`,
      }, 400);
    }
    return c.json({ success: true, pod_id: result.podId, name: result.name });
  } catch (err: unknown) {
    return c.json({ success: false, error: (err as Error).message }, 500);
  }
});

// ─── Endpoint Status (mode-aware) ───────────────────────────────────────────

app.get("/comfyui/status", async (c) => {
  try {
    // Allow per-request mode override via ?mode=pod|serverless
    const queryMode = c.req.query("mode");
    const mode: ExecutionMode =
      queryMode === "pod" || queryMode === "serverless"
        ? queryMode
        : await getExecutionMode();

    if (mode === "pod") {
      // Pod mode: check pod status + idle auto-stop
      await checkIdleAutoStop();
      const podStatus = await ensurePodRunning();
      const avgTime = await getAvgExecTime("pod");

      // Get current queue depth from ComfyUI
      let queueRunning = 0;
      let queuePending = 0;
      if (podStatus.podId && podStatus.ready) {
        const qpos = await getQueuePosition(podStatus.podId, "");
        queueRunning = qpos.running;
        queuePending = qpos.pending;
      }
      const totalQueue = queueRunning + queuePending;
      const etaSeconds = totalQueue > 0 ? Math.round(totalQueue * avgTime) : 0;

      // Idle auto-stop countdown (only meaningful when pod is running)
      const idleRemaining =
        podStatus.ready ? await getIdleSecondsRemaining() : null;

      return c.json({
        connected: true,
        pod_status: podStatus.status,
        message: podStatus.message,
        execution_mode: "pod",
        pod_id: podStatus.podId,
        gpu: podStatus.gpu,
        uptime: podStatus.uptime,
        cost_per_hr: podStatus.costPerHr,
        queue_running: queueRunning,
        queue_pending: queuePending,
        avg_exec_seconds: Math.round(avgTime),
        eta_seconds: etaSeconds,
        idle_remaining_seconds: idleRemaining,
        idle_timeout_seconds: getIdleTimeoutSeconds(),
      });
    }

    // Serverless mode (default)
    const health = await getEndpointHealth();

    if (!health) {
      return c.json({
        connected: false,
        pod_status: "unknown",
        message: "Cannot reach RunPod Serverless endpoint",
        execution_mode: "serverless",
      });
    }

    const { idle, running, initializing } = health.workers;
    const totalWorkers = idle + running + initializing;
    const inQueue = health.jobs?.inQueue ?? 0;
    const inProgress = health.jobs?.inProgress ?? 0;
    const recentFailed = health.jobs?.failed ?? 0;

    let podStatus: string;
    let message: string;

    // 1. Workers actively serving — healthy
    if (idle > 0 || running > 0) {
      podStatus = "ready";
      message = `Ready — ${idle} idle, ${running} running${inQueue > 0 ? `, ${inQueue} queued` : ""}`;
    }
    // 2. Workers initializing — booting up
    else if (initializing > 0) {
      podStatus = "starting";
      message = `Worker initializing (${initializing} spinning up${inQueue > 0 ? `, ${inQueue} queued` : ""})`;
    }
    // 3. Jobs waiting with no workers → likely GPU shortage
    else if (totalWorkers === 0 && inQueue > 0) {
      podStatus = "degraded";
      message = `No GPU capacity — ${inQueue} job${inQueue === 1 ? "" : "s"} stuck in queue`;
    }
    // 4. No workers, no queue, but recent failures → degraded
    else if (totalWorkers === 0 && recentFailed > 5 && recentFailed > (health.jobs?.completed ?? 0)) {
      podStatus = "degraded";
      message = `Recent failures (${recentFailed}) — GPU capacity issue likely`;
    }
    // 5. No workers, no queue — true idle standby
    else if (totalWorkers === 0) {
      podStatus = "ready";
      message = "Serverless idle — will cold-start on next request";
    }
    // Fallback
    else {
      podStatus = "ready";
      message = "Serverless endpoint available";
    }

    const avgTime = await getAvgExecTime("serverless");
    const totalLoad = inQueue + inProgress;
    // ETA = jobs ahead × avg per-job time, divided by active workers (if any)
    const effectiveWorkers = Math.max(1, idle + running);
    const etaSeconds = totalLoad > 0 ? Math.round((totalLoad * avgTime) / effectiveWorkers) : 0;

    return c.json({
      connected: true,
      pod_status: podStatus,
      message,
      execution_mode: "serverless",
      workers: health.workers,
      jobs: health.jobs,
      avg_exec_seconds: Math.round(avgTime),
      eta_seconds: etaSeconds,
    });
  } catch (err: unknown) {
    console.log("Status check error:", (err as Error).message);
    return c.json({
      connected: false,
      pod_status: "unknown",
      message: `Error: ${(err as Error).message?.substring(0, 100)}`,
      execution_mode: "serverless",
    });
  }
});

// ─── Workflow Config (preserved from old architecture) ───────────────────────

app.get("/comfyui/config", async (c) => {
  try {
    const config = await kv.get(KV_WORKFLOW_CONFIG);
    return c.json({
      success: true,
      config: config || {
        checkpoint: "qwen_image_2512_bf16.safetensors",
        sampler: "euler",
        scheduler: "simple",
        steps: 30,
        cfg: 2.5,
      },
    });
  } catch {
    return c.json({
      success: true,
      config: {
        checkpoint: "qwen_image_2512_bf16.safetensors",
        sampler: "euler",
        scheduler: "simple",
        steps: 30,
        cfg: 2.5,
      },
    });
  }
});

app.post("/comfyui/config", async (c) => {
  try {
    const body = await c.req.json();
    await kv.set(KV_WORKFLOW_CONFIG, body);
    return c.json({ success: true, message: "Config saved" });
  } catch (err: unknown) {
    return c.json({ success: false, message: (err as Error).message });
  }
});

// ─── Upload custom workflow JSON (preserved) ─────────────────────────────────

app.post("/comfyui/workflow/upload", async (c) => {
  try {
    const body = await c.req.json();
    const { workflow, type = "default", mapping } = body;

    if (!workflow || typeof workflow !== "object") {
      return c.json({ success: false, error: "workflow JSON object required" }, 400);
    }

    const kvKey =
      type === "controlnet" ? KV_WORKFLOW_CONTROLNET : KV_WORKFLOW_DEFAULT;

    await kv.set(kvKey, { workflow, mapping: mapping || null });
    console.log(
      `[Indus] Uploaded ${type} workflow (${Object.keys(workflow).length} nodes)`
    );

    return c.json({
      success: true,
      message: `${type} workflow saved (${Object.keys(workflow).length} nodes)`,
    });
  } catch (err: unknown) {
    return c.json({ success: false, error: (err as Error).message });
  }
});

app.get("/comfyui/workflow", async (c) => {
  try {
    const type = c.req.query("type") || "default";
    const kvKey =
      type === "controlnet" ? KV_WORKFLOW_CONTROLNET : KV_WORKFLOW_DEFAULT;
    const data = await kv.get(kvKey);
    return c.json({
      success: true,
      type,
      has_workflow: !!data,
      node_count: data?.workflow ? Object.keys(data.workflow).length : 0,
    });
  } catch {
    return c.json({ success: true, has_workflow: false });
  }
});

// ─── Generate Image (mode-aware: serverless or pod) ─────────────────────────

app.post("/comfyui/generate", async (c) => {
  try {
    const body = await c.req.json();
    const {
      prompt,
      width = 1328,
      height = 1328,
      seed,
      style,
      flow = "icon",   // "icon" | "banner" | "spot"
      reference_image, // base64 data URL or raw base64
      mode,
      lora_name,       // LoRA safetensors filename (null = no LoRA)
      lora_strength,   // LoRA strength (default 1.0)
      execution_mode,  // Explicit per-request mode override
    } = body;

    if (!prompt) {
      return c.json({ success: false, error: "prompt is required" }, 400);
    }

    // User identity comes from the verified JWT (auth middleware), NOT the body.
    const authedUser = getUser(c);
    const user_id = authedUser?.id;
    const email = authedUser?.email;

    // Prefer per-request mode; fall back to KV-stored default
    const executionMode: ExecutionMode =
      execution_mode === "pod" || execution_mode === "serverless"
        ? execution_mode
        : await getExecutionMode();
    const hasReference = !!(reference_image && mode === "controlnet");
    const brand = style || "Indus";

    // NOTE: we do NOT log the request here — the frontend may call this
    // endpoint multiple times during pod startup (503-retry loop). Logging
    // here would produce duplicate "started" entries. Instead we log once
    // the job is actually accepted (after queuePrompt / submitServerlessJob).

    console.log(`\n${"=".repeat(50)}`);
    console.log(`[Picasso] New generation: '${prompt}' [${executionMode}] by ${email || "anon"}`);
    console.log(
      `[Picasso] Brand: ${brand}, Flow: ${flow}, ${width}x${height}, ControlNet: ${hasReference}, LoRA: ${lora_name || "none"}`
    );

    // Build prompt (pass-through)
    const fullPrompt = hasReference
      ? buildControlnetPrompt(prompt, brand)
      : buildIndusPrompt(prompt, brand);

    const actualSeed =
      seed ?? Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);

    // Build workflow (shared by both modes)
    const workflowType = hasReference ? "controlnet" : "default";
    const imageFilename = hasReference ? `ref_${Date.now()}.png` : undefined;

    const workflow = await getWorkflow(workflowType, {
      prompt: fullPrompt,
      seed: actualSeed,
      width: Math.min(width, 2048),
      height: Math.min(height, 2048),
      imageFilename,
      lora_name: lora_name !== undefined ? lora_name : undefined,
      lora_strength: lora_strength !== undefined ? lora_strength : undefined,
    });

    // Override style description and negative prompt per brand+flow
    const styleDesc = getStyleDescription(brand, flow);
    const negPrompt = getNegativePrompt(flow);

    if (workflowType === "default") {
      if ((workflow as Record<string, any>)["103"]) {
        (workflow as Record<string, any>)["103"].inputs.string_b = styleDesc;
      }
      if ((workflow as Record<string, any>)["92:7"]) {
        (workflow as Record<string, any>)["92:7"].inputs.text = negPrompt;
      }
    } else {
      if ((workflow as Record<string, any>)["7"]) {
        (workflow as Record<string, any>)["7"].inputs.text = negPrompt;
      }
    }

    // Debug logging
    const loraDebugNode = workflowType === "controlnet" ? "5" : "92:73";
    const loraNodeState = (workflow as Record<string, any>)[loraDebugNode];
    console.log(`[Picasso] LoRA "${loraDebugNode}":`, loraNodeState ? JSON.stringify((loraNodeState as any).inputs) : "REMOVED");

    // ── POD MODE ──
    if (executionMode === "pod") {
      // Auto-start pod if needed (use email prefix as pod name suffix)
      const userLabel = email ? (email as string).split("@")[0] : undefined;
      const podStatus = await startOrCreatePod(userLabel);
      if (!podStatus.podId) {
        return c.json({
          success: false,
          error: podStatus.message || "Failed to start pod",
          pod_status: podStatus.status,
        }, 503);
      }

      if (!podStatus.ready) {
        // Pod starting — tell frontend to retry
        return c.json({
          success: false,
          error: "Pod starting, please wait...",
          pod_status: podStatus.status,
          pod_id: podStatus.podId,
          retry: true,
        }, 503);
      }

      // Pod is ready — upload reference image if ControlNet
      let podImageFilename = imageFilename;
      if (hasReference && reference_image && podStatus.podId) {
        podImageFilename = await uploadImage(podStatus.podId, reference_image);
        // Update workflow with actual filename from ComfyUI
        if ((workflow as Record<string, any>)["28"]) {
          (workflow as Record<string, any>)["28"].inputs.image = podImageFilename;
        }
      }

      // Queue workflow to ComfyUI
      const promptId = await queuePrompt(podStatus.podId, workflow);

      // NOTE: the idle timer is reset when a generation FINISHES
      // (completed/failed/cancelled), not when it's submitted. This way
      // the 4-minute countdown starts from the end of the last generation.

      // Log once — after the job is accepted (avoids duplicate entries from
      // pod-startup retries)
      await logActivity({
        user_id, email,
        event: "generation.requested",
        job_id: promptId,
        execution_mode: "pod",
        prompt,
        style: brand,
        flow,
        mode: hasReference ? "ControlNet" : "Prompt",
        width, height,
        lora_name: lora_name ?? null,
      });

      // Store job metadata
      await kv.set(`indus_pod_job_${promptId}`, {
        prompt: fullPrompt,
        width,
        height,
        seed: actualSeed,
        style: style || "Indus",
        flow,
        mode: hasReference ? "ControlNet" : "Prompt",
        pod_id: podStatus.podId,
        user_id,
        email,
        lora_name: lora_name ?? null,
        submitted_at: Date.now(),
      });

      return c.json({
        success: true,
        job_id: promptId,
        request_id: promptId,
        seed: actualSeed,
        execution_mode: "pod",
        message: "Generation submitted to pod",
      });
    }

    // ── SERVERLESS MODE (default) ──
    let images: Record<string, string> | undefined;
    if (hasReference && imageFilename) {
      let b64Data = reference_image;
      if (b64Data.includes(",")) b64Data = b64Data.split(",")[1];
      images = { [imageFilename]: b64Data };
    }

    const job = await submitServerlessJob(workflow, images);

    await kv.set(`indus_job_${job.id}`, {
      prompt: fullPrompt,
      width,
      height,
      seed: actualSeed,
      style: style || "Indus",
      flow,
      mode: hasReference ? "ControlNet" : "Prompt",
      user_id,
      email,
      lora_name: lora_name ?? null,
      submitted_at: Date.now(),
    });

    // Log once — after the job is accepted by RunPod
    await logActivity({
      user_id, email,
      event: "generation.requested",
      job_id: job.id,
      execution_mode: "serverless",
      prompt,
      style: brand,
      flow,
      mode: hasReference ? "ControlNet" : "Prompt",
      width, height,
      lora_name: lora_name ?? null,
    });

    return c.json({
      success: true,
      job_id: job.id,
      request_id: job.id,
      seed: actualSeed,
      execution_mode: "serverless",
      message: "Generation submitted to serverless endpoint",
    });
  } catch (err: unknown) {
    console.log("Generate error:", (err as Error).message);
    return c.json({
      success: false,
      error: `Generation failed: ${(err as Error).message}`,
    });
  }
});

// ─── Check generation job status (mode-aware) ──────────────────────────────

app.get("/comfyui/status/:jobId", async (c) => {
  try {
    const jobId = c.req.param("jobId");

    // Check if this is a pod job first
    let podJobMeta: Record<string, unknown> | null = null;
    try {
      const saved = await kv.get(`indus_pod_job_${jobId}`);
      if (saved && typeof saved === "object") podJobMeta = saved as Record<string, unknown>;
    } catch { /* ignore */ }

    // ── POD JOB ──
    if (podJobMeta) {
      const podId = podJobMeta.pod_id as string;
      if (!podId) {
        return c.json({ status: "FAILED", error: "Pod ID missing from job metadata" });
      }

      const result = await pollHistory(podId, jobId);

      if (result.status === "COMPLETED" && result.image) {
        const elapsed = podJobMeta.submitted_at
          ? Math.round((Date.now() - (podJobMeta.submitted_at as number)) / 1000)
          : 0;

        console.log(`[Pod] Job ${jobId} completed in ${elapsed}s`);
        try { await kv.del(`indus_pod_job_${jobId}`); } catch { /* ignore */ }
        // Reset idle timer — 4-min countdown starts from NOW (generation done)
        await touchActivity();

        await logActivity({
          user_id: podJobMeta.user_id as string,
          email: podJobMeta.email as string,
          event: "generation.completed",
          job_id: jobId,
          execution_mode: "pod",
          prompt: podJobMeta.prompt as string,
          style: (podJobMeta.style as string) || "Indus",
          flow: podJobMeta.flow as string,
          mode: (podJobMeta.mode as string) || "Prompt",
          seed: (podJobMeta.seed as number) ?? 0,
          width: (podJobMeta.width as number) ?? 1328,
          height: (podJobMeta.height as number) ?? 1328,
          lora_name: podJobMeta.lora_name as string | null,
          execution_time: elapsed,
        });

        // Save to RunPod volume + gallery KV mapping
        await saveToGallery({
          imageDataUrl: result.image,
          jobId,
          email: podJobMeta.email as string | undefined,
          user_id: podJobMeta.user_id as string | undefined,
          prompt: podJobMeta.prompt as string,
          style: (podJobMeta.style as string) || "Indus",
          flow: podJobMeta.flow as string | undefined,
          mode: (podJobMeta.mode as string) || "Prompt",
          seed: (podJobMeta.seed as number) ?? 0,
          width: (podJobMeta.width as number) ?? 1328,
          height: (podJobMeta.height as number) ?? 1328,
          execution_time: elapsed,
          execution_mode: "pod",
          lora_name: podJobMeta.lora_name as string | null,
        });

        return c.json({
          status: "COMPLETED",
          completed: true,
          success: true,
          image: result.image,
          seed: (podJobMeta.seed as number) ?? 0,
          width: (podJobMeta.width as number) ?? 1328,
          height: (podJobMeta.height as number) ?? 1328,
          mode: (podJobMeta.mode as string) || "Prompt",
          style: (podJobMeta.style as string) || "Indus",
          execution_time: elapsed,
        });
      }

      if (result.status === "FAILED") {
        try { await kv.del(`indus_pod_job_${jobId}`); } catch { /* ignore */ }
        // Reset idle timer — failure also ends the "active" state
        await touchActivity();
        await logActivity({
          user_id: podJobMeta.user_id as string,
          email: podJobMeta.email as string,
          event: "generation.failed",
          job_id: jobId,
          execution_mode: "pod",
          error: result.error || "Generation failed",
          prompt: podJobMeta.prompt as string,
        });
        return c.json({ status: "FAILED", error: result.error || "Generation failed" });
      }

      // Still in progress — include queue position + ETA
      const qpos = await getQueuePosition(podId, jobId);
      const avgTime = await getAvgExecTime("pod");
      const aheadOfYou = Math.max(0, qpos.position);
      const etaSeconds = Math.round((aheadOfYou + 1) * avgTime);
      return c.json({
        status: "IN_PROGRESS",
        completed: false,
        queue_position: qpos.position,
        queue_running: qpos.running,
        queue_pending: qpos.pending,
        eta_seconds: etaSeconds,
        avg_exec_seconds: Math.round(avgTime),
      });
    }

    // ── SERVERLESS JOB (default) ──
    let jobMeta: Record<string, unknown> = {};
    try {
      const saved = await kv.get(`indus_job_${jobId}`);
      if (saved && typeof saved === "object")
        jobMeta = saved as Record<string, unknown>;
    } catch { /* ignore */ }

    // Poll RunPod Serverless status
    const result = await pollServerlessJob(jobId);

    // ── COMPLETED ──
    if (result.status === "COMPLETED" && result.output) {
      const elapsed = jobMeta.submitted_at
        ? Math.round((Date.now() - (jobMeta.submitted_at as number)) / 1000)
        : 0;

      // Extract image from serverless output
      // The handler may return: { image: "base64..." } or { images: [{ data: "base64..." }] }
      let imageBase64 = result.output.image || "";
      if (!imageBase64 && result.output.images?.[0]?.data) {
        imageBase64 = result.output.images[0].data;
      }

      if (imageBase64) {
        console.log(
          `[Indus] Job ${jobId} completed in ${elapsed}s`
        );

        // Clean up job metadata
        try { await kv.del(`indus_job_${jobId}`); } catch { /* ignore */ }

        await logActivity({
          user_id: jobMeta.user_id as string,
          email: jobMeta.email as string,
          event: "generation.completed",
          job_id: jobId,
          execution_mode: "serverless",
          prompt: jobMeta.prompt as string,
          style: (jobMeta.style as string) || "Indus",
          flow: jobMeta.flow as string,
          mode: (jobMeta.mode as string) || "Prompt",
          seed: (jobMeta.seed as number) ?? result.output.seed ?? 0,
          width: (jobMeta.width as number) ?? 1328,
          height: (jobMeta.height as number) ?? 1328,
          lora_name: jobMeta.lora_name as string | null,
          execution_time: result.output.execution_time ?? elapsed,
        });

        // Save to RunPod volume + gallery KV mapping
        await saveToGallery({
          imageDataUrl: imageBase64,
          jobId,
          email: jobMeta.email as string | undefined,
          user_id: jobMeta.user_id as string | undefined,
          prompt: jobMeta.prompt as string,
          style: (jobMeta.style as string) || "Indus",
          flow: jobMeta.flow as string | undefined,
          mode: (jobMeta.mode as string) || "Prompt",
          seed: (jobMeta.seed as number) ?? result.output.seed ?? 0,
          width: (jobMeta.width as number) ?? 1328,
          height: (jobMeta.height as number) ?? 1328,
          execution_time: result.output.execution_time ?? elapsed,
          execution_mode: "serverless",
          lora_name: jobMeta.lora_name as string | null,
        });

        // Ensure the image has a data URL prefix
        const imageUrl = imageBase64.startsWith("data:")
          ? imageBase64
          : `data:image/png;base64,${imageBase64}`;

        return c.json({
          status: "COMPLETED",
          completed: true,
          success: true,
          image: imageUrl,
          data: [{ b64_json: imageBase64.startsWith("data:") ? imageBase64.split(",")[1] : imageBase64 }],
          seed: (jobMeta.seed as number) ?? result.output.seed ?? 0,
          width: (jobMeta.width as number) ?? 1328,
          height: (jobMeta.height as number) ?? 1328,
          mode: (jobMeta.mode as string) || "Prompt",
          style: (jobMeta.style as string) || "Indus",
          execution_time: result.output.execution_time ?? elapsed,
        });
      }

      // Completed but no image found — treat as error
      console.log(`[Picasso] Job ${jobId} completed but no image in output:`, JSON.stringify(result.output).substring(0, 200));
      try { await kv.del(`indus_job_${jobId}`); } catch { /* ignore */ }
      return c.json({
        status: "FAILED",
        error: "Generation completed but no image was returned",
      });
    }

    // ── FAILED / CANCELLED / TIMED_OUT ──
    if (result.status === "FAILED" || result.status === "CANCELLED" || result.status === "TIMED_OUT") {
      try { await kv.del(`indus_job_${jobId}`); } catch { /* ignore */ }
      const errorMsg = result.error || result.output?.error || `Job ${result.status.toLowerCase()}`;
      console.log(`[Picasso] Job ${jobId} ${result.status}: ${errorMsg}`);
      await logActivity({
        user_id: jobMeta.user_id as string,
        email: jobMeta.email as string,
        event: "generation.failed",
        job_id: jobId,
        execution_mode: "serverless",
        error: errorMsg,
        prompt: jobMeta.prompt as string,
      });
      return c.json({
        status: "FAILED",
        error: errorMsg,
      });
    }

    // ── IN_QUEUE / IN_PROGRESS ──
    return c.json({
      status: result.status,
      completed: false,
    });
  } catch (err: unknown) {
    console.log("Job status check error:", (err as Error).message);
    return c.json({
      status: "IN_PROGRESS",
      completed: false,
    });
  }
});

// ─── User Activity History ──────────────────────────────────────────────────

app.get("/user/history", async (c) => {
  try {
    // Always use the JWT-verified email — ignore any email query param.
    // Prevents one user from reading another user's history.
    const user = getUser(c);
    if (!user?.email) {
      return c.json({ success: false, error: "unauthenticated" }, 401);
    }
    const limit = parseInt(c.req.query("limit") || "100");

    const prefix = `activity_${user.email}_`;
    const entries = await kv.getByPrefix(prefix);

    // Sort by timestamp descending (most recent first)
    const sorted = entries
      .filter((e): e is ActivityLogEntry => !!e && typeof e === "object" && "timestamp" in e)
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, limit);

    return c.json({ success: true, entries: sorted, count: sorted.length });
  } catch (err: unknown) {
    return c.json({ success: false, error: (err as Error).message }, 500);
  }
});

// ─── Feedback (thumbs up / down per image) ──────────────────────────────────
// One vote per user per image. KV keys:
//   feedback_vote_{jobId}_{email}   -> { vote: "up"|"down", ts }  (single user)
//   feedback_count_{jobId}          -> { up, down }                (aggregate)

interface FeedbackEntry {
  job_id: string;
  vote: "up" | "down" | null;
  email?: string;
  user_id?: string;
  timestamp: number;
}

app.post("/feedback", async (c) => {
  try {
    const body = await c.req.json();
    const { job_id, vote } = body as {
      job_id?: string;
      vote?: "up" | "down" | null;
    };
    if (!job_id) return c.json({ success: false, error: "job_id required" }, 400);
    if (vote !== "up" && vote !== "down" && vote !== null) {
      return c.json({ success: false, error: "vote must be up | down | null" }, 400);
    }
    // Identity from JWT — prevents vote stuffing as another user
    const authedUser = getUser(c);
    if (!authedUser) return c.json({ success: false, error: "unauthenticated" }, 401);
    const email = authedUser.email;
    const user_id = authedUser.id;
    const userKey = email;
    const voteKey = `feedback_vote_${job_id}_${userKey}`;
    const countKey = `feedback_count_${job_id}`;

    // Read prior vote (if any) to compute delta
    let prior: FeedbackEntry | null = null;
    try {
      const existing = await kv.get(voteKey);
      if (existing && typeof existing === "object") prior = existing as FeedbackEntry;
    } catch { /* ignore */ }

    // Update aggregate counts
    let counts: { up: number; down: number } = { up: 0, down: 0 };
    try {
      const c2 = await kv.get(countKey);
      if (c2 && typeof c2 === "object") counts = c2 as { up: number; down: number };
    } catch { /* ignore */ }

    // Remove the prior vote from counts
    if (prior?.vote === "up") counts.up = Math.max(0, counts.up - 1);
    if (prior?.vote === "down") counts.down = Math.max(0, counts.down - 1);

    // Apply new vote
    if (vote === "up") counts.up += 1;
    if (vote === "down") counts.down += 1;

    await kv.set(countKey, counts);

    // Save or clear the user's vote
    if (vote === null) {
      try { await kv.del(voteKey); } catch { /* ignore */ }
    } else {
      const entry: FeedbackEntry = {
        job_id,
        vote,
        email,
        user_id,
        timestamp: Date.now(),
      };
      await kv.set(voteKey, entry);
    }

    return c.json({ success: true, counts, vote });
  } catch (err: unknown) {
    return c.json({ success: false, error: (err as Error).message }, 500);
  }
});

// Get aggregated counts + the current user's vote
app.get("/feedback", async (c) => {
  try {
    const jobId = c.req.query("job_id");
    const email = getUser(c)?.email; // always JWT-derived
    if (!jobId) return c.json({ success: false, error: "job_id required" }, 400);

    let counts: { up: number; down: number } = { up: 0, down: 0 };
    try {
      const c2 = await kv.get(`feedback_count_${jobId}`);
      if (c2 && typeof c2 === "object") counts = c2 as { up: number; down: number };
    } catch { /* ignore */ }

    let myVote: "up" | "down" | null = null;
    if (email) {
      try {
        const v = await kv.get(`feedback_vote_${jobId}_${email}`);
        if (v && typeof v === "object") myVote = (v as FeedbackEntry).vote;
      } catch { /* ignore */ }
    }

    return c.json({ success: true, counts, my_vote: myVote });
  } catch (err: unknown) {
    return c.json({ success: false, error: (err as Error).message }, 500);
  }
});

// Batch fetch feedback for multiple job IDs (used by the gallery)
app.post("/feedback/batch", async (c) => {
  try {
    const body = await c.req.json();
    const { job_ids } = body as { job_ids?: string[] };
    if (!Array.isArray(job_ids)) return c.json({ success: false, error: "job_ids array required" }, 400);
    const email = getUser(c)?.email; // JWT-derived

    const result: Record<string, { counts: { up: number; down: number }; my_vote: "up" | "down" | null }> = {};

    await Promise.all(
      job_ids.map(async (jobId) => {
        let counts: { up: number; down: number } = { up: 0, down: 0 };
        let myVote: "up" | "down" | null = null;
        try {
          const c2 = await kv.get(`feedback_count_${jobId}`);
          if (c2 && typeof c2 === "object") counts = c2 as { up: number; down: number };
        } catch { /* ignore */ }
        if (email) {
          try {
            const v = await kv.get(`feedback_vote_${jobId}_${email}`);
            if (v && typeof v === "object") myVote = (v as FeedbackEntry).vote;
          } catch { /* ignore */ }
        }
        result[jobId] = { counts, my_vote: myVote };
      })
    );

    return c.json({ success: true, feedback: result });
  } catch (err: unknown) {
    return c.json({ success: false, error: (err as Error).message }, 500);
  }
});

// ─── Gallery ────────────────────────────────────────────────────────────────

app.get("/gallery/mine", async (c) => {
  try {
    // Always use the JWT-verified email — prevents enumerating other users.
    const user = getUser(c);
    if (!user?.email) {
      return c.json({ success: false, error: "unauthenticated" }, 401);
    }
    const limit = parseInt(c.req.query("limit") || "50");

    const prefix = `gallery_${user.email}_`;
    const entries = await kv.getByPrefix(prefix);
    const sorted = (entries as GalleryEntry[])
      .filter((e) => e && typeof e === "object" && "timestamp" in e)
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, limit);

    return c.json({ success: true, entries: sorted, count: sorted.length });
  } catch (err: unknown) {
    return c.json({ success: false, error: (err as Error).message }, 500);
  }
});

app.get("/gallery/team", async (c) => {
  try {
    const limit = parseInt(c.req.query("limit") || "50");

    const entries = await kv.getByPrefix("gallery_");
    const sorted = (entries as GalleryEntry[])
      .filter((e) => e && typeof e === "object" && "timestamp" in e)
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, limit);

    return c.json({ success: true, entries: sorted, count: sorted.length });
  } catch (err: unknown) {
    return c.json({ success: false, error: (err as Error).message }, 500);
  }
});

// Proxy fetch of a single image by S3 key. Returns base64 data URL to simplify
// the frontend (no CORS or auth juggling).
app.get("/gallery/image", async (c) => {
  try {
    const key = c.req.query("key");
    if (!key) return c.json({ success: false, error: "key required" }, 400);
    if (!key.startsWith("gallery/")) {
      return c.json({ success: false, error: "invalid key prefix" }, 400);
    }

    const bytes = await getObject(key);
    // base64 encode in chunks to avoid call stack issues
    let b64 = "";
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
      b64 += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const dataUrl = `data:image/png;base64,${btoa(b64)}`;
    return c.json({ success: true, image: dataUrl });
  } catch (err: unknown) {
    return c.json({ success: false, error: (err as Error).message }, 500);
  }
});

// ─── Global Activity Feed ────────────────────────────────────────────────────
// Returns the most-recent activity across ALL users. Used by the live
// bottom-left feed that shows requests + status as they happen.

app.get("/activity/recent", async (c) => {
  try {
    const limit = parseInt(c.req.query("limit") || "20");
    const sinceMs = parseInt(c.req.query("since") || "0");

    const entries = await kv.getByPrefix("activity_");
    const now = Date.now();

    const filtered = entries
      .filter((e): e is ActivityLogEntry => !!e && typeof e === "object" && "timestamp" in e)
      .filter((e) => {
        const ts = e.timestamp || 0;
        if (sinceMs > 0) return ts > sinceMs;
        // Default: last 30 minutes
        return now - ts < 30 * 60 * 1000;
      })
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, limit);

    return c.json({ success: true, entries: filtered, count: filtered.length });
  } catch (err: unknown) {
    return c.json({ success: false, error: (err as Error).message }, 500);
  }
});

// Debug endpoints removed. They were one-time diagnostic tools added during
// development and could be used to enumerate pods, read S3 layout, or even
// terminate pods. They were previously only guarded by the public anon key
// (which is committed to the repo). They are now gone. If you need to debug
// again, re-add with an admin-only email gate AND rate limiting.

// ─── LLM Proxy (OpenAI + Gemini) ────────────────────────────────────────────
// Proxies LLM requests so API keys stay server-side.
// Frontend sends messages + config, Edge Function adds the API key and forwards.

app.post("/llm/chat", async (c) => {
  try {
    const body = await c.req.json();
    const { messages, provider = "openai", model, temperature = 0.8, maxTokens = 2000, stream = true } = body;

    if (!messages || !Array.isArray(messages)) {
      return c.json({ error: "messages array is required" }, 400);
    }

    if (provider === "gemini") {
      // ── Gemini ──
      // Accept either GEMINI_API_KEY or any of a handful of friendly names
      const apiKey =
        Deno.env.get("GEMINI_API_KEY") ||
        Deno.env.get("Gemini") ||
        Deno.env.get("gemini");
      if (!apiKey)
        return c.json({ error: "GEMINI_API_KEY not configured" }, 500);

      const geminiModel = model || "gemini-2.0-flash";

      // Convert messages to Gemini format
      let systemInstruction: string | null = null;
      const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
      for (const msg of messages) {
        if (msg.role === "system") {
          systemInstruction = (systemInstruction ? systemInstruction + "\n\n" : "") + msg.content;
        } else {
          contents.push({
            role: msg.role === "assistant" ? "model" : "user",
            parts: [{ text: msg.content }],
          });
        }
      }

      const geminiBody: Record<string, unknown> = {
        contents,
        generationConfig: { temperature, maxOutputTokens: maxTokens },
      };
      if (systemInstruction) {
        geminiBody.systemInstruction = { parts: [{ text: systemInstruction }] };
      }

      const endpoint = stream ? "streamGenerateContent?alt=sse" : "generateContent";
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:${endpoint}&key=${apiKey}`;

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geminiBody),
      });

      if (!res.ok) {
        const text = await res.text();
        return c.json({ error: `Gemini API error (${res.status}): ${text.substring(0, 200)}` }, res.status);
      }

      // Stream passthrough
      return new Response(res.body, {
        status: res.status,
        headers: {
          "Content-Type": res.headers.get("Content-Type") || "text/event-stream",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } else {
      // ── OpenAI ──
      // Accept OPENAI_API_KEY or the "Picasso" alias the user set in Supabase
      const apiKey =
        Deno.env.get("OPENAI_API_KEY") ||
        Deno.env.get("Picasso") ||
        Deno.env.get("picasso");
      if (!apiKey)
        return c.json({ error: "OPENAI_API_KEY not configured" }, 500);

      const openaiModel = model || "gpt-4o-mini";
      const url = "https://api.openai.com/v1/chat/completions";

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: openaiModel,
          messages,
          temperature,
          max_tokens: maxTokens,
          stream,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        return c.json({ error: `OpenAI API error (${res.status}): ${text.substring(0, 200)}` }, res.status);
      }

      // Stream passthrough
      return new Response(res.body, {
        status: res.status,
        headers: {
          "Content-Type": res.headers.get("Content-Type") || "text/event-stream",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
  } catch (err: unknown) {
    console.log("LLM proxy error:", (err as Error).message);
    return c.json({ error: `LLM proxy error: ${(err as Error).message}` }, 500);
  }
});

Deno.serve(app.fetch);