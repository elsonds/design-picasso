# 04 — Gallery

Every successful generation is saved to the RunPod network volume and surfaced in the gallery panel. Three tabs, one storage backend.

## UI

Component: `src/app/components/image-grid-panel.tsx`

- Accessible via the **Images** icon in the chat-panel header, and a pill button top-right on the landing page.
- Slides in from the right, 420px wide, dim backdrop.
- Contains three tabs: **Session / Mine / Team**
- Header has a **Save all** (`FolderDown` icon) that downloads every image in the current tab to the user's filesystem.

### Tabs

| Tab | Source | Lifetime |
|---|---|---|
| **Session** | React state `generatedImages` in `App.tsx` | This tab only, lost on refresh |
| **Mine** | `GET /gallery/mine?email=...` | Persistent — everything you've generated, ever |
| **Team** | `GET /gallery/team` | Persistent — everything everyone has generated |

Session is an instant-feedback view of the current browsing session. Mine and Team fetch from the persistent store.

### Card contents

- Image thumbnail (lazy-loaded 24 at a time for persistent tabs)
- Prompt text (ellipsis if > 11px × container width)
- On Team tab: `username · N minutes ago`
- On hover: **Download**, **Copy prompt**, **Expand** (fullscreen) buttons
- Footer (when card selected): seed, resolution, execution time

### Copy prompt

Two places:
1. Hover overlay: Copy icon next to Download/Expand
2. Under the image: small copy icon next to the prompt text

Uses `navigator.clipboard.writeText(prompt)`. Shows green ✓ for 1.5s on success.

## Storage (the persistent path)

Detailed in [[02-storage]]. Summary:

- **Bytes**: `gallery/{email-prefix}/{jobId}.png` on the RunPod network volume
- **Metadata**: `gallery_{email}_{timestamp}_{jobId}` in Supabase KV

### Writing

On successful `generation.completed` (in `/comfyui/status/:jobId` handler), the edge function calls `saveToGallery`:

```ts
async function saveToGallery({ imageDataUrl, jobId, email, prompt, style, flow, mode, seed, ... }) {
  const userPart = (email || "anon").split("@")[0]
  const key = `gallery/${userPart}/${jobId}.png`
  // base64 → Uint8Array → putObject(key, bytes, "image/png")
  await putObject(key, bytes)
  // write mapping
  await kv.set(`gallery_${email || "anon"}_${Date.now()}_${jobId}`, entry)
}
```

- Only fires on success — failed and cancelled generations are NOT saved.
- S3 PUT uses SigV4 from `supabase/functions/server/s3.ts`.
- Errors are logged but never block the main completion path (the user still gets their image).

### Reading

#### List (KV prefix scan)

- `GET /gallery/mine?email={email}&limit=50` → filters `gallery_{email}_*`
- `GET /gallery/team?limit=50` → scans all `gallery_*`

Both sort by timestamp DESC and return the most recent entries:

```ts
{
  success: true,
  entries: GalleryEntry[],
  count: number
}
```

#### Fetch image (S3 proxy)

`GET /gallery/image?key={key}`:
1. Validates `key` starts with `gallery/` (simple tenancy guard)
2. Fetches bytes via `getObject(key)`
3. Base64 encodes in chunks (8KB chunks to avoid call-stack limits on large images)
4. Returns `{ success: true, image: "data:image/png;base64,..." }`

This proxy design keeps RunPod S3 credentials entirely server-side. Also avoids CORS.

## Gallery tab rendering flow

```
User clicks gallery icon
  │
  ▼
setGridPanelOpen(true)                        [App.tsx]
  │
  ▼
ImageGridPanel opens                          [image-grid-panel.tsx]
  │
  │ if scope === 'session':
  ├──► displayed = [...images].reverse()      // from React state only
  │
  │ if scope === 'mine' | 'team':
  ├──► fetchGallery(scope, email)             // API call
  │     returns GalleryEntry[]
  ├──► lazy-load thumbs 24 at a time via fetchGalleryImage(key)
  │     → stores data URLs in `thumbs` state
  └──► display with progressive loading
```

## Save-all

The header's `FolderDown` button iterates through whatever the current tab shows and triggers an `<a download>` click for each, with a 250ms delay between them. Works for all three tabs.

Filename pattern: `{brand}-{seed || id}.png`.

## Edge cases

- **Old images**: anything generated before gallery persistence was rolled out (commit "Persistent gallery on RunPod network volume") is NOT in the store. Only new generations since that deploy are available on Mine/Team.
- **Team limit**: currently capped at 50 entries per page. Paging not implemented yet — infinite scroll would be a follow-up.
- **Tenancy**: the edge function trusts the client's `email` query param. Anyone with the anon key can fetch any user's gallery by guessing emails. Not critical for an internal @phonepe.com tool, but it's a known gap.
- **Deletion**: no UI for deleting an image. Would require removing both the KV entry and the S3 object. Not implemented.
