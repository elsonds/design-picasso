# 03 — GPU Setup

Two execution modes, both backed by RunPod. User picks per-session via the top-left dropdown.

## Mode comparison

|  | **Serverless** | **Pod** |
|---|---|---|
| How it runs | RunPod Serverless endpoint with autoscaling workers | A single persistent GPU pod running ComfyUI |
| Startup time | ~30–60s cold start, ~5s warm | ~60–120s to create, ~0s once ready |
| Scaling | Horizontal — up to endpoint's `max_workers` | Vertical — one pod, ComfyUI queues multiple prompts |
| Cost while idle | $0 | $0 (pods are **terminated** after 4 min idle) |
| Best when | Occasional single-user use; GPU supply is plentiful | Back-to-back generations; you want ultra-low latency after the first one |
| Failure mode | "No GPU" if supply is constrained in the configured datacenter | Pod create fails if supply is constrained across the GPU fallback chain |
| Naming | One endpoint ID, always the same | Pods named after the user (`elson`, `rahul`, etc.) |

Users switch via the [[Execution Mode Dropdown]] in the top-left. The choice is sent **per request** as `execution_mode: "pod" | "serverless"` — the `indus_execution_mode` KV default is only a fallback.

## Serverless mode

### Architecture
```
Edge fn ──► RunPod Serverless API (/v2/{endpoint}/run) ──► Worker (ComfyUI + Qwen)
                     ▲                                              │
                     │                   poll /status/{id}          ▼
                     └──────────────────────────────────────── output (base64)
```

### Configuration (live at deploy time)
- Endpoint id: from `RUNPOD_ENDPOINT_ID` secret
- Configured on RunPod side: GPU types, datacenters, min/max workers, network volume attachment
- Images are returned base64 in the job result

### File
`supabase/functions/server/runpod.ts` — handles:
- `submitServerlessJob(workflow, images?)` → POST to `/run`, returns job id
- `pollServerlessJob(jobId)` → GET `/status/{id}`, returns status + output
- `cancelServerlessJob(jobId)` → POST `/cancel/{id}`
- `getEndpointHealth()` → GET `/health` — surfaces worker count + queue depth

### Health → status mapping (`/comfyui/status` in serverless branch)

| Condition | `pod_status` | Message |
|---|---|---|
| `idle > 0 \|\| running > 0` | `ready` | `Ready — N idle, M running` |
| `initializing > 0` | `starting` | `Worker initializing (N spinning up)` |
| `total === 0 && jobs.inQueue > 0` | **`degraded`** | `No GPU capacity — N jobs stuck in queue` |
| `total === 0 && failed > 5 && failed > completed` | **`degraded`** | `Recent failures (N) — GPU capacity issue likely` |
| `total === 0 && jobs.inQueue === 0` | `ready` | `Serverless idle — will cold-start on next request` |
| unreachable | `unknown` | `Cannot reach RunPod Serverless endpoint` |

The frontend shows the degraded state as `⚠ Serverless · No GPU` with a red dot — so you know before hitting Generate whether it'll fail.

## Pod mode

### Architecture
```
Edge fn ──► RunPod GraphQL (createPod, podTerminate) ──► Pod lifecycle
Edge fn ──► Pod's ComfyUI (https://{podId}-8188.proxy.runpod.net) ──► /prompt, /queue, /history, /view, /interrupt
```

### Pod lifecycle

File: `supabase/functions/server/pod.ts`

1. **First generation ever**: `ensurePodRunning()` / `startOrCreatePod(userLabel)`:
   - Check `KV_POD_ID`. If set and in managed list, reuse. Else clear.
   - `findPod()` — query RunPod for pods whose id is in the managed allow-list (`picasso_managed_pod_ids`). Prefer RUNNING.
   - If none, `createPod(userLabel)`:
     - Resolve volume id (default `w4cfdar27u` in `US-NC-2`).
     - Try a GPU fallback chain (16 types: RTX PRO 6000 → RTX 4090 → RTX 3090 → L40S → A100 → ...) in two passes:
       - Pass 1: within the configured datacenter
       - Pass 2: any datacenter (community cloud)
     - On success: set `KV_POD_ID`, add to managed list, touch activity timer, return.
2. **Pod exists + ComfyUI probe succeeds** (`probeComfyUI` hits `/system_stats`):
   - Return `{ ready: true, podId, gpu, uptime, costPerHr }`.
   - Frontend's `/comfyui/generate` immediately proceeds to `queuePrompt`.
3. **Pod exists but ComfyUI not yet ready**:
   - Return `{ ready: false, status: "comfyui_loading" }`.
   - `/comfyui/generate` returns `HTTP 503 { retry: true }` → frontend retries every 5s.
4. **Pod stopped** (if someone paused it manually via RunPod dashboard): `startPod(podId)` calls `podResume` GraphQL mutation. Normal flow never hits this post-rollout of "terminate not pause".

### Pod name

```ts
buildPodName(userLabel?) = sanitize(userLabel || POD_CONFIG.name)
// sanitize: lowercase, non-[a-z0-9-] → "-", cap 24 chars
```

So `elson@phonepe.com` → `elson`, local dev's `EL@local.dev` → `el`. Never used for security — that's the managed-pod allow-list.

### Managed pod allow-list

The `picasso_managed_pod_ids` KV array tracks every pod this app has ever created. `findPod` and `stopPod`/`checkIdleAutoStop` refuse to touch any pod NOT in this list. Means LORA-TRAINING or any other pod on the account is completely safe from automation — no matter its name.

Plus a hard block-list in `stopPod` refuses to terminate any pod whose name contains `lora-training` or `lora_training` regardless of `force`.

### Idle auto-stop

File: `pod.ts::checkIdleAutoStop`

Called fire-and-forget on **every inbound edge-function request** (middleware in `index.ts`). Algorithm:

1. Read `indus_pod_last_activity`. If not set → bail.
2. If elapsed < `autoStopMinutes * 60` (currently **4 min**) → bail.
3. Read `indus_pod_id`. Bail if missing.
4. Safety: only stop if in managed list. Otherwise clear the stale cache and bail.
5. Get pod info. If `desiredStatus !== "RUNNING"` → bail.
6. **Safety**: query ComfyUI `/queue`. If anything running or pending → refresh `indus_pod_last_activity` to now and bail. Don't kill a pod mid-generation.
7. Call `stopPod(podId)` (which is actually `podTerminate`). Clean up KV.

Fire-and-forget means we don't block the request waiting. Supabase edge functions terminate the worker when the response is sent, but the GraphQL call is short enough to complete in practice. (If this becomes unreliable later, switch to `await`.)

### When does `touchActivity()` fire?

Only on **real activity events** — not status polls:
- `createPod` success
- `startPod` (resume) success
- Generation **completed** (in `/comfyui/status/:jobId` handler)
- Generation **failed** (same)
- Generation **cancelled** (in `/comfyui/cancel/:jobId` handler)

**Not** on generate submit. This means: the 4-min countdown starts when the last generation *ends*, giving the user a full 4 minutes of quiet time after each image.

### Terminate vs pause

We call `podTerminate` (not `podStop`):
- Pros: truly $0 when idle (pauses still charge for container disk)
- Cons: +60–120s cold start on next generation vs ~10–30s resume
- All valuable state lives on the network volume, so we don't lose anything by tearing down the container

On successful terminate: `KV_POD_ID` cleared, pod ID removed from managed list.

### GPU fallback chain

In `pod.ts::POD_CONFIG.gpuFallbacks`, tried in order (cheap → premium):
```
RTX PRO 6000 Server Ed, RTX PRO 6000 Workstation, RTX PRO 6000 Max-Q,
RTX 4090, RTX 3090, RTX 3090 Ti, L40S, RTX 6000 Ada, RTX A6000,
A40, RTX A5000, RTX 4080, RTX 4080 SUPER, RTX 3080 Ti, RTX 3080, A100 80GB PCIe
```

This reduces the chance of supply-constraint failures. Each datacenter-region is tried first with each type, then falls through to community cloud (any datacenter).

### Pod config (for reference)

```ts
POD_CONFIG = {
  name: "Indus-ComfyUI",                              // base name if no user label
  image: "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04",
  dockerArgs: 'bash -c "cd /workspace && ./run_gpu.sh"',
  datacenterId: "US-NC-2",
  volumeId: "w4cfdar27u",
  comfyuiPort: 8188,
  autoStopMinutes: 4,
}
```

The `run_gpu.sh` script lives on the network volume — it's what actually starts ComfyUI inside the container.

## ComfyUI endpoints (on the pod)

Reached via `https://{podId}-8188.proxy.runpod.net/...`:

| Endpoint | Purpose |
|---|---|
| `GET /system_stats` | Health probe |
| `POST /prompt` | Queue a workflow. Body: `{ prompt: workflow }`. Returns `{ prompt_id }`. |
| `POST /upload/image` | Upload reference image for ControlNet. Multipart form. |
| `GET /queue` | Current queue state (running + pending arrays) |
| `POST /queue` | Delete a queued prompt. Body: `{ delete: ["prompt_id"] }` |
| `POST /interrupt` | Interrupt the currently-running prompt |
| `GET /history/{prompt_id}` | Job status + outputs |
| `GET /view?filename=...&subfolder=...&type=output` | Fetch generated image bytes |
