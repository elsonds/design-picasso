# 01 — Image Generation: End-to-End Flow

Everything that happens between you typing a prompt and seeing an image. Covers both execution modes.

## Trigger

User types a prompt in `PromptBar`, hits Enter or clicks the arrow on the split-send button. `handleSend` in `App.tsx` runs:

1. Pick the `flow` (icon / spot / banner) from the chip row
2. Pick the `selectedPhase` (`conceptualise` / `generate` / `null` = auto-detect)
3. If **conceptualise** → branch into LLM path ([[05-conceptualise-and-generate]])
4. Else → call `runGeneration(prompt, flow, refImage)`

## Frontend: `runGeneration`

File: `src/app/App.tsx`

1. Derive dimensions from flow (e.g. `icon` = 1:1 = 1328×1328)
2. Look up LoRA: `getLoraConfig(selectedBrand, flow)` returns `{ lora_name, strength, controlnet_strength }`. See [[06-loras-and-comfyui]].
3. Create a **pending bot message** in the chat with its own `generationId`, `phase`, `progress` — this is what the user sees animating while the generation runs.
4. (Optional) If a `restructureSkill` is defined for this brand+flow (see `prompt-skills.ts`), the raw prompt is first sent to the LLM to rewrite it into a structured prompt. This is separate from Conceptualise.
5. Call `generateImage(...)` from `api-service.ts` with:
   - `prompt`, `width`, `height`, `seed` (random if unset)
   - `style` (brand), `flow`, `lora_name`, `lora_strength`
   - `referenceImage` (base64 data URL) — triggers ControlNet mode
   - `user_id`, `email` (for activity logging + pod naming)
   - `execution_mode` (from the top-left dropdown: `serverless` | `pod`)
6. `onPhase` callback updates the pending bot message's progress live.

## api-service.ts: `generateImage`

1. Assign a local `genId`, register an `AbortController` in the `activeGenerations` Map (lets the user cancel a specific generation; we support many in flight at once).
2. If `referenceImage` present, downscale to max 1024px on a `<canvas>` to keep the payload reasonable.
3. POST to `/comfyui/generate` with the full body.
4. **Pod-startup retry loop**: if the server returns `HTTP 503` + `{retry: true}` (pod is still booting), wait 5s and retry, up to 5 minutes. Phase messages: `Starting GPU pod... → Pod booting, loading ComfyUI... → Loading models...`.
5. On success, grab `job_id` from the response.
6. Store `job_id` on the `activeGenerations` entry for this `genId` so cancel can reach the server.
7. Call `pollRunPodJob(jobId, ...)`.

## Edge function: `POST /comfyui/generate`

File: `supabase/functions/server/index.ts`

1. Parse body. Extract `prompt`, `width`, `height`, `seed`, `style`, `flow`, `reference_image`, `mode`, `lora_name`, `lora_strength`, `user_id`, `email`, `execution_mode`.
2. Resolve mode: `execution_mode` from body wins; else `KV_EXECUTION_MODE` default.
3. `hasReference = reference_image && mode === "controlnet"`.
4. Build the prompt — currently **pass-through** (`buildIndusPrompt` / `buildControlnetPrompt` are no-ops); frontend's LLM restructuring is doing the heavy lifting.
5. Resolve workflow: `getWorkflow(type, { prompt, seed, width, height, imageFilename, lora_name, lora_strength })` returns a ComfyUI workflow JSON with all node params injected. See [[10-comfyui-workflow]].
6. Override two nodes by brand+flow:
   - **Default workflow**: node `103.inputs.string_b` (style description), node `92:7.inputs.text` (negative prompt)
   - **ControlNet workflow**: node `7.inputs.text` (negative prompt)
7. Branch by `executionMode`:

### Pod mode
1. `startOrCreatePod(userLabel)` — checks if a managed pod is up, resumes or creates if needed. Returns `{ ready, podId, status }`.
2. If `!ready` → respond `HTTP 503 { retry: true, pod_status, pod_id }` — frontend's retry loop handles this.
3. If ControlNet, upload reference image to ComfyUI via pod's `/upload/image` endpoint.
4. `queuePrompt(podId, workflow)` — POST to pod's ComfyUI `/prompt`. Returns `prompt_id`.
5. Save job metadata to KV: `indus_pod_job_{promptId}` = `{ prompt, width, height, seed, style, flow, mode, pod_id, user_id, email, lora_name, submitted_at }`.
6. Log `generation.requested` to activity.
7. Return `{ success: true, job_id: promptId, execution_mode: "pod" }`.

### Serverless mode
1. Build `images` payload `{ [filename]: b64 }` if ControlNet.
2. `submitServerlessJob(workflow, images)` — POST to RunPod `/v2/{endpoint}/run`. Returns `{ id }`.
3. Save job metadata to KV: `indus_job_{id}` = same shape as pod metadata minus `pod_id`.
4. Log `generation.requested` to activity.
5. Return `{ success: true, job_id: id, execution_mode: "serverless" }`.

## Polling: `pollRunPodJob` (frontend)

File: `src/app/components/api-service.ts`

1. Every 2 seconds, GET `/comfyui/status/{jobId}`.
2. Server responds with one of:
   - `{ status: "IN_PROGRESS", queue_position, eta_seconds }` — in queue, not yet running
   - `{ status: "IN_PROGRESS", queue_position: 0 }` — actively generating
   - `{ status: "COMPLETED", image: "data:image/png;base64,...", seed, width, height, execution_time }`
   - `{ status: "FAILED", error }`
3. Update phase message:
   - Queued: `Queued — #3 of 5 · ~1m 30s`
   - Running: `Generating...`
4. On completion, return `{ success, image, seed, executionTime, mode, width, height }`.
5. Abort handler: if the user cancels, the `AbortController` is tripped, polling stops, and the cancel endpoint is called ([[07-activity-feed]]).

## Edge function: `GET /comfyui/status/:jobId`

File: `supabase/functions/server/index.ts`

1. Look up metadata. Try `indus_pod_job_{jobId}` first (pod), then `indus_job_{jobId}` (serverless).
2. **Pod branch**:
   - `pollHistory(podId, jobId)` polls ComfyUI's `/history/{jobId}`.
   - If completed, fetch image via `/view?filename=...`, return as data URL.
   - On completion: delete job KV, log `generation.completed`, call `touchActivity()` to reset idle timer, save image to gallery ([[04-gallery]]).
   - If still running, also query `getQueuePosition` for `queue_position`, `queue_running`, `queue_pending` + attach `eta_seconds`.
3. **Serverless branch**: `pollServerlessJob(jobId)` polls RunPod `/v2/{endpoint}/status/{id}`. On completion, extract base64, save gallery, log, return.

## Frontend display

When the polling returns a completed image:
1. Replace the pending bot message's `pending: false`, attach `image`, `metadata` (mode, seed, width, height, time).
2. Push an entry into `generatedImages` state → visible in the gallery Session tab.
3. Open the gallery panel automatically (`setGridPanelOpen(true)`).

## Failure / cancel paths

- **Cancel**: `cancelGeneration(genId)` in `api-service.ts` aborts the local AbortController AND POSTs `/comfyui/cancel/{jobId}` with body `{ email, user_id, prompt, execution_mode }`. Edge function:
  - Pod → call `cancelPodJob(podId, jobId)` which POSTs `{ delete: [jobId] }` to ComfyUI's `/queue` + `/interrupt` if the job is running.
  - Serverless → call `cancelServerlessJob(jobId)` which hits RunPod `/cancel/{id}`.
  - Log `generation.cancelled` with metadata (from KV first, client hint as fallback).
  - Delete job metadata and call `touchActivity()` (so idle timer resets).
- **Failure**: status poll returns `{ status: "FAILED", error }`. Pending bot message is updated with the error text; activity log gets `generation.failed`.

## Activity and logging

Every state change (`requested` / `completed` / `failed` / `cancelled`) writes a KV entry keyed `activity_{email}_{timestamp}_{jobId}`. Picked up by:
- [[07-activity-feed]] — team-wide in-flight view (bottom-left)
- [[08-activity-log-history]] — personal history panel (top-right)

## Average execution time (for ETAs)

On every `generation.completed` with an `execution_time`, the edge function updates a rolling exponential moving average in KV: `avg_exec_time_{mode}` = `{ avg, count }` (weight capped at 20 samples). Used to estimate queue ETAs.
