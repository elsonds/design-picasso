# Changelog

All notable changes to Picasso (PhonePe Illustration Generator) are tracked here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Dates are in UTC.
Add a new entry at the top of the **Unreleased** section whenever code changes
are made. Move **Unreleased** entries under a dated version heading when pushing
to git.

## [Unreleased]

### 2026-04-19 — Security hardening: JWT auth, rate limiting, debug endpoints removed

Three-part fix closing the main security issues called out in the code review.

**1. JWT verification middleware (edge function)**
- New middleware in `supabase/functions/server/index.ts` (runs after CORS,
  before anything else). Every request MUST have a valid Supabase user JWT
  in the Authorization header.
- JWT is verified via `supabase.auth.getUser(token)`. On success the
  extracted `{id, email}` is attached to the Hono context as `c.set("user", ...)`.
- Handlers now read identity via `getUser(c)` and **ignore any
  `user_id`/`email` passed in the body or query string**. That's the whole
  impersonation fix — one user can no longer masquerade as another.
- Email is double-gated: must end in `@phonepe.com` (Supabase OAuth already
  enforces this; belt + suspenders in case of config drift).
- Only `/health` is public (for uptime monitoring). Everything else 401s.
- Updated: `/comfyui/generate`, `/comfyui/cancel/:jobId`, `/comfyui/pod/start`,
  `/user/history`, `/gallery/mine`, `/feedback` (POST/GET/batch). All now
  use the JWT-derived user.

**2. Rate limiting**
- Per-user, per-minute KV counter (`rate_limit_{email}_{bucket}_{minute}`).
- Different limits per endpoint category:
  - `generate`: 20/min (expensive — each call can spin up GPU work)
  - `llm/chat`: 60/min (paid API calls)
  - `pod/*`: 20/min
  - `status`: 600/min (generous for polling)
  - Others: 100\u2013200/min
- Returns `429 { error: "rate_limited", bucket, limit, retry_after_seconds }`
  when exceeded.
- Fails open if KV is unavailable \u2014 don't block legitimate requests on
  infrastructure hiccups.

**3. Debug endpoints removed**
- `/comfyui/debug/loras`, `/comfyui/debug/s3raw`, `/comfyui/debug/s3head`,
  `/comfyui/debug/pods`, `/comfyui/debug/terminate/:podId`,
  `/comfyui/debug/s3config`, `/comfyui/debug/check` \u2014 all gone.
- They were one-time diagnostic tools added during development. Previously
  accessible to anyone with the public anon key (which is in the repo).
  The `terminate` one in particular was a real hole.
- If debugging is needed again, re-add with an explicit admin-email gate
  AND rate limiting.

**Frontend**
- `supabaseHeaders()` in `api-service.ts` is now async; it reads the
  current session's `access_token` and uses that as Bearer. Falls back to
  anon key when there's no session (server will 401).
- Same change applied to `llm-service.ts` and `gemini-service.ts` (they
  call `/llm/chat` directly).
- All call sites updated to `await supabaseHeaders()`.

**Local dev**
- Removed the `import.meta.env.DEV` auth bypass in `AuthGate` \u2014 the edge
  function no longer accepts anon-key-only requests, so the bypass would
  just produce 401s.
- To run locally: add `http://localhost:5175/**` to Supabase \u2192 Auth \u2192
  URL Configuration \u2192 Additional Redirect URLs. Then sign in via Google
  normally on localhost. The Supabase session works the same as in prod.

**Smoke tests (post-deploy)**
- `/health` + anon key \u2192 200 \u2705
- `/comfyui/status` + anon key \u2192 401 \u2705
- `/llm/chat` + anon key \u2192 401 \u2705
- `/user/history?email=<other user>` + anon key \u2192 401 \u2705 (wouldn't matter even
  if authenticated \u2014 server ignores the email param now)
- `/comfyui/debug/pods` + anon key \u2192 401 \u2705 (route no longer exists; auth
  blocks before routing so no 404 leak)

**What this fixes (from the earlier code review)**
- Security grade moves from D+ to B.
- User impersonation via body params: FIXED.
- Gallery / history enumeration by email: FIXED.
- Anyone-can-terminate-pods: FIXED (debug endpoints removed).
- Rate-limit abuse (OpenAI quota burn, GPU spend): FIXED.

**Known residual gaps**
- Input size validation (prompt length, reference image size) still not
  enforced server-side \u2014 relying on client limits + payload limits.
- RunPod API key still has full account scope \u2014 a compromise of the
  edge function would still be bad. Could be mitigated with a more
  scoped key if RunPod supports it.
- `/activity/recent` is still team-wide (by design \u2014 public-within-team).

### 2026-04-19 — Fix: Conceptualise — LLM proxy now finds the API key

- Conceptualise phase was failing because `/llm/chat` returned
  `OPENAI_API_KEY not configured`. The key was set in Supabase as
  `Picasso` (friendly alias), not `OPENAI_API_KEY`.
- Updated `/llm/chat` to accept the key under any of these env var
  names, in priority order:
  - OpenAI: `OPENAI_API_KEY` \u2192 `Picasso` \u2192 `picasso`
  - Gemini: `GEMINI_API_KEY` \u2192 `Gemini` \u2192 `gemini`
- Verified OpenAI round-trip end-to-end from the deployed edge function.

### 2026-04-19 — PhonePe is now the default brand

- Default `selectedBrand` in `App.tsx` is now `"PhonePe"` instead of
  `"Indus"` \u2014 matches the tab order (PhonePe is first).
- Note: banner and spot flows stay locked on non-Indus brands, so first-
  time users will see only the Icon flow unlocked by default. Switching
  to Indus unlocks banner/spot.

### 2026-04-17 — Idle timer resets on generation END, not submit; 4-min timeout

- Changed idle auto-stop from **5 minutes from submit** to **4 minutes
  from last completion/failure/cancel**. If you just finished generating,
  you now have exactly 4 minutes of quiet time before termination \u2014 not
  "4 minutes from when you hit send, minus however long the generation
  took."
- Removed `touchActivity()` from the generate handler (after `queuePrompt`).
  Added it to:
  - Pod job **COMPLETED** path (in status/:jobId handler)
  - Pod job **FAILED** path
  - Pod job **CANCELLED** path
- Pod create still calls `touchActivity()` so a pod created but never
  used will still auto-terminate after 4 minutes.
- **Safety**: `checkIdleAutoStop()` now probes the ComfyUI `/queue`
  endpoint before terminating. If anything is running or pending on the
  pod, it refreshes the activity timer and skips the stop. Prevents
  killing a pod mid-generation when a single job takes longer than 4
  minutes.

### 2026-04-17 — Pods are now TERMINATED, not paused

- Switched the RunPod GraphQL mutation from `podStop` (pause) to
  `podTerminate` in `stopPod()`. Applies to both:
  - **Manual stop** (the Stop Pod dropdown button)
  - **Auto-stop** (fires after 5 min idle)
- Rationale: paused pods keep the container disk allocated and keep
  costing ~$0.10/GB/month (~$0.14/day for a 50GB pod). Since every
  important file (ComfyUI, models, LoRAs) lives on the network volume,
  the container disk is effectively throwaway \u2014 nothing of value is
  lost by terminating.
- Tradeoff: first generation after idle is slower (~60\u2013120s fresh pod
  create vs ~10\u201330s resume). Acceptable in exchange for truly $0 idle
  cost and simpler state.
- On successful terminate: `KV_POD_ID` is cleared and the pod is removed
  from the managed list, so the next generation goes through
  `createPod` rather than trying to resume a pod that no longer exists.
- `startPod()` (resume) is still in the code for the edge case where a
  pod was paused via the RunPod dashboard directly, but is no longer
  hit by the normal flow.

### 2026-04-17 — Fix: Stop Pod actually stops + better pod-start errors

- **Stop Pod** was silently refusing to stop pods not in the managed-pod
  KV list. For pods created by older code, that meant clicking "Stop Pod"
  did literally nothing. Fixed two ways:
  - `stopPod()` now takes an `opts.force` flag. `force: true` bypasses
    the managed-list check for explicit user-initiated stops.
  - A new absolute block-list (`lora-training`, `lora_training`) refuses
    to stop protected pods regardless of `force` \u2014 LORA-TRAINING is still
    safe. Auto-stop (fire-and-forget background) still requires managed.
  - `stopPod()` returns `{ success, reason, podId, name }` instead of
    `void`, so callers can surface the reason.
  - `/comfyui/pod/stop` endpoint now returns `400` with the specific
    reason when the stop is refused.
  - Frontend `handlePodStop` shows an alert if the stop fails so the
    user isn't left wondering.
- **"Generation failed after pod start" was sometimes empty or showed
  garbled text.** Root cause: after the retry loop called
  `retryRes.json()` to check for a `job_id`, the body was consumed \u2014
  any later `.text()` returned "". Now we read the body ONCE as text
  and parse JSON from that. If the server returned `{ retry: true }`
  in the body (even without a 503), we keep waiting. The error surfaced
  to the user now uses the server's actual `error`/`message` field, so
  it will say e.g. `Pod ready but generation failed: ComfyUI queue
  error: ...` instead of the raw substring.

### 2026-04-17 — Permanent fix for dropdown overlap with `DropdownPopover`

- Root cause: `z-50` inside a component doesn't help when any ancestor
  creates a new stacking context (`transform`, `filter`,
  `overflow: hidden`, `isolation: isolate`, etc.). The gallery panel,
  the prompt bar, and the chat scroll container all do this in various
  ways, which is why the execution-mode dropdown and the phase dropdown
  kept getting covered by other elements.
- New reusable `DropdownPopover` component (`src/app/components/dropdown-popover.tsx`):
  - Renders the panel into `#modal-root` via `createPortal`.
  - Pins position with `position: fixed` computed from the trigger's
    `getBoundingClientRect` (re-computed on `resize` / `scroll`).
  - Uses `z-index: 10000` so it sits above every other UI layer.
  - Handles click-outside across the portal boundary (checks both the
    trigger and the panel refs) and Escape-to-close \u2014 so callers don't
    have to wire that up.
  - `align: 'start' | 'end'` + `direction: 'down' | 'up'` for common
    placements.
- Migrated the two existing dropdowns (`ExecutionModeDropdown` and the
  prompt-bar phase dropdown) to use `DropdownPopover`. Both now always
  render on top regardless of sibling / ancestor stacking contexts.
- Documented the pattern in a block comment at the top of
  `dropdown-popover.tsx` \u2014 future dropdowns should use it, not reinvent
  z-index hacks.

### 2026-04-17 — Chat header cleanup + gallery icon + Save All moved

- Removed the **Reset Chat** (trash) button and its confirmation modal
  from the chat header. Unused in practice.
- Changed the gallery icon from `LayoutGrid` to `Images` \u2014 reads more
  clearly as a picture gallery.
- Removed the **Save All** (FolderDown) button from the chat header and
  moved it inside the gallery panel header (next to the close button).
  The download logic now operates over whatever the current gallery view
  shows (Session / Mine / Team).

### 2026-04-17 — Activity feed rows hug content + state as icon-only

- Removed the fixed 360px row width. Container is now
  `flex-col items-start` with `maxWidth: 90vw` so each row sizes to its
  own content. No more wasted whitespace pushing the ETA to the far right.
- Replaced the text state labels ("generating", "#1", etc.) with the
  state icon only \u2014 spinning loader for the active row, clock for queued.
  Hover the icon (or the prompt) to see the state in words via title.
- Prompt column caps at `maxWidth: 220px` with ellipsis so long prompts
  still truncate while the row as a whole hugs content.

### 2026-04-17 — Fix: cancelled generations now disappear from activity feed

- Root cause for the stuck "EL generating \u00b7 bulb" row: the cancel
  endpoint looks up job metadata to get the user/prompt. If the job
  already completed (and the metadata was cleaned up), OR if cancel was
  invoked before the job was queued, the log entry would either be missing
  or have no user attribution \u2014 so it never matched the feed's
  job-id-based dedup and the "requested" row stayed visible forever.
- Cancel endpoint now accepts an optional JSON body: `{ email, user_id,
  prompt, execution_mode }` which the client always sends. Server prefers
  its own KV metadata but falls back to the client hints so the
  `generation.cancelled` log entry is always well-formed.
- Client `cancelGeneration()` now stores the request's email/prompt/mode
  in `activeGenerations` so it can forward them on cancel. Also always
  POSTs to `/comfyui/cancel/...` even if the server-side `jobId` was never
  set (e.g. pod was still starting) \u2014 using the local gen id as the key.
- Activity feed now treats any `generation.requested` entry older than
  10 min with no resolution as stale and drops it. Handles the case where
  a cancel event was somehow never written (old stuck data clears itself).

### 2026-04-17 — Cancel events + activity feed icons + prompt truncation

- **Cancel endpoint**: new `POST /comfyui/cancel/:jobId` actually cancels
  the job on RunPod (serverless `/cancel/{id}`) or on the pod (ComfyUI
  `POST /queue {delete:[id]}` + `/interrupt` if running), logs
  `generation.cancelled` to the activity log, and deletes the job
  metadata from KV. Previously cancel was only client-side \u2014 the
  generation kept running and the activity feed never updated.
- Added `generation.cancelled` event type to `ActivityLogEntry` /
  `ActivityEntry`.
- `ActivityFeed` now filters cancelled jobs out of the in-flight list
  (same as completed / failed).
- **Icons per state**: spinning `Loader2` for the currently-generating
  row, `Clock` for queued rows and the overflow "+N more" line. Makes
  it easier to scan the list at a glance.
- **Prompt truncation**: each row uses flex layout with
  `text-ellipsis overflow-hidden whitespace-nowrap` on the prompt span.
  Fixed-width container (360px, capped at 90vw) means long prompts get
  cut off with "\u2026" instead of breaking the layout. Full prompt shown on
  hover via the `title` attribute.

### 2026-04-17 — Fix: chat no longer steals scroll while generations are in flight

- Before: every progress tick (phase/progress update every 2s per pending
  message) triggered an auto-scroll to the bottom via `scrollIntoView`.
  With several concurrent queued generations this made it impossible to
  scroll up and look at an earlier illustration.
- After: auto-scroll only fires when the user is already "near bottom"
  (within 120px). If they've scrolled up, their position is preserved
  even as new messages arrive.
- Added a small "Jump to latest \u2193" pill that appears centered at the
  bottom only when scrolled up \u2014 one click snaps back to the newest
  message and re-enables auto-follow.

### 2026-04-17 — Fix: pod auto-stop actually completes after 5 min idle

- The idle-check middleware was running `checkIdleAutoStop()` as
  fire-and-forget (`.catch(...)` without await). Supabase Edge Functions
  (Deno Deploy) terminate the worker process as soon as the HTTP response
  is sent, so the pending RunPod GraphQL `podStop` mutation was often
  getting cut off mid-flight \u2014 the check detected idle correctly but the
  stop call never reached RunPod.
- Fix: `await` the check instead. Overhead is a single KV read (~50ms)
  when the pod is NOT idle (early return), and ~1\u20132s only on the one
  request where the stop actually fires.

### 2026-04-17 — Brand tab order: PhonePe first

- Reordered brand tabs in the prompt bar: `PhonePe \u2192 Indus \u2192
  Share.Market \u2192 Generic`. Default selected brand remains Indus so the
  banner/spot flow chips stay unlocked on first load.

### 2026-04-17 — Allow sending while another generation is in flight

- The send button and Enter key were still blocked by `isGenerating`
  even though the backend + state layer already supports concurrent
  generations. Removed the block from `prompt-bar.tsx` in three places:
  keyboard handler, split-button styling, and the arrow's `disabled`
  attribute. Now only `!prompt.trim()` disables send.
- Tooltip on the send arrow reads "Queue another (concurrent)" when
  something is already generating, so the state is obvious.

### 2026-04-17 — Prompt bar: inline attach + split send button

- Attach (paperclip) icon moved from the right controls into the
  textarea row, sitting just before the textarea. More discoverable and
  aligns visually with the text entry.
- Replaced the separate phase dropdown + arrow send button with a
  single split button:
  - Left half: `Auto` / `Conceptualise` / `Generate` + chevron \u2014 clicking
    opens the phase dropdown.
  - Vertical separator.
  - Right half: arrow icon \u2014 clicking sends the prompt.
  - Both halves share the same background (active vs disabled).

### 2026-04-17 — Activity feed shows only in-flight with queue position + ETA

- Activity feed no longer shows completed/failed generations. It groups
  entries by `job_id` and filters to jobs whose latest event is
  `generation.requested` (i.e. still in the queue or actively running).
- Each in-flight row shows: who started it, the (truncated) prompt, and
  its queue state:
  - First in line: `generating · <prompt>` (green)
  - Rest: `queued #1 · <prompt>`, `queued #2 · <prompt>`, etc.
- Per-row ETA = `(position * avg_exec_seconds) / effective_workers`.
  `effective_workers` is 1 for pod, `max(1, idle+running)` for serverless.
- `avg_exec_seconds` is the rolling average the edge function already
  tracks per mode; falls back to 30s (pod) / 45s (serverless) if no data.
- Feed button now shows `Activity 3 · ~2m` \u2014 the count badge (active +
  queued) plus a total-remaining-time chip.
- Overflow: if more than 6 rows, a `+N more in queue` hint is shown.
- `ActivityFeed` now takes a `statusInfo` prop from `App.tsx` so it can
  compute ETAs without a second status fetch.

### 2026-04-17 — Pod auto-stop countdown in the UI

- New helper `getIdleSecondsRemaining()` in `pod.ts` computes
  `autoStopMinutes * 60 - (now - lastActivity)` from the KV-stored
  activity timestamp.
- Status endpoint (pod branch) now returns `idle_remaining_seconds`
  and `idle_timeout_seconds` whenever the pod is in `ready` state.
- `ExecutionModeDropdown` shows a live countdown:
  - **Button chip**: `Pod · stops in 4:38` appears inline (replaces
    the default spot when queue is empty). Color shifts from slate →
    amber below 60s → red below 30s.
  - **Expanded details**: `Auto-stops in 4:38 (5m idle)` line under
    the queue summary.
- Countdown ticks locally every second via a `setInterval` effect;
  resets to the server value whenever the next status poll comes in
  (so fresh generations that reset the timer server-side are
  reflected within 30s max).

### 2026-04-17 — Fix: new pods now actually take the username

- Bug: selecting Pod mode was still resuming the old `Indus-ComfyUI`
  pod instead of creating a fresh one named after the user. Root cause
  was the cached pod ID in KV (`indus_pod_id`) still pointing at that
  legacy pod from before the name-change rollout; both `ensurePodRunning`
  and `startOrCreatePod` happily dereferenced it without checking the
  managed-pod list. RunPod's `podResume` also doesn't rename pods, so
  resuming kept the original "Indus-ComfyUI" label.
- Fix: both functions now verify the cached pod ID is in the managed
  list first. If not, the cache is cleared and the flow falls through
  to `findPod()` / `createPod(userLabel)` — which creates a new pod
  named just `el` / `elson` / etc.
- Effect: next time you hit generate in Pod mode, a brand-new pod named
  after you gets created. The old `Indus-ComfyUI` pod is left alone
  (not stopped, not renamed — you'll want to terminate it manually in
  the RunPod console to avoid paying for two).

### 2026-04-17 — Gallery on landing + copy prompt

- **Gallery button on the landing page** alongside History (top-right).
  Clicking opens the same gallery panel (slide-in from right, backdrop
  dim) so users can browse past generations before starting a new
  prompt. Previously the button only existed in the chat header.
- **Copy prompt**: added a copy icon to each gallery card in two places
  \u2014 the hover overlay (alongside Download + Expand) and inline next to
  the prompt text. Copies the full prompt string to the system clipboard
  via `navigator.clipboard.writeText`. Shows a green check for 1.5s on
  success.

### 2026-04-17 — Fix: activity feed showing duplicate "started" entries

- The frontend re-hits `/comfyui/generate` multiple times during pod
  startup (503-retry loop). Each retry was logging a fresh
  `generation.requested` event, causing the activity feed to show the
  same generation 3\u20136 times.
- Moved the request log from the top of the generate handler to AFTER
  the job is actually accepted (`queuePrompt` for pod, `submitServerlessJob`
  for serverless). Pod-startup retries no longer generate entries.
- Bonus: the log now includes the `job_id` for the requested event, so
  it ties to the completion/failure entry.

### 2026-04-17 — Persistent gallery on RunPod network volume

- **Images now persist** on the RunPod network volume (via their S3-
  compatible API, keyed `gallery/{user-prefix}/{jobId}.png`). After every
  successful generation the edge function saves the PNG bytes to the
  volume — no third-party storage, same disk the ComfyUI models live on.
- **Supabase KV mapping**: for each saved image we write a `gallery_{email}_
  {ts}_{jobId}` entry containing `key`, `prompt`, `email`, `style`, `flow`,
  `mode`, `seed`, `width`, `height`, `execution_time`, `execution_mode`,
  `lora_name`, `job_id`, `timestamp`. Fast to list per-user or globally.
- **New edge-function endpoints**: `GET /gallery/mine?email=...`,
  `GET /gallery/team`, `GET /gallery/image?key=...`. The image endpoint
  proxies the S3 fetch and returns a base64 data URL so the frontend
  never touches S3 credentials or CORS.
- **New `s3.ts` module**: self-contained AWS SigV4 signer for Deno/fetch.
  Supports GET (list + download) and PUT. No external SDK.
- **Gallery UI reworked**: `ImageGridPanel` now has three tabs —
  **Session** (in-memory, current run), **Mine** (persistent, current
  user), **Team** (everyone). Remote tabs lazy-load thumbnails (24 at a
  time) via the proxy endpoint. Team tab shows `user · time ago` under
  each prompt.
- Required 5 Supabase secrets: `RUNPOD_S3_ACCESS_KEY`,
  `RUNPOD_S3_SECRET_KEY`, `RUNPOD_S3_ENDPOINT`, `RUNPOD_S3_BUCKET`,
  `RUNPOD_S3_REGION`. The bucket is the network volume ID.

### 2026-04-17 — Activity feed toggle is now a proper button

- Replaced the tiny `hide`/`activity` text link with a proper pill button
  matching the `ExecutionModeDropdown` styling (padded, rounded, bordered).
- Button shows an Activity icon, label, chevron, and a small green badge
  with the count of in-flight ("started") generations.
- Kept polling when hidden (slower cadence: 15s vs 5s) so the badge count
  stays accurate even when the list is collapsed.

### 2026-04-17 — Local dev user "EL"

- In local dev (`import.meta.env.DEV`) the auth gate is bypassed, which
  left `user` as null and caused activity-feed entries to read "someone
  started...". Now a fixed local user `EL@local.dev` is used in dev mode.
  Activity feed shows `EL` as the actor; pods created from localhost are
  named `el` (sanitizer lowercases).

### 2026-04-17 — Pod named just by user + managed-pod tracking + live activity feed

- **Pod names are now just the user label** (e.g. `elson`) instead of
  `Indus-ComfyUI-elson`. Cleaner in the RunPod console.
- **Tracked managed pod IDs in KV** (`picasso_managed_pod_ids`). Replaced
  name-substring matching (which becomes unreliable with generic names)
  with an explicit allow-list of pod IDs the app has created. `findPod()`,
  `stopPod()`, and `checkIdleAutoStop()` all refuse to touch any pod not
  in the list — a pod like `LORA-TRAINING` is never in the list, so it
  will NEVER be stopped by this app regardless of its name or state.
- Stale entries (pods that no longer exist on the account) are pruned
  automatically when `findPod()` is called.
- **Live Activity Feed** — free-floating small text in the bottom-left
  showing what everyone on the team is generating right now. Lines look
  like: `elson started · mango icon`, `rahul completed · cherry blossom (32s)`,
  `elson failed · No GPU`. No container, fades out older entries.
  Hideable via a small `hide` button; preference saved in localStorage.
  Polls `/activity/recent` every 5 seconds. Last 30 minutes window.
- New edge-function endpoint: `GET /activity/recent?limit=N&since=TS`
  returns the N most recent activity events across all users.

### 2026-04-17 — Reliable 5-min idle auto-stop + pod-name safety

- **Idle auto-stop now actually fires after 5 min**. Removed
  `touchActivity()` calls from read-only status-poll paths
  (`ensurePodRunning()` no longer resets the timer just because the UI is
  open in pod mode). Timer now only resets on real generation submissions.
- **Idle check runs on every edge-function request**, not just pod-mode
  status polls. Added middleware that fires `checkIdleAutoStop()`
  fire-and-forget on every inbound request. Pod will stop even if the
  frontend has closed the tab or switched back to serverless mode, as
  long as anyone hits any edge-function endpoint.
- **Pod-name safety check**: `stopPod()` and `checkIdleAutoStop()` now
  fetch the pod via `getPodInfo()` and verify the name contains "indus"
  or "comfyui" (case-insensitive) BEFORE issuing the stop mutation.
  Pods like `LORA-TRAINING` are explicitly refused and logged. If the
  cached `indus_pod_id` in KV points to a non-matching pod, the cache
  is cleared rather than stopping the wrong pod.
- Explicit `touchActivity()` call added after `queuePrompt()` in the
  generate handler so the timer always resets on a real submission,
  independent of what `createPod` / `startPod` do internally.

### 2026-04-17 — User-named pods

- Pod names now include the requesting user's email prefix, e.g.
  `Indus-ComfyUI-elson` instead of plain `Indus-ComfyUI`. Makes it easy to
  tell whose pod is whose in the RunPod console when multiple users share
  the account. Sanitized: lowercased, non-alphanumeric chars replaced with
  `-`, capped at 24 chars. `findPod()` still matches by "indus"/"comfyui"
  substring so reuse detection keeps working.
- `createPod(userLabel?)`, `startPod(podId, userLabel?)`,
  `startOrCreatePod(userLabel?)` now thread the label through.
- Edge function derives the label from `email.split("@")[0]` in both the
  generate handler and `/comfyui/pod/start`.

### 2026-04-17 — Concurrent generations + ETA + activity log

- **Concurrent generations**: Multiple generation requests can now run in
  parallel from a single session. Removed module-level singletons in
  `api-service.ts`; each generation tracks its own abort controller and
  job ID in a Map. Each pending generation has its own chat bubble with an
  independent progress indicator; users can queue new prompts while earlier
  ones are still running.
- **Per-message progress**: `ChatMessage` now carries `pending`, `phase`,
  `progress`, `generationId`, and `ratio` fields. The old global
  `isGenerating` / `generationPhase` / `generationProgress` state was
  replaced with a derived `messages.some(m => m.pending)` plus per-bubble
  state. `cancelGeneration(genId?)` cancels one or all.
- **Per-request execution mode** (Option A): `generateImage` now sends
  `execution_mode` in the POST body; the edge function uses the request
  value first, falling back to KV only as a default. Prevents stale
  server-side mode from clobbering the selection in the UI.
- **Queue count + ETA**: Status endpoint returns `queue_running`,
  `queue_pending`, `avg_exec_seconds`, `eta_seconds`. Edge function
  maintains a rolling average (exponential, cap of 20 samples) of completed
  generation times per mode, stored in KV as `avg_exec_time_{mode}`.
  Dropdown button shows `N in queue · ~Xm` when there is load; expanded
  dropdown shows full worker + queue breakdown. In-flight pod generations
  show `Queued — #2 of 3 · ~1m` inline.
- **Activity log**: Every generation is logged to Supabase KV with user
  email, prompt, mode, seed, dimensions, LoRA, success/failure, and
  execution time. Events: `generation.requested`, `generation.completed`,
  `generation.failed`. Keys: `activity_{email}_{timestamp}_{jobId}` for
  fast per-user prefix scans. New `GET /user/history` endpoint.
- **Activity history panel**: New side panel (420px) accessible from top-
  right on landing and from the chat header. Groups entries by job,
  shows relative timestamps, mode chips, prompts, seeds, and errors.
- **Serverless status now detects degraded state**: "No GPU" badge fires
  when workers=0 AND jobs are stuck in queue (or recent failures > successes).
  Previously it falsely reported "ready" even when RunPod couldn't
  provision GPUs. Status dot is gray by default (before first poll) and
  only turns green when workers are genuinely available.
- **Pod mode (new)**: Added `supabase/functions/server/pod.ts` with
  RunPod GraphQL pod lifecycle (find/create/start/stop), 16-GPU fallback
  chain, two-pass datacenter search, direct ComfyUI API (upload image,
  queue prompt, poll history, fetch image), and idle auto-stop after 5
  minutes (checked on every status poll from the frontend). Auto-detects
  any existing Indus/ComfyUI pod on the account before creating a new one.
- **Mode dropdown**: New `ExecutionModeDropdown` component lives in the
  chat header (top-left), replacing the old `StatusIndicator`. Shows mode,
  health, queue, ETA, and GPU info. Options: Serverless, Pod. Pod mode
  shows "Stop Pod" when running.

## [0.1.0] — 2026-04-10

### Added
- Dual execution mode: **serverless + pod** with auto-detect of running pods
- New `supabase/functions/server/pod.ts` module
- Brand+flow-aware style descriptions and negative prompts in edge function
- OAuth auth gate via Supabase (restricted to `@phonepe.com` accounts)
- LLM proxy through Supabase Edge Function (removes client-side API keys)
- Brand+flow-aware workflow selection (Indus, PhonePe, Share.Market, Generic)
- Modal portal (`#modal-root`) for dialogs to escape stacking contexts

### Changed
- Execution mode dropdown moved from prompt bar → top-right → top-left
  (replacing `StatusIndicator` in chat header)
- Removed settings dialog entirely (LLM config is server-managed)
- Removed ~800 lines of dead workflow-building code from `api-service.ts`
- Frontend now always routes through the edge function

### Fixed
- Portal fallback to `document.body` if `#modal-root` is missing
- Dev-mode auth bypass for local testing (`import.meta.env.DEV`)
- Vercel build issues: rollup binary, package-lock, Node 18 pin

### Infrastructure
- Initial commit: React/Vite illustration generator with Supabase backend
- RunPod Serverless as the default generation backend
