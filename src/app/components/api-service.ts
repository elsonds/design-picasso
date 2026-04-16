import type { StatusInfo, PodStatus, ExecutionMode } from "./types";
import { supabaseUrl, supabaseKey } from "./supabase-client";

// ─── Supabase Edge Function Base URL ────────────────────────────────────────
const SUPABASE_FUNCTIONS_BASE = `${supabaseUrl}/functions/v1/server/make-server-1a0af268`;

function supabaseHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${supabaseKey}`,
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

export async function fetchStatus(): Promise<StatusInfo> {
  try {
    const res = await fetch(`${SUPABASE_FUNCTIONS_BASE}/comfyui/status`, {
      headers: supabaseHeaders(),
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
      headers: supabaseHeaders(),
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
      headers: supabaseHeaders(),
      body: JSON.stringify({ mode }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Pod Control ────────────────────────────────────────────────────────────

export async function podStart(): Promise<{ success: boolean; message?: string }> {
  try {
    const res = await fetch(`${SUPABASE_FUNCTIONS_BASE}/comfyui/pod/start`, {
      method: "POST",
      headers: supabaseHeaders(),
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
      headers: supabaseHeaders(),
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

let currentAbortController: AbortController | null = null;
let currentJobId: string | null = null;

export async function cancelGeneration() {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
    console.log("[Picasso] Generation cancelled by user");
  }
  // Also cancel the RunPod job so it stops using GPU
  if (currentJobId) {
    const jobId = currentJobId;
    currentJobId = null;
    try {
      await fetch(`${SUPABASE_FUNCTIONS_BASE}/comfyui/cancel/${jobId}`, {
        method: "POST",
        headers: supabaseHeaders(),
      });
      console.log(`[Picasso] RunPod job ${jobId} cancel requested`);
    } catch (err) {
      console.log(`[Picasso] Failed to cancel RunPod job ${jobId}:`, err);
    }
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
}

export async function generateImage(
  req: GenerateRequest,
  callbacks?: GenerateCallbacks
): Promise<GenerateResponse> {
  const { onPhase } = callbacks || {};

  // Set up abort controller for cancellation
  currentAbortController = new AbortController();
  currentJobId = null;
  const { signal } = currentAbortController;

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
      headers: supabaseHeaders(),
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
            headers: supabaseHeaders(),
            body: JSON.stringify({
              prompt: req.prompt, width, height, seed,
              style: req.style, flow: req.flow,
              mode: hasReference ? "controlnet" : undefined,
              reference_image: hasReference ? referenceImageData : undefined,
              lora_name: loraName, lora_strength: loraStrength,
            }),
            signal,
          });

          if (retryRes.status === 503) continue; // Still starting

          if (retryRes.ok) {
            const retrySubmitData = await retryRes.json();
            const retryJobId = retrySubmitData.job_id || retrySubmitData.id;
            if (retryJobId) {
              currentJobId = retryJobId;
              console.log(`[Picasso] Job submitted after pod ready: ${retryJobId}`);
              onPhase?.("Generation queued...", 30);
              return await pollRunPodJob(retryJobId, req, seed, signal, onPhase);
            }
          }

          const errText = await retryRes.text().catch(() => "");
          throw new Error(`Generation failed after pod start: ${errText.substring(0, 200)}`);
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

    currentJobId = jobId;
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
    currentAbortController = null;
    currentJobId = null;
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

    const phase = [...phaseMessages].reverse().find((p) => attempts >= p.at);
    if (phase) onPhase?.(phase.msg, phase.pct);

    try {
      const res = await fetch(`${SUPABASE_FUNCTIONS_BASE}/comfyui/status/${jobId}`, {
        headers: supabaseHeaders(),
        signal,
      });

      if (!res.ok) continue; // Transient error, keep polling

      const data = await res.json();

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
