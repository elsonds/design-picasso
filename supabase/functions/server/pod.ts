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
// List of pod IDs this app has created. The only pods we will ever
// manage/stop. Protects unrelated pods (e.g. LORA-TRAINING) even if someone
// manually names something similarly.
const KV_MANAGED_POD_IDS = "picasso_managed_pod_ids";

// ─── Pod Configuration ──────────────────────────────────────────────────────

const POD_CONFIG = {
  name: "Indus-ComfyUI",
  image: "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04",
  dockerArgs: 'bash -c "cd /workspace && ./run_gpu.sh"',
  datacenterId: Deno.env.get("RUNPOD_POD_DATACENTER_ID") || "US-NC-2",
  volumeId: Deno.env.get("RUNPOD_POD_VOLUME_ID") || "w4cfdar27u",
  comfyuiPort: 8188,
  autoStopMinutes: 4,
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
  const managed = await getManagedPodIds();
  if (managed.length === 0) {
    console.log(`[Pod] No managed pods in list`);
    return null;
  }

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

  // Prune managed IDs that no longer exist on the account
  const existingIds = new Set(podList.map((p) => p.id));
  for (const id of managed) {
    if (!existingIds.has(id)) await removeManagedPodId(id);
  }

  // Prefer a RUNNING managed pod; otherwise any managed pod
  let running: PodInfo | null = null;
  let anyManaged: PodInfo | null = null;
  for (const pod of podList) {
    if (!managed.includes(pod.id)) continue;
    if (!anyManaged) anyManaged = pod;
    if (pod.desiredStatus === "RUNNING") {
      running = pod;
      break;
    }
  }

  const chosen = running || anyManaged;
  if (chosen) {
    console.log(`[Pod] Found managed: ${chosen.name} (${chosen.id}) — ${chosen.desiredStatus}`);
    await kv.set(KV_POD_ID, chosen.id).catch(() => {});
    return chosen;
  }

  console.log(`[Pod] No managed pods currently exist on the account`);
  return null;
}

// ─── Pod Lifecycle ──────────────────────────────────────────────────────────

/**
 * Sanitize a user label for inclusion in a RunPod pod name.
 * Keeps alphanumerics and dashes; lowercases; caps at 24 chars.
 */
function sanitizeUserLabel(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
}

/**
 * Build pod name. Just the user label, or POD_CONFIG.name as fallback.
 */
function buildPodName(userLabel?: string): string {
  if (!userLabel) return POD_CONFIG.name;
  const clean = sanitizeUserLabel(userLabel);
  return clean || POD_CONFIG.name;
}

// ─── Managed Pod Tracking ───────────────────────────────────────────────────
// We only manage (stop, auto-stop, resume) pods we've created ourselves.
// This protects any unrelated pod on the account (e.g. LORA-TRAINING) no
// matter what its name is.

async function getManagedPodIds(): Promise<string[]> {
  try {
    const list = await kv.get(KV_MANAGED_POD_IDS) as string[] | null;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function addManagedPodId(podId: string): Promise<void> {
  const list = await getManagedPodIds();
  if (!list.includes(podId)) {
    list.push(podId);
    await kv.set(KV_MANAGED_POD_IDS, list).catch(() => {});
  }
}

async function removeManagedPodId(podId: string): Promise<void> {
  const list = await getManagedPodIds();
  const filtered = list.filter((id) => id !== podId);
  if (filtered.length !== list.length) {
    await kv.set(KV_MANAGED_POD_IDS, filtered).catch(() => {});
  }
}

async function isManagedPod(podId: string): Promise<boolean> {
  const list = await getManagedPodIds();
  return list.includes(podId);
}

/**
 * Create a new pod. Tries GPU fallback chain, first in configured datacenter,
 * then any available datacenter.
 */
export async function createPod(userLabel?: string): Promise<PodInfo | { error: string }> {
  const gpuTypes = POD_CONFIG.gpuFallbacks;
  const podName = buildPodName(userLabel);

  // Pass 1: Try in configured datacenter
  for (const gpuType of gpuTypes) {
    console.log(`[Pod] Trying ${gpuType} in ${POD_CONFIG.datacenterId} (name: ${podName})...`);

    const result = await gql(
      `mutation CreatePod($input: PodFindAndDeployOnDemandInput!) {
        podFindAndDeployOnDemand(input: $input) {
          id name desiredStatus costPerHr machine { gpuDisplayName }
        }
      }`,
      {
        input: {
          name: podName,
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
      await addManagedPodId(pod.id);
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
  console.log(`[Pod] Trying community cloud (any datacenter, name: ${podName})...`);
  for (const gpuType of gpuTypes) {
    const result = await gql(
      `mutation CreatePod($input: PodFindAndDeployOnDemandInput!) {
        podFindAndDeployOnDemand(input: $input) {
          id name desiredStatus costPerHr machine { gpuDisplayName }
        }
      }`,
      {
        input: {
          name: podName,
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
      await addManagedPodId(pod.id);
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
export async function startPod(podId: string, userLabel?: string): Promise<PodInfo | { error: string }> {
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
  return createPod(userLabel);
}

/**
 * Stop the pod to save costs.
 */
export interface StopPodResult {
  success: boolean;
  reason?: string;
  podId?: string;
  name?: string;
}

export async function stopPod(
  podId?: string,
  opts?: { force?: boolean }
): Promise<StopPodResult> {
  const id = (podId || (await kv.get(KV_POD_ID))) as string | null;
  if (!id) return { success: false, reason: "no_pod_id" };

  const pod = await getPodInfo(id);
  const name = (pod?.name || "").toLowerCase();

  // Absolute block-list — these patterns are never touched by this app,
  // regardless of managed list or user request.
  const PROTECTED_PATTERNS = ["lora-training", "lora_training"];
  const isProtected = PROTECTED_PATTERNS.some((p) => name.includes(p));
  if (isProtected) {
    console.log(`[Pod] REFUSING to stop protected pod '${pod?.name}' (${id})`);
    return { success: false, reason: "protected_pod", podId: id, name: pod?.name };
  }

  // For non-forced stops (e.g. idle auto-stop), require the pod to be in
  // our managed list. For explicit user-requested stops, fall back to the
  // cached pod_id (which was set by findPod or createPod — both return only
  // our own pods).
  if (!opts?.force && !(await isManagedPod(id))) {
    console.log(`[Pod] REFUSING to auto-stop pod ${id} — not in managed list.`);
    return { success: false, reason: "not_managed", podId: id, name: pod?.name };
  }

  console.log(`[Pod] Terminating ${id} ('${pod?.name || "?"}')...`);
  // Terminate (not stop/pause). Termination:
  //  - releases GPU AND container disk immediately — truly $0 when idle
  //  - destroys the pod; next generation creates a fresh one
  //  - network volume (ComfyUI + models + LoRAs) is untouched since it's a
  //    separate resource remounted on the next pod
  const res = await gql(
    `mutation PodTerminate($podId: String!) {
      podTerminate(input: {podId: $podId})
    }`,
    { podId: id }
  );

  // podTerminate returns a scalar (null on success, errors array on failure)
  const errMsg = (res.errors as Array<{ message: string }>)?.[0]?.message;
  if (errMsg) {
    console.log(`[Pod] Terminate failed: ${errMsg}`);
    return { success: false, reason: errMsg, podId: id, name: pod?.name };
  }

  // Clean up local tracking so a new pod is created next time
  if (id === (await kv.get(KV_POD_ID))) {
    await kv.del(KV_POD_ID).catch(() => {});
  }
  await removeManagedPodId(id);

  console.log(`[Pod] Terminated ${id}`);
  return { success: true, podId: id, name: pod?.name };
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
 * Cancel a specific queued / running prompt on the pod.
 * Sends DELETE /queue with the prompt_id. Also calls /interrupt to stop
 * the currently-executing prompt if it matches.
 */
export async function cancelPodJob(
  podId: string,
  promptId: string
): Promise<boolean> {
  try {
    // Check if this prompt is currently running
    const qpos = await getQueuePosition(podId, promptId);
    const isRunning = qpos.position === 0;

    // Remove from pending queue (safe to call even if running — just returns ok)
    await fetch(comfyUrl(podId, "/queue"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete: [promptId] }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});

    // If running, also interrupt
    if (isRunning) {
      await fetch(comfyUrl(podId, "/interrupt"), {
        method: "POST",
        signal: AbortSignal.timeout(10000),
      }).catch(() => {});
    }

    console.log(`[Pod] Cancelled prompt ${promptId} (was running: ${isRunning})`);
    return true;
  } catch (err) {
    console.log(`[Pod] Cancel error: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Query ComfyUI's queue to find where our prompt sits.
 * Returns queuePosition (0 = running, 1 = next, etc.) or -1 if not found.
 */
export async function getQueuePosition(
  podId: string,
  promptId: string
): Promise<{ position: number; running: number; pending: number }> {
  try {
    const res = await fetch(comfyUrl(podId, "/queue"), {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { position: -1, running: 0, pending: 0 };

    const data = await res.json();
    const running = (data.queue_running as unknown[]) || [];
    const pending = (data.queue_pending as unknown[]) || [];

    // If promptId is empty, caller just wants total queue depth
    if (!promptId) {
      return { position: -1, running: running.length, pending: pending.length };
    }

    // queue_running/pending entries are: [priority, prompt_id, workflow, extra_data, outputs_to_execute]
    for (const entry of running) {
      if (Array.isArray(entry) && entry[1] === promptId) {
        return { position: 0, running: running.length, pending: pending.length };
      }
    }
    for (let i = 0; i < pending.length; i++) {
      const entry = pending[i];
      if (Array.isArray(entry) && entry[1] === promptId) {
        return { position: i + 1, running: running.length, pending: pending.length };
      }
    }
    // Not in queue — either completed or unknown
    return { position: -1, running: running.length, pending: pending.length };
  } catch {
    return { position: -1, running: 0, pending: 0 };
  }
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

/**
 * Reset the idle timer. Call ONLY when a real generation happens — not on
 * status polls, otherwise the pod will never stop while the UI is open.
 */
export async function touchActivity(): Promise<void> {
  await kv.set(KV_POD_LAST_ACTIVITY, Date.now()).catch(() => {});
}

/**
 * Seconds remaining until the idle auto-stop will fire.
 * Returns null if no activity has been recorded, or 0 if already past threshold.
 */
export async function getIdleSecondsRemaining(): Promise<number | null> {
  try {
    const lastActivity = (await kv.get(KV_POD_LAST_ACTIVITY)) as number | null;
    if (!lastActivity) return null;
    const thresholdMs = POD_CONFIG.autoStopMinutes * 60 * 1000;
    const elapsed = Date.now() - lastActivity;
    const remainingMs = thresholdMs - elapsed;
    return Math.max(0, Math.round(remainingMs / 1000));
  } catch {
    return null;
  }
}

/**
 * Total idle timeout in seconds (e.g. 300 for 5 min).
 */
export function getIdleTimeoutSeconds(): number {
  return POD_CONFIG.autoStopMinutes * 60;
}

/**
 * Check if the pod has been idle longer than autoStopMinutes.
 * Called on every incoming request to the edge function.
 *
 * Safety: verifies the pod's name contains "indus" or "comfyui" before
 * stopping, so we NEVER accidentally stop pods like LORA-TRAINING.
 */
export async function checkIdleAutoStop(): Promise<boolean> {
  try {
    const lastActivity = (await kv.get(KV_POD_LAST_ACTIVITY)) as number | null;
    if (!lastActivity) return false;

    const idleMs = Date.now() - lastActivity;
    const thresholdMs = POD_CONFIG.autoStopMinutes * 60 * 1000;

    if (idleMs <= thresholdMs) return false;

    const podId = await kv.get(KV_POD_ID) as string | null;
    if (!podId) return false;

    // Safety: only manage pods we created ourselves.
    if (!(await isManagedPod(podId))) {
      console.log(`[Pod] REFUSING to auto-stop pod ${podId} — not in managed list. Clearing cache.`);
      await kv.del(KV_POD_ID).catch(() => {});
      return false;
    }

    const pod = await getPodInfo(podId);
    if (!pod) {
      // Pod no longer exists — prune from both caches
      await kv.del(KV_POD_ID).catch(() => {});
      await removeManagedPodId(podId);
      return false;
    }

    // Already stopped — no action needed
    if (pod.desiredStatus !== "RUNNING") return false;

    // Safety: don't terminate mid-generation. If ComfyUI has anything in its
    // queue (running or pending), refresh the activity timer and skip this
    // idle check — the completion handler will reset the timer properly.
    const qpos = await getQueuePosition(podId, "");
    if (qpos.running > 0 || qpos.pending > 0) {
      console.log(
        `[Pod] Would auto-stop but pod has ${qpos.running} running + ${qpos.pending} pending jobs — deferring`
      );
      await kv.set(KV_POD_LAST_ACTIVITY, Date.now()).catch(() => {});
      return false;
    }

    console.log(`[Pod] Idle for ${Math.round(idleMs / 1000)}s — stopping '${pod.name}' (${podId})...`);
    await stopPod(podId);
    return true;
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

  // Only trust the cache if the pod is in our managed list. Otherwise it's
  // a stale pointer to an unrelated pod (e.g. legacy "Indus-ComfyUI") and we
  // should ignore it and fall through to findPod()/create.
  if (podId && !(await isManagedPod(podId))) {
    console.log(`[Pod] Cached pod ${podId} not in managed list — ignoring`);
    await kv.del(KV_POD_ID).catch(() => {});
    podId = null;
  }

  // If we have a cached ID, check if that pod still exists
  if (podId) {
    const pod = await getPodInfo(podId);
    if (!pod) {
      // Pod terminated/gone — clear cache
      console.log(`[Pod] Cached pod ${podId} no longer exists`);
      await kv.del(KV_POD_ID).catch(() => {});
      await removeManagedPodId(podId);
      podId = null;
    } else {
      const status = pod.desiredStatus;

      if (status === "RUNNING") {
        // Pod running — check ComfyUI (read-only; don't touch activity timer)
        const ready = await probeComfyUI(podId);
        if (ready) {
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
        // Read-only discovery — don't touch activity timer
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
 * userLabel (optional) is appended to the pod name when creating a new pod.
 */
export async function startOrCreatePod(userLabel?: string): Promise<PodStatus> {
  let podId = await kv.get(KV_POD_ID) as string | null;

  if (podId) {
    // Only reuse pods this app has created. Stale cache (e.g. pointing at a
    // legacy "Indus-ComfyUI" pod not in the managed list) is ignored so we
    // fall through to creating a new one with the correct username.
    if (!(await isManagedPod(podId))) {
      console.log(`[Pod] Cached pod ${podId} not in managed list — ignoring, will create new`);
      await kv.del(KV_POD_ID).catch(() => {});
      podId = null;
    } else {
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
        const resumed = await startPod(podId, userLabel);
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
      // Pod gone — clear and fall through to create
      await kv.del(KV_POD_ID).catch(() => {});
      await removeManagedPodId(podId);
      podId = null;
    }
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
      const resumed = await startPod(found.id, userLabel);
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
  const created = await createPod(userLabel);
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
