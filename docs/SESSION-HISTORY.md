# Claude Code Session History

A narrative recap of what was built in this working session. Organized roughly in order, grouped by theme. Every major change also lives in the [[CHANGELOG]].

## Session start

The project already had:
- React/Vite frontend, Tailwind v4
- Supabase Edge Functions as the API layer
- RunPod Serverless for image generation
- Google OAuth via Supabase (@phonepe.com only)
- A bug with the settings modal being covered by other UI

## Ordered list of work completed

### 1. Fix settings modal overlap
- Added `<div id="modal-root">` to `index.html`
- Portaled the settings dialog into it via `createPortal`
- Eventually this pattern was generalized into `DropdownPopover` (much later in the session)

### 2. Remove API keys from the browser
- Removed the OpenAI/Gemini API key input fields from the settings dialog
- Made LLM services call `/llm/chat` on the edge function instead of OpenAI directly
- The edge function reads keys from Supabase secrets
- Dead code cleanup — dropped ~800 lines of unused workflow-building code from `api-service.ts`

### 3. Local dev auth bypass
- Google OAuth was bouncing localhost auth requests to production
- Added `if (import.meta.env.DEV) return <AuthenticatedApp />;` in `AuthGate`
- Later (much later) I added a mock dev user `EL@local.dev` so activity logs and pod names work correctly on localhost

### 4. Brand+flow-aware workflow selection (huge bug)
- Both Indus and PhonePe were using the same style description (white background) because `string_b` in the default workflow was hardcoded
- Built `getStyleDescription(brand, flow)` and `getNegativePrompt(flow)` in `runpod.ts`
- In `/comfyui/generate`, after `getWorkflow()` builds the workflow, override `string_b` and negative prompt based on brand+flow
- Indus icon → black background, PhonePe → white background, banners/spots → their own styles

### 5. Settings dialog entirely removed
- User asked to just delete it, since LLM config is all server-side now
- Dropped from chat panel

### 6. Pod mode (major feature)
- Built `supabase/functions/server/pod.ts` — full RunPod GraphQL pod lifecycle
- Two-pass pod creation (preferred datacenter → community cloud) with a 16-GPU fallback chain
- ComfyUI direct API integration (upload, prompt, history, view, interrupt, queue)
- Execution mode dropdown in the UI — Pod or Serverless
- First in the prompt bar, then moved to top-left of the chat header
- Later migrated the dropdown panel into a portal (see point 15)

### 7. Dual-mode per-request switching
- Originally the mode was stored once in KV and shared across all requests/tabs
- Refactored to send `execution_mode` in each generate request body; KV is just the default now
- Fixes the edge case of multiple tabs with different modes

### 8. Activity log / history panel
- `logActivity()` helper writes `activity_{email}_{timestamp}_{jobId}` KV entries
- Events: `generation.requested`, `generation.completed`, `generation.failed`, `generation.cancelled`
- Added `/user/history?email=...` endpoint for personal history
- Added `/activity/recent` endpoint for team-wide live feed
- Built `history-panel.tsx` (right-side slide-in with grouped entries)

### 9. Activity feed (bottom-left live view)
- Started as a simple text list showing every event
- Iterated to: only active + queued, grouped by job_id
- Added per-row ETA math using rolling average exec time
- Finally: icon-only state (Loader2 spinning, Clock), hug-content rows, prompt truncation via ellipsis

### 10. Gallery with persistent storage
- Added `s3.ts` — zero-dependency SigV4 client for RunPod's S3-compatible API
- `saveToGallery()` writes bytes to `gallery/{user}/{jobId}.png` on the network volume after each successful generation
- KV mapping `gallery_{email}_{ts}_{jobId}` links it to the prompt and metadata
- Three-tab gallery panel: Session / Mine / Team
- Lazy-loaded thumbnails (24 at a time) via `/gallery/image` proxy endpoint
- Gallery button added to landing page alongside History
- Copy-prompt buttons added (hover overlay + inline next to prompt)
- Save All moved from chat header into the gallery header
- Changed gallery icon from `LayoutGrid` to `Images`
- Removed the Reset Chat button

### 11. Concurrent generations
- Previous implementation had module-level singletons (`currentAbortController`, `currentJobId`) → only one generation at a time
- Refactored to a `Map<genId, ActiveGeneration>` — each generation tracks its own controller + jobId independently
- Each pending generation has its own chat bubble with its own progress indicator
- Send button and Enter key no longer blocked by `isGenerating`
- `cancelGeneration(genId?)` cancels one or all

### 12. Chat scroll fix
- Problem: every progress tick (one per 2s per pending message) was forcing scroll-to-bottom
- Added "sticky to bottom" detection — only auto-scroll if user is within 120px of the bottom
- "Jump to latest ↓" pill button appears when scrolled up

### 13. Queue position + ETAs
- Added `getQueuePosition(podId, promptId)` in pod.ts — parses ComfyUI's `/queue`
- Server tracks rolling average execution time per mode (EMA with cap of 20 samples)
- Frontend surfaces: queue count in button label (`Pod · 3 in queue · ~2m`), per-row ETA in activity feed, "Queued — #2 of 5 · ~1m" in generation phase message

### 14. Pod idle auto-stop (multiple iterations)
- v1: 5-min timer, started on submit, fire-and-forget check in middleware
- Found bug: `ensurePodRunning` was calling `touchActivity()` every status poll, pinning the timer forever
- v2: `touchActivity()` only fires on real events (create/resume/complete/fail/cancel), not on reads
- Found bug: fire-and-forget might not complete before Supabase kills the worker. Switched to await, reverted when it caused 502s, back to fire-and-forget
- Pod-name allow-list: `picasso_managed_pod_ids` KV array — only stop pods we created
- Hard block-list on `lora-training` / `lora_training` in the pod name regardless of `force`
- Pre-stop safety check: query ComfyUI queue, defer stop if anything is running or pending
- v3: Changed timer from 5 min → 4 min, and from submit-time → completion-time
- v4 (current): 4 min from last completion/failure/cancel

### 15. Pods terminate instead of pause
- Presented pros/cons of `podStop` (pause) vs `podTerminate` (destroy)
- User chose terminate everywhere
- Changed GraphQL mutation from `podStop` to `podTerminate`
- On successful terminate: clear `KV_POD_ID`, remove from managed list so next gen makes a fresh pod

### 16. Pod name is just the username
- Changed from `Indus-ComfyUI-{user}` to just `{user}` (e.g. `elson`)
- Fixed the "stale KV points to legacy pod" bug — `startOrCreatePod` / `ensurePodRunning` now check the managed list first and ignore stale cache

### 17. Dropdowns properly portaled
- User got frustrated that dropdowns kept getting covered — we kept adding z-index patches
- Root cause: ancestors create stacking contexts that cap child z-index
- Built `DropdownPopover` — portals to `#modal-root`, position: fixed with recalculated bounding rects, z-index 10000, click-outside across portal, Escape-to-close
- Migrated both the ExecutionModeDropdown and the phase dropdown in the split-send button to use it
- Documented the pattern with a block comment so future dropdowns don't reinvent z-index hacks

### 18. Split send button
- Combined the phase selector (Auto/Conceptualise/Generate) and the send arrow into a single visual pill with a vertical separator
- Left half opens dropdown, right half sends
- Both share the same background and disabled state

### 19. Attach icon relocated
- Moved from right-side controls to just before the textarea where users' thumbs naturally go

### 20. Cancel events actually write to the activity log
- Previously the cancel HTTP call sometimes fired (client-side abort was reliable, server-side call wasn't) and the event didn't always reach the log
- Client now always POSTs with `{ email, user_id, prompt, execution_mode }` in the body so the server has fallback context even when KV job metadata is gone
- Added time-based staleness: any `requested` event older than 10 min with no resolution is dropped from the feed (belt-and-suspenders for missing events)

### 21. Serverless status detection
- "Ready" badge was showing green even when workers=0 and queue was stuck
- Added `degraded` status: triggers when `workers.total=0 && jobs.inQueue>0`, or recent failures > completions
- Default status dot is gray until first poll (was falsely green)

### 22. Stop Pod works reliably
- Old code silently refused to stop pods not in the managed list
- Added `force: true` option for user-initiated stops
- Endpoint returns 400 with specific reason on failure
- Client now shows an alert if stop fails so the user knows why

### 23. Pod-start error messages useful
- "Generation failed after pod start" was sometimes empty
- Root cause: `retryRes.json()` consumed the body before `.text()` could read it
- Now reads body once, parses JSON from it, uses `error`/`message` field
- Also accepts `retry: true` in the body (not just 503 status)

### 24. LLM proxy accepts friendly secret names
- User added the OpenAI key under `Picasso` (not `OPENAI_API_KEY`)
- Conceptualise was broken ("OPENAI_API_KEY not configured")
- Made the edge function accept any of: `OPENAI_API_KEY` / `Picasso` / `picasso` (and same for Gemini variants)

### 25. PhonePe as default brand
- Tab order reorganized: PhonePe → Indus → Share.Market → Generic
- Default selected brand changed to PhonePe

### 26. Miscellaneous polish
- Pod auto-stop countdown in the dropdown (live-tickng, color-shifts amber < 60s, red < 30s)
- Activity feed button with count badge + total ETA chip
- Prompt restructuring loosened (removed `?.apiKey` guards that silently skipped when API keys were removed from the UI)
- Gallery button on landing page alongside History
- Various small fixes: duplicate "started" entries in activity (fixed by moving log from top of handler to post-queue), scroll-stealing during concurrent gens, etc.

## Key files created this session

| File | Role |
|---|---|
| `supabase/functions/server/pod.ts` | RunPod pod lifecycle manager |
| `supabase/functions/server/s3.ts` | SigV4 S3 client for the network volume |
| `src/app/components/execution-mode-dropdown.tsx` | Top-left Pod/Serverless toggle |
| `src/app/components/dropdown-popover.tsx` | Reusable portaled dropdown primitive |
| `src/app/components/activity-feed.tsx` | Bottom-left live team pulse |
| `src/app/components/history-panel.tsx` | Top-right personal history slide-in |
| `CHANGELOG.md` | Running changelog |
| `docs/` | All documentation (this folder) |

## Key infrastructure choices

- **Portaled dropdowns** over z-index juggling — permanent fix for overlap bugs
- **Managed pod allow-list** over name matching — bulletproof protection for LORA-TRAINING regardless of name
- **Terminate over pause** — zero idle cost, predictable state
- **Per-message progress** over global progress state — enables true concurrent generations
- **Server-side secrets with friendly aliases** — `Picasso` / `Gemini` / etc. work alongside canonical names
- **KV-first storage** — simple, debuggable, appropriately sized for an internal tool

## What wasn't done (good follow-ups)

- Activity log cleanup (grows unbounded)
- Gallery deletion / permissions tenant check
- Thumbs up/down feedback wired into UI (backend exists)
- Light/dark theme toggle
- Multi-pod scaling for pod mode
- Feedback JWT verification on edge function (currently trusts `email` param from client)

## User preferences discovered during the session

- "Keep changes local; only commit/push when explicitly asked" — saved to memory
- "Maintain CHANGELOG.md" — saved to memory
- "Pods terminated not paused" — implemented
- "Gallery button next to History on landing" — done
- "PhonePe first" — done

## Notes for future sessions

- `supabase functions deploy server` is the standard deploy command. No docker needed.
- Supabase CLI is logged in but doesn't have permission to set secrets — user must do that via the dashboard.
- User's anon key is at `utils/supabase/info.tsx` (committed; it's a public anon key).
- Vercel auto-deploys from `main` — the Vercel CLI sometimes deploys with a stale cache; `npx vercel --prod --force` works reliably.
- LORA-TRAINING is a real pod on the RunPod account — never touch it.
