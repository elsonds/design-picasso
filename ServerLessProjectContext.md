# ProjectContext.md — Source of Truth

> **Repository:** `Design-phonepe/illustrate`
> **Last Updated:** 2026-02-24

---

## 1. Project Identity & Intent

### What It Is

**Illustrate** (branded internally as **Indus Design Studio**) is a web-based AI image generation tool built for PhonePe's design team. It produces **high-end glossy vector-style illustrations** in a distinctive "Indus" art style—smooth gradients, beveled edges, studio lighting, floating compositions on solid black backgrounds.

### The Problem It Solves

Design teams need a fast, self-service pipeline to generate on-brand iconography and illustrations at scale without manually commissioning each asset. This tool wraps a fine-tuned diffusion model (LoRA-adapted Qwen Image 2512) behind a polished UI, abstracting away the complexity of ComfyUI workflows, GPU pod lifecycle management, and serverless cold starts.

### North Star

**One-prompt-to-production-illustration**: a designer types a subject description (e.g., "elephant playing cricket with a lion"), picks dimensions, and receives a publish-ready vector-style image in under 60 seconds—with zero knowledge of diffusion models, ComfyUI, or cloud GPU infrastructure.

---

## 2. Core Stack & Infrastructure

### Languages & Runtime

| Layer | Technology | Version |
|-------|-----------|---------|
| Backend | **Python** | 3.11.9 (pinned in `runtime.txt`) |
| Frontend | **Vanilla HTML/CSS/JS** | Single-file SPA (`templates/index.html`, ~7200 lines) |
| WSGI Server | **Gunicorn** | ≥21.0, 1 worker, 120s timeout |

### Frameworks

| Framework | Purpose | Why Chosen |
|-----------|---------|------------|
| **Flask** | HTTP server, routing, template rendering | Lightweight; no ORM or database needed. The app is stateless except for in-memory job metadata. |
| **Flask-Login** | Google OAuth session management | Minimal auth layer; optional and disabled when `GOOGLE_CLIENT_ID` is unset. |
| **Three.js** (r128) | 3D viewport for Camera mode orbit dial | Provides the interactive 3D canvas in Camera mode. Loaded from CDN. |

### Critical Libraries

| Library | Version | Role |
|---------|---------|------|
| **boto3** | ≥1.26 | S3-compatible API client for RunPod Network Volume (gallery persistence) |
| **requests** | ≥2.25 | All HTTP calls: RunPod GraphQL, RunPod REST, PhonePe API, ComfyUI API |
| **authlib** | ≥1.2 | Google OAuth OIDC flow (optional) |
| **python-dotenv** | ≥1.0 | `.env` file loading for local dev; gracefully skipped if absent |
| **certifi** | ≥2023 | Explicit SSL cert bundle injection (`SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`) to work around environments with missing root CAs |
| **runpod** (serverless handler only) | latest | `runpod.serverless.start()` listener in the worker container |

### Infrastructure

| Component | Provider | Notes |
|-----------|----------|-------|
| **Web Hosting** | Render (free/starter tier) | Gunicorn behind Render's reverse proxy; 30s request timeout enforced by Render |
| **GPU Compute** | RunPod Serverless or RunPod GPU Pods | Serverless preferred (pay-per-second); pods used for ControlNet (requires image upload) |
| **Model Storage** | RunPod Network Volume | Mounted at `/runpod-volume`; also exposed via S3-compatible API for gallery reads |
| **Container Runtime** | Docker on RunPod | `runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04` base image |
| **Diffusion Engine** | ComfyUI | Headless; API-mode only (`--listen 0.0.0.0 --port 8188 --disable-auto-launch`) |
| **Uptime Monitoring** | UptimeRobot (recommended) | Hits `/ping` every 5–10 min to prevent Render free-tier cold starts |

---

## 3. Technical Architecture

### High-Level Data Flow

```
┌────────────┐     HTTP/SSE      ┌──────────────┐    RunPod REST     ┌─────────────────┐
│  Browser   │ ◄──────────────► │  Flask App    │ ◄──────────────►  │ RunPod Serverless│
│ (index.html)│                  │  (app.py)     │                   │   Worker         │
└────────────┘                  └──────┬────────┘                   │  (handler.py)    │
                                       │                            │  ┌──────────┐    │
                                       │ boto3 S3                   │  │ ComfyUI  │    │
                                       ▼                            │  │ localhost │    │
                                ┌──────────────┐                    │  │ :8188    │    │
                                │ RunPod S3    │                    │  └──────────┘    │
                                │ (Gallery)    │                    └─────────────────┘
                                └──────────────┘                           │
                                                                    ┌──────────────┐
                                                                    │Network Volume│
                                                                    │/runpod-volume│
                                                                    └──────────────┘
```

### Three Execution Modes

The UI exposes three operational modes via a toolbar, each with a distinct backend path:

| Mode | Backend Route | GPU Path | Workflow |
|------|--------------|----------|----------|
| **Indus (Node/Chat)** | `/comfyui/generate/start` + `/comfyui/generate/status/<id>` | RunPod **Serverless** (async poll) | `image_qwen_Image_2512.json` |
| **Indus + Reference Image** | `/comfyui/generate` | RunPod **Pod** (direct ComfyUI API) | `image_controlnet_2512.json` |
| **Camera / Edit** | `/generate` | **PhonePe API** (external, optional) | N/A — proxied to external model |

### Serverless Job Flow (Primary Path)

This is the **production path** optimized for Render's 30-second request timeout:

1. **Submit** — `POST /comfyui/generate/start` calls `submit_serverless_job()` → RunPod `/v2/{endpoint}/run` → returns `job_id` in ~2–5s.
2. **Poll** — Frontend polls `GET /comfyui/generate/status/{job_id}` every few seconds. Each poll calls `poll_serverless_job()` → RunPod `/v2/{endpoint}/status/{job_id}`.
3. **Complete** — When status is `COMPLETED`, extract base64 image from `output.image` or `output.images[0].data`. Save to S3 (best-effort, non-blocking). Return to browser.

**Why async poll instead of long-poll?** Render enforces a hard ~30s timeout per HTTP request. Each poll completes in <1s, staying well within limits.

### Streaming SSE Path (Alternative)

When the client sends `stream: true` to `POST /comfyui/generate`:

1. Flask returns `text/event-stream` response.
2. A background thread calls `run_serverless()` with a status callback.
3. SSE events (`status`, `done`, `error`) are yielded to the client.
4. Keepalive comments (`: keepalive\n\n`) are sent every 15s to prevent proxy timeouts.

### Pod Flow (ControlNet Only)

When a reference image is attached:

1. `IndusGPU.ensure_running()` finds or creates a persistent RunPod pod via **GraphQL API**.
2. Reference image is uploaded to ComfyUI via `POST /upload/image`.
3. ControlNet workflow is prepared with the uploaded filename injected into node `28`.
4. `generate_image()` queues the workflow and polls ComfyUI's `/history/{prompt_id}`.
5. After generation, `schedule_auto_stop()` sets a 5-minute idle timer to stop the pod.

### State Management

- **Server-side state is minimal and ephemeral.** The Flask process holds:
  - `IndusGPU` singleton (`gpu`) — tracks `pod_id`, `pod_status`, auto-stop timer.
  - `_gallery_cache` — 30-second TTL in-memory cache of S3 gallery listings.
  - `_users_cache` — in-memory dict for Flask-Login sessions (lost on restart).
  - `_s3_working_endpoint` — cached working S3 datacenter endpoint after first successful listing.
- **Gunicorn must run with `--workers 1`** because job metadata and pod state live in-process memory. Multiple workers would lose state coherence.
- **Frontend state** is entirely in-browser JavaScript variables. No localStorage or IndexedDB. Page refresh resets all state.

---

## 4. Domain Model & Schema

### No Database

This project has **no persistent database**. All persistence is via:

1. **RunPod Network Volume** (NFS-like) — model weights, generated output images at `/runpod-volume/ComfyUI/output/`.
2. **RunPod S3-compatible API** — gallery images stored under configurable prefix (default `gallery/`). Each generation stores:
   - `{prefix}{timestamp}_{uuid12}.png` — the image bytes.
   - `{prefix}{timestamp}_{uuid12}.json` — metadata sidecar:
     ```json
     {
       "prompt": "elephant playing cricket",
       "width": 1328,
       "height": 1328,
       "time": 23.4,
       "filename": "Qwen-Image-2512_00001_.png"
     }
     ```

### Key Entities (Conceptual)

| Entity | Representation | Lifecycle |
|--------|---------------|-----------|
| **ComfyUI Workflow** | JSON template files on disk | Loaded at request time; nodes mutated in-memory before submission |
| **Generation Job** | RunPod job ID (string) | Created on submit; polled until COMPLETED/FAILED; no server-side persistence |
| **GPU Pod** | RunPod pod ID (string) | Tracked in `IndusGPU` singleton; auto-stopped after 5 min idle |
| **Gallery Item** | S3 object key (`.png` + sidecar `.json`) | Persisted indefinitely on network volume |
| **User (optional)** | In-memory `UserMixin` via Flask-Login | Session-only; lost on server restart |

### Model Architecture (AI/ML)

| Component | File | Format |
|-----------|------|--------|
| **UNet / Diffusion Model** | `qwen_image_2512_bf16.safetensors` | BF16, Qwen Image architecture |
| **CLIP Text Encoder** | `qwen_2.5_vl_7b_fp8_scaled.safetensors` | FP8 quantized, Qwen 2.5 VL 7B |
| **VAE** | `qwen_image_vae.safetensors` | Standard VAE decoder |
| **LoRA (Style)** | `indus-style.safetensors` | Fine-tuned style adapter; strength 1.0–1.5 |
| **ControlNet** | `diffusion_pytorch_model.safetensors` | Union ControlNet (canny/lineart/anime_lineart/mlsd) |

### Workflow Node Maps

**Prompt-Only Workflow** (`image_qwen_Image_2512.json`) — Key Nodes:

| Node ID | Class | Parameterized Fields |
|---------|-------|---------------------|
| `91` | `PrimitiveStringMultiline` | `value` ← full prompt |
| `92:3` | `KSampler` | `seed`, `steps: 30`, `cfg: 2.5`, `sampler: euler`, `scheduler: simple` |
| `92:58` | `EmptySD3LatentImage` | `width`, `height` |
| `92:66` | `ModelSamplingAuraFlow` | `shift: 3.1` |
| `92:73` | `LoraLoaderModelOnly` | `indus-style.safetensors`, strength 1.0 |

**ControlNet Workflow** (`image_controlnet_2512.json`) — Key Nodes:

| Node ID | Class | Parameterized Fields |
|---------|-------|---------------------|
| `6` | `CLIPTextEncode` | `text` ← full prompt |
| `10` | `KSampler` | `seed`, `steps: 30`, `cfg: 2.5` |
| `11` | `EmptyLatentImage` | `width`, `height` |
| `18` | `ControlNetApplyAdvanced` | `strength: 2`, full range `0.0–1.0` |
| `23` | `Canny` | Edge detection: `low: 0.4`, `high: 0.8` |
| `28` | `LoadImage` | `image` ← uploaded filename |

---

## 5. Critical Nuances & Edge Cases

### Render 30-Second Timeout Workaround

**Problem:** Render's reverse proxy terminates any HTTP request open longer than ~30 seconds. Image generation takes 20–90 seconds.

**Solution:** The async submit/poll pattern (`/comfyui/generate/start` + `/comfyui/generate/status/<job_id>`) ensures every individual HTTP request completes in <5 seconds. The browser drives the polling loop. This is **the reason** the codebase has two separate serverless invocation paths (streaming SSE and async poll).

### S3 Datacenter Discovery

**Problem:** RunPod S3 endpoints are datacenter-specific. Users may not know which datacenter their volume is in, or the configured endpoint may be wrong.

**Solution:** `list_gallery_from_s3()` tries the configured endpoint first, then **iterates through all 5 known RunPod datacenters** (`EUR-IS-1`, `US-NC-2`, `US-CA-2`, `EU-CZ-1`, `US-GA-2`). The first successful endpoint is cached in `_s3_working_endpoint` for subsequent reads.

### Pod Image Output Type Ambiguity

**Problem:** ComfyUI workflows can produce images via `SaveImage` (persisted to disk, `type=output`) or `PreviewImage` (ephemeral, `type=temp`). The handler must retrieve the correct one.

**Solution:** `generate_image()` in `IndusGPU` iterates all node outputs and **prefers `type=output` over `type=temp`**, falling back to the first image found if no `SaveImage` node exists.

### GPU Fallback Chain

**Problem:** Specific GPU types (e.g., Blackwell RTX PRO 6000) may have supply constraints on RunPod.

**Solution:** `create_pod()` tries GPUs in priority order defined in `POD_CONFIG['gpu_fallbacks']` (6 GPU types). On `SUPPLY_CONSTRAINT` errors, it falls through to the next type. This list spans Blackwell server/workstation editions, RTX 4090, L40S, and A6000.

### Pod Resume Failure

**Problem:** A stopped pod may have been terminated by RunPod (e.g., billing, capacity reclaim). `podResume` will fail.

**Solution:** `start_pod()` catches resume failures, clears `pod_id`, and falls through to `create_pod()` to provision a fresh pod.

### SSL Certificate Injection

**Problem:** Some deployment environments (containers, minimal OS images) lack root CA certificates, causing `requests` HTTPS calls to fail.

**Solution:** At module load time, `certifi.where()` is injected into both `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE` environment variables. The import is wrapped in `try/except` to degrade gracefully.

### ComfyUI Cold Start (Serverless)

**Problem:** First request to a serverless endpoint cold-starts a worker (~30–60s). The handler must install ComfyUI, symlink models from the network volume, and wait for ComfyUI's HTTP API to become ready.

**Solution:** `handler.py` startup sequence: (1) symlink 8 model directories from `/runpod-volume/ComfyUI/models/` into `/comfyui/models/`, (2) start ComfyUI subprocess, (3) poll `/system_stats` every 2 seconds with a 300-second deadline. Subprocess stdout is streamed via a daemon thread to avoid blocking.

### Prompt Safety

All user prompts are wrapped with a **hardcoded negative prompt** (`NEGATIVE_PROMPT` constant) covering NSFW, violence, offensive content, and quality degradation terms. This applies to the Camera/Edit PhonePe API path. The Indus path uses its own negative prompt baked into the ComfyUI workflow JSON (node `92:7` / node `7`).

### Gallery Cache TTL

`_gallery_cache` uses a 30-second TTL. This prevents hammering the S3 API on rapid gallery refreshes but means new generations won't appear in the gallery for up to 30 seconds.

### Single-Worker Constraint

The `Procfile` and all deployment docs specify `--workers 1`. This is **not a performance choice** — it's a correctness requirement. `IndusGPU` state (pod ID, auto-stop timer) and `_gallery_cache` are in-process memory. Multiple workers would see inconsistent state and could double-create pods or miss auto-stop timers.

---

## 6. Development Workflows

### Local Development

```bash
# 1. Clone and set up
git clone https://github.com/Design-phonepe/illustrate.git
cd illustrate
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 2. Configure environment
cp .env.example .env
# Edit .env: set RUNPOD_API_KEY, RUNPOD_ENDPOINT_ID at minimum

# 3. Run
python app.py
# → http://127.0.0.1:5001
```

### Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `RUNPOD_API_KEY` | **Yes** | RunPod API authentication |
| `RUNPOD_ENDPOINT_ID` | **Yes** | Serverless endpoint ID for generation |
| `FLASK_SECRET_KEY` | **Prod** | Session signing key (default: `dev-secret-change-in-production`) |
| `RUNPOD_S3_ACCESS_KEY` | Gallery | S3 API access key for RunPod Network Volume |
| `RUNPOD_S3_SECRET_KEY` | Gallery | S3 API secret key |
| `RUNPOD_NETWORK_VOLUME_ID` | Gallery | Network volume ID (used as S3 bucket name) |
| `RUNPOD_S3_ENDPOINT` | Gallery | S3 API endpoint URL (e.g., `https://s3api-us-nc-2.runpod.io/`) |
| `RUNPOD_S3_REGION` | Gallery | Datacenter region (e.g., `US-NC-2`) |
| `RUNPOD_S3_GALLERY_PREFIX` | Gallery | S3 key prefix for gallery images (default: `gallery/`) |
| `PHONEPE_API_URL` | Camera/Edit | External PhonePe model API URL |
| `PHONEPE_API_TOKEN` | Camera/Edit | PhonePe API JWT bearer token |
| `PHONEPE_API_MODEL` | Camera/Edit | Model identifier for PhonePe API |
| `GOOGLE_CLIENT_ID` | Auth | Google OAuth client ID (auth disabled if unset) |
| `GOOGLE_CLIENT_SECRET` | Auth | Google OAuth client secret |

### Deployment — Render

1. Connect GitHub repo in Render dashboard.
2. **Build Command:** `pip install -r requirements.txt`
3. **Start Command:** `gunicorn app:app --workers 1 --timeout 120 --bind 0.0.0.0:$PORT`
4. Set environment variables in Render's dashboard (never commit `.env`).
5. Set up UptimeRobot to ping `https://<service>.onrender.com/ping` every 5–10 min to prevent free-tier sleep.

### Deployment — RunPod Serverless Worker

```bash
cd serverless/
docker build -t <user>/indus-comfyui:latest .
docker push <user>/indus-comfyui:latest
```

Then in RunPod Console:
1. Create **Template** with the Docker image, 30GB container disk, network volume at `/runpod-volume`.
2. Create **Endpoint** — GPU: RTX 4090+ (24GB VRAM min), 0 min workers, 3 max workers, 5s idle timeout, 600s execution timeout, Flash Boot ON.
3. Copy Endpoint ID → set `RUNPOD_ENDPOINT_ID` in app config.

### Testing

**No automated test suite exists.** Validation is manual:
- `/comfyui/status` — Verify RunPod connectivity.
- `/comfyui/health` — Check worker count, queue depth, GPU/RAM stats.
- `/comfyui/workflow` — Inspect the loaded workflow template.
- `/comfyui/gallery/debug` — Diagnose S3 connection (credentials, endpoint, sample keys).
- `/comfyui/volumes` — List available RunPod network volumes.

### Key API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/` | GET | Serve the SPA |
| `/ping` | GET | Keepalive endpoint (returns 204) |
| `/generate` | POST | PhonePe API proxy (Camera/Edit modes) |
| `/comfyui/status` | GET | RunPod connection status |
| `/comfyui/health` | GET | Detailed worker/queue/GPU health |
| `/comfyui/generate` | POST | Full generation (pod or serverless, sync or SSE) |
| `/comfyui/generate/start` | POST | Submit serverless job, return `job_id` |
| `/comfyui/generate/status/<job_id>` | GET | Poll serverless job status |
| `/comfyui/gallery` | GET | List gallery images from S3 |
| `/comfyui/gallery/image/<key>` | GET | Serve a gallery image from S3 |
| `/comfyui/gallery/debug` | GET | S3 connection diagnostics |
| `/comfyui/volumes` | GET | List RunPod network volumes |
| `/comfyui/workflow` | GET | Return raw workflow template JSON |
| `/comfyui/pod/start` | POST | Manually start GPU pod |
| `/comfyui/pod/stop` | POST | Manually stop GPU pod |

---

## 7. Future Roadmap & Technical Debt

### Intentional Omissions

| Item | Status | Notes |
|------|--------|-------|
| **Automated Tests** | Missing entirely | No unit, integration, or E2E tests. All validation is manual via debug endpoints. |
| **Database** | Not used | Gallery metadata is sidecar JSON files in S3. No user history, no generation logs beyond stdout. |
| **Authentication Enforcement** | Optional, incomplete | Google OAuth is wired up but effectively a no-op when `GOOGLE_CLIENT_ID` is unset. No route protection exists—all endpoints are public. |
| **Rate Limiting** | None | Any client can submit unlimited generation jobs. Cost exposure is unbounded. |
| **Multi-Worker Support** | Blocked | `IndusGPU` state is in-process. Scaling beyond 1 Gunicorn worker requires externalizing state (Redis, database). |
| **Frontend Modularity** | Monolith | `index.html` is a single 7,200-line file containing all HTML, CSS, and JavaScript. No build system, no components, no TypeScript. |
| **Error Reporting** | stdout only | All errors are `print()`-ed with `flush=True`. No structured logging, no Sentry, no alerting. |
| **Image Optimization** | None | Images are served as raw PNGs from S3. No resizing, no WebP conversion, no CDN caching. |

### Known Technical Debt

1. **`_users_cache` is unbounded** — Every authenticated user is held in a dict that grows forever until process restart.
2. **Hardcoded GPU fallback list** — `POD_CONFIG['gpu_fallbacks']` contains specific GPU model strings that will become stale as RunPod changes inventory.
3. **S3 datacenter iteration is sequential** — `list_gallery_from_s3()` tries up to 5 endpoints sequentially on failure. First load with a misconfigured endpoint incurs noticeable latency.
4. **Workflow node IDs are magic strings** — `prepare_comfyui_workflow()` references nodes by ID (`'91'`, `'92:3'`, `'92:58'`). Any workflow JSON restructuring silently breaks generation.
5. **No CORS configuration** — The Flask app has no explicit CORS headers. Frontend works only because it's served from the same origin.
6. **SSE keepalive is fragile** — The 15-second keepalive interval is tuned for Render's proxy but undocumented. Other proxies (Cloudflare, Nginx) may have different idle timeouts.
7. **Gallery returns all images** — `list_gallery_from_s3()` scans the **entire S3 bucket** (not just the `gallery/` prefix) for image files. On volumes with many non-gallery images, this produces unexpected results and slow listing.
8. **`handler.py` duplicates `start.sh` logic** — Both the Dockerfile `CMD` and `start.sh` script install ComfyUI and start the handler, creating two divergent startup paths.
9. **ControlNet strength is fixed at 2.0** — Node `18` in the ControlNet workflow has `strength: 2`, which is unusually high. This is not exposed to the user and may produce over-conditioned outputs.
10. **`ModelSamplingAuraFlow` shift value** — The prompt-only workflow uses `shift: 3.1` in node `92:66`. This is a model-specific tuning constant with no documentation explaining why 3.1 was chosen.

### Potential Evolution

- **Extract frontend into a proper SPA** (React/Svelte) with component structure and TypeScript.
- **Add Redis or SQLite** for job tracking, enabling multi-worker Gunicorn.
- **Implement API key authentication** or at least IP-based allowlisting.
- **Add WebSocket support** for real-time generation progress instead of SSE/polling.
- **Gallery pagination** — Current limit of 500 items will not scale.
- **Cost guardrails** — Per-user or per-day generation limits to bound RunPod spend.
