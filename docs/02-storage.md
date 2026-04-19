# 02 — Storage

Everything that persists, where it lives, and why. Nothing is stored in the browser beyond a React state map.

## Three tiers

```
┌───────────────────────────┐
│ 1. Supabase KV            │  metadata, jobs, activity, settings, rolling stats
│ (Postgres key-value table)│
└───────────────────────────┘
┌───────────────────────────┐
│ 2. RunPod Network Volume  │  image bytes (gallery), ComfyUI install, model weights, LoRAs
│ (S3-compatible)           │
└───────────────────────────┘
┌───────────────────────────┐
│ 3. Browser state (React)  │  current chat messages, in-flight generations, gallery thumbs cache
│ (ephemeral, per tab)      │
└───────────────────────────┘
```

## 1. Supabase KV (`kv_store_1a0af268`)

A single Postgres table with columns `key TEXT PRIMARY KEY, value JSONB`. Wrapped by `supabase/functions/server/kv.ts`:

```ts
get(key), set(key, value), del(key), mget(keys), mset(keys, values),
mdel(keys), getByPrefix(prefix)
```

`getByPrefix` uses `LIKE 'prefix%'` — reasonable for low hundreds of rows, will slow under load.

### KV keys in use

| Key | Type | Written by | Read by | Cleared by | Purpose |
|---|---|---|---|---|---|
| `indus_execution_mode` | `"serverless" \| "pod"` | `/comfyui/mode` POST | `/comfyui/status`, `/comfyui/generate` fallback | manual reset | Default mode when request omits `execution_mode` |
| `indus_pod_id` | `string` | `findPod`, `createPod` | `ensurePodRunning`, `checkIdleAutoStop`, `stopPod` | `checkIdleAutoStop`, `stopPod` (on terminate) | Currently-active managed pod id |
| `indus_pod_last_activity` | `number` (ms) | `touchActivity()` (after complete / fail / cancel / createPod / startPod) | `checkIdleAutoStop`, `getIdleSecondsRemaining` | — | Timestamp of the last real activity; drives the 4-min idle auto-stop |
| `picasso_managed_pod_ids` | `string[]` | `addManagedPodId` (createPod success) | `isManagedPod`, `findPod`, `checkIdleAutoStop` | `removeManagedPodId` (pod gone, terminated) | Safety allow-list — we only touch pods we created, never LORA-TRAINING etc. |
| `indus_job_{id}` | `JobMeta` | serverless generate | status poller, cancel | on complete / fail / cancel | Serverless job metadata |
| `indus_pod_job_{id}` | `JobMeta` | pod generate | status poller, cancel | on complete / fail / cancel | Pod job metadata (includes `pod_id`) |
| `activity_{email}_{ts}_{jobId}` | `ActivityLogEntry` | `logActivity()` | `/user/history`, `/activity/recent` | — (no cleanup yet) | Activity log entries |
| `gallery_{email}_{ts}_{jobId}` | `GalleryEntry` | `saveToGallery()` (after successful completion) | `/gallery/mine`, `/gallery/team` | — | Gallery mapping (links prompt + metadata to S3 key) |
| `avg_exec_time_serverless` | `{ avg, count }` | logActivity on complete | `getAvgExecTime`, status endpoint | — | Rolling average for ETA math |
| `avg_exec_time_pod` | `{ avg, count }` | same | same | — | Same, for pod mode |
| `feedback_vote_{jobId}_{email}` | `FeedbackEntry` | `/feedback` POST | `/feedback` GET, `/feedback/batch` | `/feedback` POST with vote=null | Per-user thumbs up/down (one vote per image per user) |
| `feedback_count_{jobId}` | `{ up, down }` | `/feedback` POST | `/feedback` GET, `/feedback/batch` | — | Aggregate counts per image |
| `indus_workflow_default` | ComfyUI JSON | `/comfyui/workflow/upload` (unused) | `getWorkflow()` KV-override path | — | Hot-swap default workflow without redeploy |
| `indus_workflow_controlnet` | ComfyUI JSON | same | same | — | Hot-swap controlnet workflow |
| `indus_workflow_config` | `{ checkpoint, sampler, scheduler, steps, cfg }` | `/comfyui/config` POST | `/comfyui/config` GET | — | Diff/display only |

### Shape reference

```ts
// Job metadata (both indus_job_ and indus_pod_job_)
interface JobMeta {
  prompt: string;
  width: number;
  height: number;
  seed: number;
  style: string;          // brand
  flow: string;           // icon | banner | spot
  mode: "Prompt" | "ControlNet";
  pod_id?: string;        // pod mode only
  user_id?: string;
  email?: string;
  lora_name: string | null;
  submitted_at: number;   // ms
}

// Activity log entry
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
  timestamp: number;
}

// Gallery entry
interface GalleryEntry {
  key: string;          // S3 object key, e.g. "gallery/elson/abc123.png"
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
```

## 2. RunPod network volume

- Volume ID: `w4cfdar27u` (in datacenter `US-NC-2`)
- Mounted at `/workspace` on every pod
- Persistent across pod lifetimes — models, LoRAs, ComfyUI install all live here
- Exposed via S3-compatible API at `https://s3api-us-nc-2.runpod.io`

### Structure

```
w4cfdar27u (bucket)
├── ComfyUI/
│   ├── models/
│   │   ├── unet/
│   │   │   └── qwen_image_2512_bf16.safetensors       ← base model
│   │   ├── clip/
│   │   │   └── qwen_2.5_vl_7b_fp8_scaled.safetensors  ← text encoder
│   │   ├── vae/
│   │   │   └── qwen_image_vae.safetensors              ← VAE
│   │   └── loras/
│   │       ├── indus-style.safetensors
│   │       ├── indus-banner-style.safetensors
│   │       └── ppe_style.safetensors
│   ├── (ComfyUI install + custom nodes)
│   └── output/                                         ← ComfyUI default save path (per-pod ephemeral, not used for gallery)
├── gallery/                                            ← the app's persistent gallery (S3-written)
│   └── {email-prefix}/
│       └── {jobId}.png
├── .cache/                                             ← pip / Python caches (not managed by app)
└── .indus-cache/                                       ← legacy cache
```

### Gallery write path

After a successful generation, the edge function:
1. Decodes the base64 image it received from ComfyUI
2. PUTs to `gallery/{email-prefix}/{jobId}.png` via SigV4-signed S3 request
3. Writes a `gallery_{email}_{ts}_{jobId}` KV entry pointing at that key

On gallery read:
1. `/gallery/mine` or `/gallery/team` does a KV prefix scan, returns entries
2. Frontend lazy-loads the actual image bytes via `/gallery/image?key=...` which proxies through the edge function (so no S3 credentials in the browser)

See [[04-gallery]].

### S3 client

File: `supabase/functions/server/s3.ts`

Zero-dependency SigV4 implementation for Deno. Supports `listObjects`, `getObject`, `putObject`, `objectExists`. Also `rawS3List` for debugging the weird pagination of RunPod's S3 API (which returns partial keys without honouring prefix match in the way AWS S3 does).

Secrets required (all read from `Deno.env.get(...)`):
- `RUNPOD_S3_ACCESS_KEY` (starts with `user_...`)
- `RUNPOD_S3_SECRET_KEY` (starts with `rps_...`)
- `RUNPOD_S3_ENDPOINT` e.g. `https://s3api-us-nc-2.runpod.io`
- `RUNPOD_S3_BUCKET` (the volume id, e.g. `w4cfdar27u`)
- `RUNPOD_S3_REGION` e.g. `us-nc-2`

## 3. Browser state

Ephemeral, lost on refresh.

- `messages: ChatMessage[]` — in-session chat + pending bot messages
- `generatedImages: GeneratedImage[]` — Session tab of the gallery (pre-hydration)
- `thumbs: Record<string, string>` — lazy-loaded data URLs keyed by S3 key (inside `ImageGridPanel`)
- `activeGenerations: Map<genId, {controller, jobId, email, ...}>` — tracks in-flight requests for cancellation
- `localStorage`:
  - `picasso_activity_feed_hidden` — bottom-left feed collapsed?
  - (implicitly) Supabase's auth session tokens

## Secrets (Supabase Functions → Secrets)

| Secret | Used by | Notes |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` | `kv.ts` | Standard Supabase |
| `RUNPOD_API_KEY` | `pod.ts` (GraphQL), `runpod.ts` (serverless REST) | `rpa_...` |
| `RUNPOD_ENDPOINT_ID` | `runpod.ts` | Serverless endpoint id |
| `RUNPOD_S3_ACCESS_KEY`, `RUNPOD_S3_SECRET_KEY`, `RUNPOD_S3_ENDPOINT`, `RUNPOD_S3_BUCKET`, `RUNPOD_S3_REGION` | `s3.ts` | For gallery read/write |
| `RUNPOD_POD_VOLUME_ID`, `RUNPOD_POD_DATACENTER_ID` | `pod.ts` | Optional — default to `w4cfdar27u`, `US-NC-2` |
| `OPENAI_API_KEY` (or `Picasso` alias) | `/llm/chat` | For Conceptualise / prompt restructuring |
| `GEMINI_API_KEY` (or `Gemini` alias) | `/llm/chat` | Alternative LLM |

## Data lifecycle / cleanup

- Job KV entries are deleted on terminal status (completed / failed / cancelled).
- Activity log KV entries grow unbounded — no TTL. Reasonable for MVP; cleanup is a future task.
- Gallery KV + S3 entries are not deleted automatically (you want them to persist).
- Pod metadata (`indus_pod_id`, `indus_pod_last_activity`) is cleared when the pod is terminated.
- Managed pod IDs are pruned automatically when `findPod` sees they no longer exist on RunPod.
