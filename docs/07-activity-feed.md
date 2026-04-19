# 07 — Activity Feed (bottom-left live view)

A small free-floating text display in the bottom-left corner showing what's actively generating across the team **right now**. Not to be confused with the personal history panel in the top-right (see [[08-activity-log-history]]).

## Component

File: `src/app/components/activity-feed.tsx`

- Pill button labeled `Activity` with a count badge when jobs are in flight
- Above the button: up to 6 rows of live per-generation status
- Button click toggles show/hide — state saved in `localStorage` under `picasso_activity_feed_hidden`

## Visual

```
EL   · mango icon                ~32s       ← currently generating (spinning loader, green)
priya · cherry blossom           ~1m         ← queued #1 (clock icon, slate)
rahul · space rocket             ~1m 30s    ← queued #2 (clock, slate, slightly faded)
   +2 more                                  ← overflow (count > 6 rows)

[● Activity  3  · ~2m]                       ← toggle button
```

- **Icon only** per row (no "generating" or "queued" text). Spinning loader = running; clock = queued. The state is also in the tooltip.
- **User prefix**, then `·`, then **prompt** (ellipsis-truncated at 220px max).
- **ETA** on the right (per-row).
- Older rows fade progressively (opacity gradient).
- Rows hug content — not fixed width.

## What shows up in the feed

The feed is **only** active + queued generations. Completed / failed / cancelled jobs disappear the moment their terminal event is logged.

`buildInFlight(entries)`:
1. Group KV activity entries by `job_id`
2. Drop any group that has a `generation.completed` / `generation.failed` / `generation.cancelled` event
3. Drop "stale" groups — `generation.requested` older than 10 minutes with no resolution (belt-and-suspenders for cases where a resolve event was never written)
4. Sort remaining by timestamp ascending (oldest first = next in queue)

This is all client-side. The server's `/activity/recent` endpoint just returns recent raw entries.

## ETA math

- Per-row ETA = `(position_in_queue * avg_exec_seconds) / effective_workers`
- `avg_exec_seconds` is the server's rolling average for the current execution mode (pod=1, serverless=active workers)
- Defaults: 30s (pod) / 45s (serverless) if no samples yet
- For pod mode, position 0 → `generating`; for serverless, everyone runs in parallel so "queue" in the traditional sense is fuzzier

## Data source

`GET /activity/recent?limit=50&since={ts}`:
- Scans all `activity_*` KV entries
- Default window: last 30 minutes
- Returns `{ success, entries, count }` sorted by timestamp DESC

The feed polls every 5s when visible, 15s when hidden (so the badge count stays accurate without hammering the endpoint).

## Team-wide vs personal

The feed is **team-wide** — shows events from every user. This is deliberate — useful as a team pulse ("oh Rahul is already generating something like that, let me look at his prompt"). If you want just your own, use the History panel.

## Relationship to the activity log

Both read the same KV keys (`activity_*`). The feed is "live in-flight" (derived by grouping + filtering). The history is "my past" (prefix-scoped to one user).

## Edge cases

- If `logActivity` fails to write, the feed will miss the event. In practice KV is reliable enough that this doesn't happen, but it's fire-and-forget with a try/catch.
- If no user is authenticated (local dev), entries show as `EL` (mock user) or `someone` (no email at all).
- Prompt truncation uses CSS `text-overflow: ellipsis`. If the prompt has no spaces, it'll still truncate at the pixel boundary.
- The badge count (in the button) reflects active + queued. The list shows up to 6; overflow says `+N more`.
