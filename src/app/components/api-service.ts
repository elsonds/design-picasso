import type { StatusInfo, PodStatus, ExecutionMode } from "./types";
import { supabaseUrl, supabaseKey, supabase } from "./supabase-client";

// ─── Supabase Edge Function Base URL ────────────────────────────────────────
const SUPABASE_FUNCTIONS_BASE = `${supabaseUrl}/functions/v1/server/make-server-1a0af268`;

/**
 * Build auth headers. Uses the current user's Supabase access_token so the
 * edge function can verify the JWT and attach `{id, email}` to the request.
 * Falls back to the anon key if there's no session (which will cause the
 * edge function to return 401 — deliberate).
 */
async function supabaseHeaders(): Promise<Record<string, string>> {
  let token = supabaseKey;
  try {
    const { data } = await supabase.auth.getSession();
    const accessToken = data?.session?.access_token;
    if (accessToken) token = accessToken;
  } catch {
    // fall through — use anon key, endpoint will 401
  }
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`,
  };
}

// ─── Resize reference image for ControlNet ──────────────────────────────────
// Downscale to max 1024px to keep RunPod payload reasonable.
function resizeBase64Image(
  dataUrl: string,
  maxSize: number = 1024
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width <= maxSize && height <= maxSize) {
        resolve(dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl);
        return;
      }
      const scale = maxSize / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("Canvas not supported")); return; }
      ctx.drawImage(img, 0, 0, width, height);
      const resized = canvas.toDataURL("image/png");
      resolve(resized.split(",")[1]);
    };
    img.onerror = () => reject(new Error("Failed to load reference image"));
    img.src = dataUrl;
  });
}

// ─── Status (RunPod Serverless Health) ───────────────────────────────────────

let cachedStatus: StatusInfo = {
  connected: false,
  pod_status: "unknown",
  message: "Connecting to RunPod Serverless...",
};

export function getCachedStatus(): StatusInfo {
  return { ...cachedStatus };
}

export async function fetchStatus(mode?: ExecutionMode): Promise<StatusInfo> {
  try {
    const url = mode
      ? `${SUPABASE_FUNCTIONS_BASE}/comfyui/status?mode=${mode}`
      : `${SUPABASE_FUNCTIONS_BASE}/comfyui/status`;
    const res = await fetch(url, {
      headers: await supabaseHeaders(),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      cachedStatus = {
        connected: false,
        pod_status: "unknown",
        message: `RunPod health check failed (${res.status})`,
      };
      return { ...cachedStatus };
    }

    const health = await res.json();

    cachedStatus = {
      connected: health.connected ?? true,
      pod_status: (health.pod_status as PodStatus) ?? "ready",
      message: health.message ?? "Ready",
      execution_mode: health.execution_mode ?? "serverless",
      workers: health.workers,
      jobs: health.jobs,
      pod_id: health.pod_id,
      gpu: health.gpu,
      uptime: health.uptime,
      cost_per_hr: health.cost_per_hr,
      queue_running: health.queue_running,
      queue_pending: health.queue_pending,
      avg_exec_seconds: health.avg_exec_seconds,
      eta_seconds: health.eta_seconds,
      idle_remaining_seconds: health.idle_remaining_seconds,
      idle_timeout_seconds: health.idle_timeout_seconds,
    };
    return { ...cachedStatus };
  } catch (err: unknown) {
    cachedStatus = {
      connected: false,
      pod_status: "unknown",
      message: `Error: ${(err as Error).message?.substring(0, 60) || "Unknown"}`,
    };
    return { ...cachedStatus };
  }
}

// ─── Execution Mode ─────────────────────────────────────────────────────────

export async function getExecutionMode(): Promise<ExecutionMode> {
  try {
    const res = await fetch(`${SUPABASE_FUNCTIONS_BASE}/comfyui/mode`, {
      headers: await supabaseHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return "serverless";
    const data = await res.json();
    return data.mode === "pod" ? "pod" : "serverless";
  } catch {
    return "serverless";
  }
}

export async function setExecutionMode(mode: ExecutionMode): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_FUNCTIONS_BASE}/comfyui/mode`, {
      method: "POST",
      headers: await supabaseHeaders(),
      body: JSON.stringify({ mode }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── User Activity History ──────────────────────────────────────────────────

export interface ActivityEntry {
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
  timestamp: number;
}

export async function fetchUserHistory(
  email: string,
  limit = 100
): Promise<ActivityEntry[]> {
  try {
    const res = await fetch(
      `${SUPABASE_FUNCTIONS_BASE}/user/history?email=${encodeURIComponent(email)}&limit=${limit}`,
      { headers: await supabaseHeaders(), signal: AbortSignal.timeout(15000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.entries || [];
  } catch {
    return [];
  }
}

/**
 * Global activity feed — all users, most recent first.
 * Default: last 30 minutes, capped at 20 entries.
 */
export async function fetchRecentActivity(
  limit = 20,
  sinceMs?: number
): Promise<ActivityEntry[]> {
  try {
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    if (sinceMs) params.set("since", String(sinceMs));
    const res = await fetch(
      `${SUPABASE_FUNCTIONS_BASE}/activity/recent?${params.toString()}`,
      { headers: await supabaseHeaders(), signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.entries || [];
  } catch {
    return [];
  }
}

// ─── Gallery (persistent, stored on RunPod volume) ──────────────────────────

export interface GalleryEntry {
  key: string;
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

export async function fetchGallery(
  scope: "mine" | "team",
  email?: string,
  limit = 50
): Promise<GalleryEntry[]> {
  try {
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    if (scope === "mine") {
      if (!email) return [];
      params.set("email", email);
    }
    const res = await fetch(
      `${SUPABASE_FUNCTIONS_BASE}/gallery/${scope}?${params.toString()}`,
      { headers: await supabaseHeaders(), signal: AbortSignal.timeout(15000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.entries || [];
  } catch {
    return [];
  }
}

export async function fetchGalleryImage(key: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${SUPABASE_FUNCTIONS_BASE}/gallery/image?key=${encodeURIComponent(key)}`,
      { headers: await supabaseHeaders(), signal: AbortSignal.timeout(30000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.image || null;
  } catch {
    return null;
  }
}

// ─── Pod Control ────────────────────────────────────────────────────────────

export async function podStart(email?: string): Promise<{ success: boolean; message?: string }> {
  try {
    const res = await fetch(`${SUPABASE_FUNCTIONS_BASE}/comfyui/pod/start`, {
      method: "POST",
      headers: await supabaseHeaders(),
      body: email ? JSON.stringify({ email }) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    return await res.json();
  } catch (err) {
    return { success: false, message: (err as Error).message };
  }
}

export async function podStop(): Promise<{ success: boolean; message?: string }> {
  try {
    const res = await fetch(`${SUPABASE_FUNCTIONS_BASE}/comfyui/pod/stop`, {
      method: "POST",
      headers: await supabaseHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    return await res.json();
  } catch (err) {
    return { success: false, message: (err as Error).message };
  }
}

// ─── Workflow config (stub — not needed for direct RunPod) ───────────────────

export interface WorkflowConfig {
  checkpoint: string;
  sampler: string;
  scheduler: string;
  steps: number;
  cfg: number;
}

export async function getWorkflowConfig(): Promise<WorkflowConfig> {
  return {
    checkpoint: "qwen_image_2512_bf16.safetensors",
    sampler: "euler",
    scheduler: "simple",
    steps: 30,
    cfg: 2.5,
  };
}

export async function saveWorkflowConfig(
  _config: Partial<WorkflowConfig>
): Promise<{ success: boolean }> {
  return { success: true };
}

export async function uploadWorkflow(
  _workflow: Record<string, unknown>,
  _type: "default" | "controlnet" = "default",
  _mapping?: Record<string, string>
): Promise<{ success: boolean; message?: string }> {
  return { success: true, message: "Direct RunPod mode — no workflow upload needed" };
}

export async function getWorkflowInfo(
  _type: "default" | "controlnet" = "default"
): Promise<{ has_workflow: boolean; node_count: number }> {
  return { has_workflow: true, node_count: 0 };
}

// ─── Generation Cancel Support ───────────────────────────────────────────────
// Each generation has a unique ID; we track all of them so concurrent
// requests from the same session don't clobber each other.

interface ActiveGeneration {
  controller: AbortController;
  jobId: string | null;
  // Context we remember so we can log a meaningful cancel even if the
  // server-side metadata has been cleaned up.
  email?: string;
  user_id?: string;
  prompt?: string;
  execution_mode?: ExecutionMode;
}

const activeGenerations = new Map<string, ActiveGeneration>();

function newGenerationId(): string {
  return `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function cancelGeneration(genId?: string) {
  const toCancel = genId
    ? [[genId, activeGenerations.get(genId)]].filter(([, v]) => v) as [string, ActiveGeneration][]
    : Array.from(activeGenerations.entries());

  for (const [id, gen] of toCancel) {
    gen.controller.abort();
    console.log(`[Picasso] Generation ${id} cancelled`);
    // Always POST to the cancel endpoint so the activity log is updated,
    // even if we never received a job_id yet (e.g. pod still starting).
    try {
      const cancelJobId = gen.jobId || id; // fall back to local gen id
      await fetch(`${SUPABASE_FUNCTIONS_BASE}/comfyui/cancel/${cancelJobId}`, {
        method: "POST",
        headers: await supabaseHeaders(),
        body: JSON.stringify({
          email: gen.email,
          user_id: gen.user_id,
          prompt: gen.prompt,
          execution_mode: gen.execution_mode,
        }),
      });
    } catch (err) {
      console.log(`[Picasso] Failed to cancel:`, err);
    }
    activeGenerations.delete(id);
  }
}

// ─── Image Generation ───────────────────────────────────────────────────────
// Frontend sends parameters to the Supabase Edge Function, which builds
// the ComfyUI workflow and submits it to RunPod.

export interface GenerateRequest {
  prompt: string;
  seed?: number;
  width?: number;
  height?: number;
  style?: string;
  flow?: "icon" | "banner" | "spot";
  referenceImage?: string | null;
  lora_name?: string | null;
  lora_strength?: number;
  user_id?: string;
  email?: string;
  execution_mode?: ExecutionMode;
}

export interface GenerateResponse {
  success: boolean;
  image: string;
  seed: number;
  executionTime: number;
  mode: string;
  width: number;
  height: number;
  error?: string;
}

interface GenerateCallbacks {
  onPhase?: (phase: string, progress: number) => void;
  onGenerationId?: (id: string) => void;
}

export async function generateImage(
  req: GenerateRequest,
  callbacks?: GenerateCallbacks
): Promise<GenerateResponse> {
  const { onPhase, onGenerationId } = callbacks || {};

  // Set up abort controller for cancellation (per-call, not global)
  const genId = newGenerationId();
  const controller = new AbortController();
  activeGenerations.set(genId, {
    controller,
    jobId: null,
    email: req.email,
    user_id: req.user_id,
    prompt: req.prompt,
    execution_mode: req.execution_mode,
  });
  onGenerationId?.(genId);
  const { signal } = controller;

  onPhase?.("Preparing request...", 5);

  const seed = req.seed ?? Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
  const width = Math.min(req.width ?? 1328, 2048);
  const height = Math.min(req.height ?? 1328, 2048);
  const hasReference = !!(req.referenceImage);
  const loraName = req.lora_name ?? null;
  const loraStrength = req.lora_strength ?? 1.0;

  // Prepare reference image if ControlNet mode
  let referenceImageData: string | undefined;
  if (hasReference) {
    onPhase?.("Preparing reference image...", 7);
    try {
      const b64Data = await resizeBase64Image(req.referenceImage!, 1024);
      referenceImageData = `data:image/png;base64,${b64Data}`;
      const sizeMB = (b64Data.length * 0.75 / 1024 / 1024).toFixed(1);
      console.log(`[Picasso] ControlNet mode — reference image size: ~${sizeMB}MB`);
    } catch (e) {
      console.warn("[Picasso] Image resize failed, using raw:", e);
      referenceImageData = req.referenceImage!;
    }
  }

  console.log("[Picasso] Submitting to RunPod...", {
    prompt: req.prompt.substring(0, 50),
    lora: loraName,
    style: req.style,
    flow: req.flow,
    mode: hasReference ? "ControlNet" : "Default",
  });

  onPhase?.("Sending to RunPod...", 10);

  try {
    const submitRes = await fetch(`${SUPABASE_FUNCTIONS_BASE}/comfyui/generate`, {
      method: "POST",
      headers: await supabaseHeaders(),
      body: JSON.stringify({
        prompt: req.prompt,
        width,
        height,
        seed,
        style: req.style,
        flow: req.flow,
        mode: hasReference ? "controlnet" : undefined,
        reference_image: hasReference ? referenceImageData : undefined,
        lora_name: loraName,
        lora_strength: loraStrength,
        user_id: req.user_id,
        email: req.email,
        execution_mode: req.execution_mode,
      }),
      signal,
    });

    // Handle pod mode: 503 means pod is starting — retry
    if (submitRes.status === 503) {
      const retryData = await submitRes.json().catch(() => ({}));
      if (retryData.retry) {
        console.log(`[Picasso] Pod starting — waiting for it to be ready...`);
        onPhase?.("Starting GPU pod...", 10);

        // Poll until pod is ready, then resubmit
        for (let retryAttempt = 0; retryAttempt < 60; retryAttempt++) {
          await new Promise((r) => setTimeout(r, 5000));
          if (signal.aborted) throw new Error("Generation cancelled");

          const elapsed = retryAttempt * 5;
          if (elapsed < 30) onPhase?.("Starting GPU pod...", 12);
          else if (elapsed < 60) onPhase?.("Pod booting, loading ComfyUI...", 18);
          else if (elapsed < 120) onPhase?.("Loading models...", 22);
          else onPhase?.("Almost ready...", 25);

          // Retry the generate request
          const retryRes = await fetch(`${SUPABASE_FUNCTIONS_BASE}/comfyui/generate`, {
            method: "POST",
            headers: await supabaseHeaders(),
            body: JSON.stringify({
              prompt: req.prompt, width, height, seed,
              style: req.style, flow: req.flow,
              mode: hasReference ? "controlnet" : undefined,
              reference_image: hasReference ? referenceImageData : undefined,
              lora_name: loraName, lora_strength: loraStrength,
              user_id: req.user_id, email: req.email,
              execution_mode: req.execution_mode,
            }),
            signal,
          });

          if (retryRes.status === 503) continue; // Still starting

          // Parse body ONCE — can't call .json() and .text() on the same body
          let bodyText = "";
          let bodyJson: Record<string, unknown> | null = null;
          try {
            bodyText = await retryRes.text();
            if (bodyText) bodyJson = JSON.parse(bodyText);
          } catch {
            /* body wasn't JSON */
          }

          // If the response says "retry" even without 503, keep waiting
          if (bodyJson?.retry === true) continue;

          if (retryRes.ok && bodyJson) {
            const retryJobId = (bodyJson.job_id || bodyJson.id) as string | undefined;
            if (retryJobId) {
              const gen = activeGenerations.get(genId);
              if (gen) gen.jobId = retryJobId;
              console.log(`[Picasso] Job submitted after pod ready: ${retryJobId}`);
              onPhase?.("Generation queued...", 30);
              return await pollRunPodJob(retryJobId, req, seed, signal, onPhase);
            }
          }

          // Build an informative error using the best info we have
          const serverError =
            (bodyJson?.error as string) ||
            (bodyJson?.message as string) ||
            bodyText ||
            `HTTP ${retryRes.status}`;
          throw new Error(`Pod ready but generation failed: ${serverError.substring(0, 240)}`);
        }
        throw new Error("Pod startup timed out after 5 minutes");
      }
    }

    if (!submitRes.ok) {
      const text = await submitRes.text().catch(() => "");
      throw new Error(`Submit failed (${submitRes.status}): ${text.substring(0, 200)}`);
    }

    const submitData = await submitRes.json();
    const jobId = submitData.job_id || submitData.id;
    if (!jobId) {
      throw new Error(submitData.error || `No job ID returned: ${JSON.stringify(submitData).substring(0, 200)}`);
    }

    const gen = activeGenerations.get(genId);
    if (gen) gen.jobId = jobId;
    console.log(`[Picasso] Job submitted: ${jobId}`);
    onPhase?.("Generation queued...", 15);

    // Poll for result
    return await pollRunPodJob(jobId, req, seed, signal, onPhase);
  } catch (err) {
    const isCancelled = signal.aborted || (err as Error).name === "AbortError" || (err as Error).message?.includes("cancelled");
    if (isCancelled) {
      console.log("[Picasso] Generation was cancelled");
      onPhase?.("Cancelled", 0);
      return makeError(req, "Generation cancelled");
    }
    console.error("[Picasso] Generate error:", err);
    onPhase?.("Generation failed", 0);
    return makeError(req, (err as Error).message);
  } finally {
    activeGenerations.delete(genId);
  }
}

function makeError(req: GenerateRequest, message: string): GenerateResponse {
  return {
    success: false,
    image: "",
    seed: 0,
    executionTime: 0,
    mode: "Error",
    width: req.width ?? 1328,
    height: req.height ?? 1328,
    error: message,
  };
}

// ─── Poll RunPod directly ────────────────────────────────────────────────────

async function pollRunPodJob(
  jobId: string,
  req: GenerateRequest,
  seed: number,
  signal: AbortSignal,
  onPhase?: (phase: string, progress: number) => void
): Promise<GenerateResponse> {
  const maxAttempts = 150;
  const pollInterval = 2000;
  let attempts = 0;

  const phaseMessages = [
    { at: 0, msg: "Waking up GPU...", pct: 25 },
    { at: 3, msg: "Loading models...", pct: 35 },
    { at: 8, msg: "Generating...", pct: 50 },
    { at: 15, msg: "Painting details...", pct: 65 },
    { at: 25, msg: "Adding final touches...", pct: 80 },
    { at: 40, msg: "Almost done...", pct: 88 },
    { at: 60, msg: "Still working...", pct: 92 },
  ];

  while (attempts < maxAttempts) {
    await new Promise((r) => setTimeout(r, pollInterval));
    if (signal.aborted) throw new Error("Generation cancelled");
    attempts++;

    let defaultPhase = [...phaseMessages].reverse().find((p) => attempts >= p.at);

    try {
      const res = await fetch(`${SUPABASE_FUNCTIONS_BASE}/comfyui/status/${jobId}`, {
        headers: await supabaseHeaders(),
        signal,
      });

      if (!res.ok) {
        if (defaultPhase) onPhase?.(defaultPhase.msg, defaultPhase.pct);
        continue; // Transient error, keep polling
      }

      const data = await res.json();

      // Pod mode — show queue position + ETA if we have it
      if (data.queue_position !== undefined && data.queue_position > 0) {
        const etaStr = data.eta_seconds ? ` · ~${data.eta_seconds < 60 ? data.eta_seconds + 's' : Math.ceil(data.eta_seconds / 60) + 'm'}` : '';
        onPhase?.(
          `Queued — #${data.queue_position} of ${data.queue_pending || data.queue_position}${etaStr}`,
          20
        );
      } else if (data.queue_position === 0) {
        onPhase?.("Generating...", 50);
      } else if (defaultPhase) {
        onPhase?.(defaultPhase.msg, defaultPhase.pct);
      }

      if (
        data.status === "FAILED" ||
        data.status === "CANCELLED" ||
        data.status === "TIMED_OUT"
      ) {
        const errorMsg =
          data.error || data.output?.error || `Job ${data.status.toLowerCase()}`;
        throw new Error(errorMsg);
      }

      if (data.status === "COMPLETED") {
        let imageUrl = data.image || "";
        if (!imageUrl && data.output) {
          let imageBase64 = data.output.image || "";
          if (!imageBase64 && data.output.images?.[0]?.data) {
            imageBase64 = data.output.images[0].data;
          }
          if (imageBase64) {
            imageUrl = imageBase64.startsWith("data:")
              ? imageBase64
              : `data:image/png;base64,${imageBase64}`;
          }
        }

        if (imageUrl) {
          onPhase?.("Done!", 100);
          console.log(`[Picasso] Job ${jobId} completed`);

          return {
            success: true,
            image: imageUrl,
            seed: data.seed ?? data.output?.seed ?? seed,
            executionTime: data.execution_time ?? data.output?.execution_time ?? 0,
            mode: req.referenceImage ? "ControlNet" : "Prompt",
            width: req.width ?? 1328,
            height: req.height ?? 1328,
          };
        }

        throw new Error(data.error || "Generation completed but no image returned");
      }

      // IN_QUEUE or IN_PROGRESS — keep polling
    } catch (err) {
      if (
        (err as Error).message?.includes("failed") ||
        (err as Error).message?.includes("FAILED") ||
        (err as Error).message?.includes("cancelled") ||
        (err as Error).message?.includes("TIMED_OUT") ||
        (err as Error).message?.includes("no image")
      ) {
        throw err;
      }
      // Transient error, continue polling
    }
  }

  throw new Error("Generation timed out after 5 minutes");
}

// ─── Connection Test ─────────────────────────────────────────────────────────

export async function testConnection(): Promise<{
  success: boolean;
  message: string;
  latency?: number;
}> {
  const start = performance.now();
  try {
    const status = await fetchStatus();
    const latency = Math.round(performance.now() - start);
    return {
      success: status.connected || status.pod_status !== "unknown",
      message: status.connected
        ? `Connected (${latency}ms) — ${status.message}`
        : `Cannot reach RunPod endpoint (${latency}ms)`,
      latency,
    };
  } catch {
    return {
      success: false,
      message: "Cannot reach RunPod serverless endpoint.",
    };
  }
}
