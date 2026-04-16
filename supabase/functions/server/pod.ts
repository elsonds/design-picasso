// ─── RunPod GPU Pod Manager ─────────────────────────────────────────────────
// Manages a persistent RunPod GPU pod running ComfyUI directly.
// Provides an alternative to the serverless approach: lower latency for
// repeated generations, but requires pod lifecycle management.
//
// Auto-detects any running ComfyUI/Indus pod on the RunPod account.
// Creates a new pod only if none exists.
// Auto-stops after 5 min idle (checked on every status poll).

import * as kv from "./kv.ts";

const GRAPHQL_URL = "https://api.runpod.io/graphql";

// ─── KV Keys ────────────────────────────────────────────────────────────────

const KV_POD_ID = "indus_pod_id";
const KV_POD_LAST_ACTIVITY = "indus_pod_last_activity";
const KV_EXECUTION_MODE = "indus_execution_mode";

// ─── Pod Configuration ──────────────────────────────────────────────────────

const POD_CONFIG = {
  name: "Indus-ComfyUI",
  image: "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04",
  dockerArgs: 'bash -c "cd /workspace && ./run_gpu.sh"',
  datacenterId: Deno.env.get("RUNPOD_POD_DATACENTER_ID") || "US-NC-2",
  volumeId: Deno.env.get("RUNPOD_POD_VOLUME_ID") || "w4cfdar27u",
  comfyuiPort: 8188,
  autoStopMinutes: 5,
  gpuFallbacks: [
    "NVIDIA RTX PRO 6000 Blackwell Server Edition",
    "NVIDIA RTX PRO 6000 Blackwell Workstation Edition",
    "NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition",
    "NVIDIA GeForce RTX 4090",
    "NVIDIA GeForce RTX 3090",
    "NVIDIA GeForce RTX 3090 Ti",
    "NVIDIA L40S",
    "NVIDIA RTX 6000 Ada Generation",
    "NVIDIA RTX A6000",
    "NVIDIA A40",
    "NVIDIA RTX A5000",
    "NVIDIA GeForce RTX 4080",
    "NVIDIA GeForce RTX 4080 SUPER",
    "NVIDIA GeForce RTX 3080 Ti",
    "NVIDIA GeForce RTX 3080",
    "NVIDIA A100 80GB PCIe",
  ],
};

// ─── Execution Mode ─────────────────────────────────────────────────────────

export type ExecutionMode = "serverless" | "pod";

export async function getExecutionMode(): Promise<ExecutionMode> {
  try {
    const mode = await kv.get(KV_EXECUTION_MODE);
    return mode === "pod" ? "pod" : "serverless";
  } catch {
    return "serverless";
  }
}

export async function setExecutionMode(mode: ExecutionMode): Promise<void> {
  await kv.set(KV_EXECUTION_MODE, mode);
  console.log(`[Picasso] Execution mode set to: ${mode}`);
}

// ─── GraphQL Helper ─────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = Deno.env.get("RUNPOD_API_KEY");
  if (!key) throw new Error("RUNPOD_API_KEY not configured");
  return key;
}

async function gql(
  query: string,
  variables?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = { query };
  if (variables) payload.variables = variables;

  try {
    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getApiKey()}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { errors: [{ message: `HTTP ${res.status}: ${text.substring(0, 200)}` }] };
    }

    const data = await res.json();
    if (data.errors) {
      console.log(`[Pod] GraphQL errors:`, JSON.stringify(data.errors).substring(0, 200));
    }
    return data;
  } catch (err) {
    console.log(`[Pod] GraphQL failed: ${(err as Error).message}`);
    return { errors: [{ message: (err as Error).message }] };
  }
}

// ─── Pod Discovery ──────────────────────────────────────────────────────────

interface PodInfo {
  id: string;
  name: string;
  desiredStatus: string;
  runtime?: { uptimeInSeconds: number };
  costPerHr?: number;
  machine?: { gpuDisplayName: string };
}

/**
 * Find any existing Indus/ComfyUI pod on the RunPod account.
 */
export async function findPod(): Promise<PodInfo | null> {
  const result = await gql(`
    query {
      myself {
        pods {
          id name desiredStatus
          costPerHr
          machine { gpuDisplayName }
          runtime { uptimeInSeconds }
        }
      }
    }
  `);

  const pods = (result.data as Record<string, unknown>)?.myself as Record<string, unknown>;
  const podList = (pods?.pods as PodInfo[]) || [];

  for (const pod of podList) {
    const name = (pod.name || "").toLowerCase();
    if (name.includes("indus") || name.includes("comfyui")) {
      console.log(`[Pod] Found: ${pod.name} (${pod.id}) — ${pod.desiredStatus}`);
      // Cache the pod ID
      await kv.set(KV_POD_ID, pod.id).catch(() => {});
      return pod;
    }
  }

  console.log(`[Pod] No existing Indus/ComfyUI pod found`);
  return null;
}

// ─── Pod Lifecycle ──────────────────────────────────────────────────────────

/**
 * Create a new pod. Tries GPU fallback chain, first in configured datacenter,
 * then any available datacenter.
 */
export async function createPod(): Promise<PodInfo | { error: string }> {
  const gpuTypes = POD_CONFIG.gpuFallbacks;

  // Pass 1: Try in configured datacenter
  for (const gpuType of gpuTypes) {
    console.log(`[Pod] Trying ${gpuType} in ${POD_CONFIG.datacenterId}...`);

    const result = await gql(
      `mutation CreatePod($input: PodFindAndDeployOnDemandInput!) {
        podFindAndDeployOnDemand(input: $input) {
          id name desiredStatus costPerHr machine { gpuDisplayName }
        }
      }`,
      {
        input: {
          name: POD_CONFIG.name,
          imageName: POD_CONFIG.image,
          dockerArgs: POD_CONFIG.dockerArgs,
          gpuTypeId: gpuType,
          networkVolumeId: POD_CONFIG.volumeId,
          dataCenterId: POD_CONFIG.datacenterId,
          gpuCount: 1,
          volumeInGb: 0,
          volumeMountPath: "/workspace",
          containerDiskInGb: 50,
          ports: `${POD_CONFIG.comfyuiPort}/http,22/tcp`,
        },
      }
    );

    const pod = (result.data as Record<string, unknown>)
      ?.podFindAndDeployOnDemand as PodInfo | undefined;

    if (pod?.id) {
      const gpu = pod.machine?.gpuDisplayName || gpuType;
      console.log(`[Pod] Created: ${pod.id} on ${gpu} ($${pod.costPerHr}/hr)`);
      await kv.set(KV_POD_ID, pod.id).catch(() => {});
      await touchActivity();
      return pod;
    }

    const errStr = JSON.stringify(result);
    if (errStr.includes("SUPPLY_CONSTRAINT") || errStr.includes("no longer any instances")) {
      continue;
    }
    const errMsg = (result.errors as Array<{ message: string }>)?.[0]?.message || "Unknown error";
    console.log(`[Pod] Create failed: ${errMsg}`);
  }

  // Pass 2: Try any datacenter (community cloud)
  console.log(`[Pod] Trying community cloud (any datacenter)...`);
  for (const gpuType of gpuTypes) {
    const result = await gql(
      `mutation CreatePod($input: PodFindAndDeployOnDemandInput!) {
        podFindAndDeployOnDemand(input: $input) {
          id name desiredStatus costPerHr machine { gpuDisplayName }
        }
      }`,
      {
        input: {
          name: POD_CONFIG.name,
          imageName: POD_CONFIG.image,
          dockerArgs: POD_CONFIG.dockerArgs,
          gpuTypeId: gpuType,
          networkVolumeId: POD_CONFIG.volumeId,
          gpuCount: 1,
          volumeInGb: 0,
          volumeMountPath: "/workspace",
          containerDiskInGb: 50,
          ports: `${POD_CONFIG.comfyuiPort}/http,22/tcp`,
        },
      }
    );

    const pod = (result.data as Record<string, unknown>)
      ?.podFindAndDeployOnDemand as PodInfo | undefined;

    if (pod?.id) {
      const gpu = pod.machine?.gpuDisplayName || gpuType;
      console.log(`[Pod] Created (community): ${pod.id} on ${gpu} ($${pod.costPerHr}/hr)`);
      await kv.set(KV_POD_ID, pod.id).catch(() => {});
      await touchActivity();
      return pod;
    }

    const errStr = JSON.stringify(result);
    if (errStr.includes("SUPPLY_CONSTRAINT") || errStr.includes("no longer any instances")) {
      continue;
    }
  }

  return { error: "No GPUs available. Please try again later." };
}

/**
 * Resume a stopped pod.
 */
export async function startPod(podId: string): Promise<PodInfo | { error: string }> {
  console.log(`[Pod] Resuming ${podId}...`);
  const result = await gql(
    `mutation PodResume($podId: String!, $gpuCount: Int!) {
      podResume(input: {podId: $podId, gpuCount: $gpuCount}) {
        id desiredStatus costPerHr
      }
    }`,
    { podId, gpuCount: 1 }
  );

  const pod = (result.data as Record<string, unknown>)?.podResume as PodInfo | undefined;
  if (pod?.id) {
    console.log(`[Pod] Resuming ($${pod.costPerHr}/hr)`);
    await touchActivity();
    return pod;
  }

  // Resume failed — pod might be terminated, create new
  const errMsg = (result.errors as Array<{ message: string }>)?.[0]?.message || "Resume failed";
  console.log(`[Pod] Resume failed (${errMsg}), creating new...`);
  await kv.del(KV_POD_ID).catch(() => {});
  return createPod();
}

/**
 * Stop the pod to save costs.
 */
export async function stopPod(podId?: string): Promise<void> {
  const id = podId || (await kv.get(KV_POD_ID));
  if (!id) return;

  console.log(`[Pod] Stopping ${id}...`);
  await gql(
    `mutation PodStop($podId: String!) {
      podStop(input: {podId: $podId}) { id desiredStatus }
    }`,
    { podId: id }
  );
  console.log(`[Pod] Stopped`);
}

/**
 * Get info on a specific pod.
 */
export async function getPodInfo(podId: string): Promise<PodInfo | null> {
  const result = await gql(
    `query Pod($podId: String!) {
      pod(input: {podId: $podId}) {
        id name desiredStatus costPerHr
        machine { gpuDisplayName }
        runtime { uptimeInSeconds }
      }
    }`,
    { podId }
  );

  return ((result.data as Record<string, unknown>)?.pod as PodInfo) || null;
}

// ─── ComfyUI Direct API ─────────────────────────────────────────────────────

function comfyUrl(podId: string, path = ""): string {
  return `https://${podId}-${POD_CONFIG.comfyuiPort}.proxy.runpod.net${path}`;
}

/**
 * Check if ComfyUI is responding on the pod.
 */
export async function probeComfyUI(podId: string): Promise<boolean> {
  try {
    const res = await fetch(comfyUrl(podId, "/system_stats"), {
      signal: AbortSignal.timeout(8000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * Upload an image to ComfyUI's input folder.
 */
export async function uploadImage(
  podId: string,
  imageBase64: string,
  filename = "input.png"
): Promise<string> {
  // Strip data URL prefix
  let raw = imageBase64;
  if (raw.includes(",")) raw = raw.split(",")[1];

  // Convert base64 to Uint8Array
  const binary = atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const formData = new FormData();
  formData.append("image", new Blob([bytes], { type: "image/png" }), filename);
  formData.append("overwrite", "true");

  const res = await fetch(comfyUrl(podId, "/upload/image"), {
    method: "POST",
    body: formData,
    signal: AbortSignal.timeout(30000),
  });

  const result = await res.json();
  console.log(`[Pod] Uploaded image: ${result.name || filename}`);
  return result.name || filename;
}

/**
 * Queue a workflow to ComfyUI and return the prompt_id.
 */
export async function queuePrompt(
  podId: string,
  workflow: Record<string, unknown>
): Promise<string> {
  const res = await fetch(comfyUrl(podId, "/prompt"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow }),
    signal: AbortSignal.timeout(30000),
  });

  const data = await res.json();
  if (data.error) throw new Error(`ComfyUI queue error: ${data.error}`);
  if (!data.prompt_id) throw new Error("No prompt_id from ComfyUI");

  console.log(`[Pod] Queued prompt: ${data.prompt_id}`);
  return data.prompt_id;
}

/**
 * Poll ComfyUI history for a completed generation.
 * Returns image as base64, or null if still in progress, or throws on error.
 */
export async function pollHistory(
  podId: string,
  promptId: string
): Promise<{
  status: "IN_PROGRESS" | "COMPLETED" | "FAILED";
  image?: string;
  error?: string;
  executionTime?: number;
}> {
  try {
    const res = await fetch(comfyUrl(podId, `/history/${promptId}`), {
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return { status: "IN_PROGRESS" };

    const history = await res.json();

    if (!(promptId in history)) return { status: "IN_PROGRESS" };

    const entry = history[promptId] as Record<string, unknown>;

    // Check for errors
    const statusObj = entry.status as Record<string, unknown> | undefined;
    if (statusObj?.status_str === "error") {
      const messages = (statusObj.messages as unknown[][]) || [];
      let errMsg = "ComfyUI execution error";
      for (const msg of messages) {
        if (Array.isArray(msg) && msg[0] === "execution_error") {
          errMsg = (msg[1] as Record<string, string>)?.exception_message || errMsg;
        }
      }
      return { status: "FAILED", error: errMsg };
    }

    // Check for outputs
    const outputs = entry.outputs as Record<string, Record<string, unknown>> | undefined;
    if (outputs) {
      // Find SaveImage output (type=output), fall back to any image
      let bestImg: { filename: string; subfolder: string; type: string } | null = null;
      for (const nodeOutput of Object.values(outputs)) {
        const images = nodeOutput.images as Array<{
          filename: string;
          subfolder?: string;
          type?: string;
        }>;
        if (images?.length) {
          const img = images[0];
          if (!bestImg || img.type === "output") {
            bestImg = {
              filename: img.filename,
              subfolder: img.subfolder || "",
              type: img.type || "output",
            };
          }
          if (img.type === "output") break;
        }
      }

      if (bestImg) {
        // Fetch the image
        const imgUrl = comfyUrl(
          podId,
          `/view?filename=${encodeURIComponent(bestImg.filename)}&subfolder=${encodeURIComponent(bestImg.subfolder)}&type=${encodeURIComponent(bestImg.type)}`
        );
        const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(60000) });
        const imgBuffer = await imgRes.arrayBuffer();
        const imgBytes = new Uint8Array(imgBuffer);

        // Convert to base64
        let b64 = "";
        const chunk = 8192;
        for (let i = 0; i < imgBytes.length; i += chunk) {
          b64 += String.fromCharCode(...imgBytes.subarray(i, i + chunk));
        }
        const imageBase64 = btoa(b64);

        return {
          status: "COMPLETED",
          image: `data:image/png;base64,${imageBase64}`,
        };
      }
    }

    return { status: "IN_PROGRESS" };
  } catch (err) {
    console.log(`[Pod] Poll error: ${(err as Error).message}`);
    return { status: "IN_PROGRESS" };
  }
}

// ─── Idle Auto-Stop ─────────────────────────────────────────────────────────

async function touchActivity(): Promise<void> {
  await kv.set(KV_POD_LAST_ACTIVITY, Date.now()).catch(() => {});
}

/**
 * Check if the pod has been idle longer than autoStopMinutes.
 * Called on every status poll from the frontend.
 */
export async function checkIdleAutoStop(): Promise<boolean> {
  try {
    const lastActivity = (await kv.get(KV_POD_LAST_ACTIVITY)) as number | null;
    if (!lastActivity) return false;

    const idleMs = Date.now() - lastActivity;
    const thresholdMs = POD_CONFIG.autoStopMinutes * 60 * 1000;

    if (idleMs > thresholdMs) {
      console.log(`[Pod] Idle for ${Math.round(idleMs / 1000)}s — auto-stopping...`);
      const podId = await kv.get(KV_POD_ID);
      if (podId) {
        await stopPod(podId);
        return true;
      }
    }
  } catch (err) {
    console.log(`[Pod] Idle check error: ${(err as Error).message}`);
  }
  return false;
}

// ─── Ensure Running Orchestration ───────────────────────────────────────────

export interface PodStatus {
  ready: boolean;
  podId: string | null;
  status: "ready" | "comfyui_loading" | "starting" | "creating" | "stopped" | "none" | "error";
  message: string;
  gpu?: string;
  uptime?: number;
  costPerHr?: number;
}

/**
 * Check the current pod state. Does NOT block waiting for ComfyUI to boot.
 * Returns the current status so the frontend can show progress.
 */
export async function ensurePodRunning(): Promise<PodStatus> {
  // Check for cached pod ID first
  let podId = await kv.get(KV_POD_ID) as string | null;

  // If we have a cached ID, check if that pod still exists
  if (podId) {
    const pod = await getPodInfo(podId);
    if (!pod) {
      // Pod terminated/gone — clear cache
      console.log(`[Pod] Cached pod ${podId} no longer exists`);
      await kv.del(KV_POD_ID).catch(() => {});
      podId = null;
    } else {
      const status = pod.desiredStatus;

      if (status === "RUNNING") {
        // Pod running — check ComfyUI
        const ready = await probeComfyUI(podId);
        if (ready) {
          await touchActivity();
          return {
            ready: true,
            podId,
            status: "ready",
            message: `GPU ready — ${pod.machine?.gpuDisplayName || "GPU"}`,
            gpu: pod.machine?.gpuDisplayName,
            uptime: pod.runtime?.uptimeInSeconds,
            costPerHr: pod.costPerHr,
          };
        }
        return {
          ready: false,
          podId,
          status: "comfyui_loading",
          message: "Pod running, ComfyUI loading...",
          gpu: pod.machine?.gpuDisplayName,
          uptime: pod.runtime?.uptimeInSeconds,
        };
      }

      if (status === "STOPPED" || status === "EXITED") {
        return {
          ready: false,
          podId,
          status: "stopped",
          message: "Pod stopped — will start on generate",
          gpu: pod.machine?.gpuDisplayName,
        };
      }

      // Other states (STARTING, etc.)
      return {
        ready: false,
        podId,
        status: "starting",
        message: `Pod ${status.toLowerCase()}...`,
      };
    }
  }

  // No cached pod — try to find one
  const found = await findPod();
  if (found) {
    podId = found.id;
    const status = found.desiredStatus;

    if (status === "RUNNING") {
      const ready = await probeComfyUI(podId);
      if (ready) {
        await touchActivity();
        return {
          ready: true,
          podId,
          status: "ready",
          message: `GPU ready — ${found.machine?.gpuDisplayName || "GPU"}`,
          gpu: found.machine?.gpuDisplayName,
          uptime: found.runtime?.uptimeInSeconds,
          costPerHr: found.costPerHr,
        };
      }
      return {
        ready: false,
        podId,
        status: "comfyui_loading",
        message: "Pod running, ComfyUI loading...",
      };
    }

    if (status === "STOPPED" || status === "EXITED") {
      return {
        ready: false,
        podId,
        status: "stopped",
        message: "Pod stopped — will start on generate",
      };
    }

    return {
      ready: false,
      podId,
      status: "starting",
      message: `Pod ${status.toLowerCase()}...`,
    };
  }

  // No pod at all
  return {
    ready: false,
    podId: null,
    status: "none",
    message: "No pod — will create on generate",
  };
}

/**
 * Start a pod (resume or create). Non-blocking — returns immediately.
 */
export async function startOrCreatePod(): Promise<PodStatus> {
  let podId = await kv.get(KV_POD_ID) as string | null;

  if (podId) {
    const pod = await getPodInfo(podId);
    if (pod) {
      if (pod.desiredStatus === "RUNNING") {
        // Already running
        const ready = await probeComfyUI(podId);
        return {
          ready,
          podId,
          status: ready ? "ready" : "comfyui_loading",
          message: ready ? "GPU ready" : "ComfyUI loading...",
        };
      }
      // Stopped — resume
      const resumed = await startPod(podId);
      if ("error" in resumed) {
        return { ready: false, podId: null, status: "error", message: resumed.error };
      }
      return {
        ready: false,
        podId: resumed.id,
        status: "starting",
        message: "Pod resuming...",
      };
    }
    // Pod gone — clear and create
    await kv.del(KV_POD_ID).catch(() => {});
  }

  // Try to find existing pod first
  const found = await findPod();
  if (found) {
    if (found.desiredStatus === "RUNNING") {
      const ready = await probeComfyUI(found.id);
      return {
        ready,
        podId: found.id,
        status: ready ? "ready" : "comfyui_loading",
        message: ready ? "GPU ready" : "ComfyUI loading...",
      };
    }
    if (found.desiredStatus === "STOPPED" || found.desiredStatus === "EXITED") {
      const resumed = await startPod(found.id);
      if ("error" in resumed) {
        return { ready: false, podId: null, status: "error", message: resumed.error };
      }
      return {
        ready: false,
        podId: resumed.id || found.id,
        status: "starting",
        message: "Pod resuming...",
      };
    }
  }

  // No pod — create new
  console.log(`[Pod] No pod found, creating...`);
  const created = await createPod();
  if ("error" in created) {
    return { ready: false, podId: null, status: "error", message: created.error };
  }
  return {
    ready: false,
    podId: created.id,
    status: "creating",
    message: `Creating pod on ${created.machine?.gpuDisplayName || "GPU"}...`,
  };
}
