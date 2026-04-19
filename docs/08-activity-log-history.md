# 08 — Activity Log / History Panel (top-right)

Personal history of generations. Every request, completion, failure, and cancellation is written to Supabase KV keyed by user email. The History panel (top-right) shows the current user's entries. The [[07-activity-feed]] in the bottom-left reads the same KV space but shows team-wide in-flight status only.

## Where and when entries are written

File: `supabase/functions/server/index.ts` — `logActivity(entry)` helper.

Fires at four points:

| Event | Where | What's attached |
|---|---|---|
| `generation.requested` | After `queuePrompt` (pod) or `submitServerlessJob` (serverless) in `/comfyui/generate` | prompt, style, flow, mode, width, height, lora_name, execution_mode, user_id, email, **job_id**, timestamp |
| `generation.completed` | `/comfyui/status/:jobId` when the job finishes (both modes) | Everything above + **execution_time**, final seed, resolved width/height |
| `generation.failed` | Same endpoint, on FAILED/CANCELLED/TIMED_OUT from RunPod | Above + **error** string |
| `generation.cancelled` | `/comfyui/cancel/:jobId` explicit cancel | Metadata from KV when available, client-hinted values when not |

The `requested` event is deliberately logged AFTER the job is queued (not at the top of the handler) so 503 retry loops during pod startup don't produce duplicate rows.

## Storage format

```
Key:    activity_{email}_{timestamp}_{jobId}
Value:  { user_id, email, event, job_id, execution_mode, prompt, style, flow,
          mode, seed, width, height, lora_name, execution_time, error, timestamp }
```

Entries are never deleted — the log grows over time. Cleanup is a future task.

One side-effect: on `generation.completed` with a valid `execution_time` and `execution_mode`, `logActivity` also updates the rolling EMA (`avg_exec_time_{mode}`) used for ETA estimates.

## History panel UI

File: `src/app/components/history-panel.tsx`

- Opens as a right-side slide-in (420px) with a dimmed backdrop
- Triggered from the **History** icon in the chat header and the History pill on the landing page
- Email shown at the top of the panel
- Each entry is grouped by `job_id` so you see one row per generation (even though there are multiple events per)
- Icon per row:
  - ✅ green — completed
  - ❌ red — failed
  - 🕐 amber — still pending (request logged, no resolution yet)
- Shows: prompt text, relative timestamp, mode chip (pod/serverless), style chip, flow chip, optional ControlNet chip, execution time, failed error message if present, seed + resolution

## Data flow

```
handleToggleHistory  ──►  setHistoryOpen(true)
                              │
                              ▼
              HistoryPanel useEffect
                              │
                              ▼
              fetchUserHistory(email, limit=100)
                              │
                              ▼
      GET /user/history?email=...&limit=100
                              │
                              ▼
         kv.getByPrefix(`activity_${email}_`)
                 → sort desc by timestamp
                 → return top N
```

Rendered via `groupByJob()` which stacks events by `job_id` and picks the "most informative" (completed > failed > requested) as the primary display.

## Endpoints

- `GET /user/history?email={email}&limit={n}` — a user's own history (email-filtered prefix scan)
- `GET /activity/recent?limit={n}&since={ts}` — global recent (used by the [[07-activity-feed]])

Both return `{ success, entries, count }`.

## Feedback (thumbs up / down)

Partially built out — the backend has `/feedback`, `/feedback/batch` endpoints writing `feedback_vote_{jobId}_{email}` and `feedback_count_{jobId}`. The UI to call this isn't wired up yet. Skeleton preserved for future work.

## Differences from the [[07-activity-feed]]

|  | Activity Feed (bottom-left) | History Panel (top-right) |
|---|---|---|
| Scope | Team-wide | Your own only |
| Content | In-flight + queued only | Everything, including resolved |
| Grouping | By job_id, latest state | By job_id, completed/failed/requested merged |
| Lifetime | Removed the moment a job resolves | Forever (no cleanup) |
| Source data | Same KV keys | Same KV keys |
| Purpose | "What's happening right now" | "What have I done recently" |

Both are read-only views over the same `activity_*` namespace.
