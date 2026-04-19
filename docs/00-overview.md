# Picasso — Project Documentation

PhonePe's internal AI illustration generator. Built on Supabase + Vercel + RunPod. This folder documents every subsystem in detail so you can onboard, debug, or extend without reading all of the code.

## How to read these docs

Each file is self-contained and focuses on one subsystem. Where topics overlap, there are `[[wiki-style]]` links so Obsidian can render the graph.

## Index

- [[00-overview]] — this file
- [[01-image-generation-flow]] — what happens end-to-end when you hit **Send** on a prompt
- [[02-storage]] — every place data lives (Supabase KV, RunPod S3 volume, local React state)
- [[03-gpu-setup]] — Serverless vs Pod mode; how each one actually runs
- [[04-gallery]] — Session / Mine / Team tabs; how images persist
- [[05-conceptualise-and-generate]] — the two phases, how they differ, how the LLM is called
- [[06-loras-and-comfyui]] — LoRA file map by brand+flow, ComfyUI workflow nodes
- [[07-activity-feed]] — bottom-left live feed (team-wide in-flight view)
- [[08-activity-log-history]] — personal history panel (top-right)
- [[09-authentication]] — Google OAuth via Supabase, @phonepe.com gate
- [[10-comfyui-workflow]] — the raw workflow JSONs and what each node does
- [[CHANGELOG]] — full changelog for this project (mirror of `/CHANGELOG.md`)
- [[SESSION-HISTORY]] — recap of everything built in the current Claude session

## Architecture at a glance

```
┌─────────────────┐     ┌────────────────────────────────┐     ┌──────────────┐
│  React / Vite   │────▶│  Supabase Edge Function (Hono) │────▶│  RunPod API  │
│  (Vercel)       │     │  /functions/v1/server/...      │     │  (GraphQL +  │
│                 │◀────│                                │◀────│   S3 + REST) │
└─────────────────┘     └──────┬──────────────┬──────────┘     └──────┬───────┘
         │                     │              │                      │
         │                     ▼              ▼                      ▼
         │              ┌───────────┐  ┌──────────────┐       ┌──────────────┐
         │              │ Supabase  │  │ OpenAI /     │       │ GPU Pod OR   │
         └─────────────▶│ Auth      │  │ Gemini API   │       │ Serverless   │
           Google OAuth │ (Google)  │  │ (via proxy)  │       │ (ComfyUI +   │
                        └───────────┘  └──────────────┘       │  Qwen Image) │
                                                              │   + LoRAs    │
                                                              └──────────────┘
```

## Core trade-offs that shaped the design

- **Two execution modes** — Serverless (scales to zero, cold-starts per request) and Pod (one persistent GPU, fastest for repeat generations). User picks per request. See [[03-gpu-setup]].
- **No API keys in the browser** — everything (OpenAI, RunPod, S3) is proxied through the edge function, which reads from Supabase secrets. Keeps tokens out of client bundles.
- **Stateless server, KV for everything** — the edge function holds no memory. Supabase's `kv_store_1a0af268` table is the source of truth for pod IDs, jobs, activity, gallery mappings, and rolling averages. See [[02-storage]].
- **Concurrent generations** — one session can fire many in parallel; each gets its own chat bubble with its own progress indicator. Backend trusts the queue layer (serverless workers or ComfyUI's own queue) to serialize.
- **Pods terminated, not paused** — idle pods are torn down completely (not just stopped) so there's zero cost while idle. Models + LoRAs persist on a network volume. See [[03-gpu-setup]].

## Key URLs

- Production: <https://design-picasso.vercel.app/>
- Supabase dashboard: <https://supabase.com/dashboard/project/wbpzkcblgoxqtfrduotd>
- Edge function base: `https://wbpzkcblgoxqtfrduotd.supabase.co/functions/v1/server/make-server-1a0af268`
- GitHub: <https://github.com/elsonds/design-picasso>

## Repo layout

```
IllustrationGen (Copy)/
├── src/
│   └── app/
│       ├── App.tsx                        ← top-level, state + routing
│       └── components/
│           ├── prompt-bar.tsx             ← brand tabs, flow chips, split-send button
│           ├── chat-panel.tsx             ← chat bubbles, progress visuals
│           ├── image-grid-panel.tsx       ← gallery (Session/Mine/Team tabs)
│           ├── history-panel.tsx          ← personal activity history
│           ├── activity-feed.tsx          ← bottom-left team pulse
│           ├── execution-mode-dropdown.tsx← Pod/Serverless toggle
│           ├── dropdown-popover.tsx       ← portaled dropdown primitive
│           ├── api-service.ts             ← all edge-function calls
│           ├── llm-service.ts             ← OpenAI chat (streaming)
│           ├── gemini-service.ts          ← Gemini chat (streaming)
│           ├── llm-prompts.ts             ← conceptualise prompt builders
│           ├── prompt-skills.ts           ← brand+flow restructure instructions
│           ├── lora-config.ts             ← brand+flow → LoRA filename + strength
│           ├── brand-logos.tsx            ← SVG logos for Indus/PhonePe/etc.
│           ├── auth-context.tsx           ← Supabase session hook
│           └── types.ts                   ← shared types (ChatMessage, StatusInfo)
├── supabase/
│   └── functions/
│       └── server/
│           ├── index.ts                   ← Hono app, all routes
│           ├── pod.ts                     ← RunPod pod lifecycle (GraphQL)
│           ├── runpod.ts                  ← RunPod serverless + workflow JSON
│           ├── s3.ts                      ← SigV4 S3 client for RunPod volume
│           └── kv.ts                      ← Supabase KV table wrapper
├── index.html                             ← root + modal-root portal target
├── CHANGELOG.md                           ← canonical changelog
└── docs/                                  ← you are here
```
