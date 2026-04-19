# 05 — Conceptualise and Generate

The two phases of prompt handling. User picks via the split-send button's dropdown: **Auto**, **Conceptualise**, or **Generate**.

## Phase selection

Component: `src/app/components/prompt-bar.tsx` — the split send button has a left half (dropdown: `Auto / Conceptualise / Generate`) and a right half (arrow = submit).

- **Auto** (`selectedPhase = null`): `App.tsx::detectPhase` decides. Current implementation: **always returns "generate"**. There's a placeholder for keyword-based auto-switching, not wired up. Effectively, Auto = Generate.
- **Conceptualise**: LLM brainstorms concept options the user picks from before generating
- **Generate**: Skip straight to image generation

Flow is chosen separately via the Icon/Spot/Banner chips and is independent of phase.

## Generate phase

The image-generation path documented in [[01-image-generation-flow]]. TL;DR:

1. Possibly restructure the prompt via LLM (`getRestructureSkill(brand, flow)` in `prompt-skills.ts`)
2. Call `generateImage(...)` → edge function → RunPod → ComfyUI
3. Display image in the chat

## Conceptualise phase

Used when the user wants options — they describe a vague brief, the LLM returns 3–5 "concept cards", the user picks one, then it generates.

### Sub-flow

Implemented in `App.tsx::handleSend`:

1. `buildConceptualiseMessages(prompt, brand, flow)` → array of OpenAI/Gemini-format messages
2. `streamChat(messages, config, onChunk)` or `streamGeminiChat(...)`:
   - Calls `POST /llm/chat` on the edge function with `stream: true`
   - Edge function forwards to OpenAI or Gemini and pipes the SSE stream back
   - Each token appended to the bot message in real time
3. Full response is then parsed by `parseConcepts(fullResponse)` which expects a JSON block with a `concepts` array
4. If parse succeeds, the raw LLM output is replaced with a system message tagged `{ type: "concepts", concepts: [...] }`
5. `ChatPanel` renders that system message as concept cards (Wand2 icon + title + description + "Generate" button)
6. Clicking "Generate" on a concept calls `handleGenerateFromConcept(concept)` which triggers a Generate-phase run using the concept's `prompt` field

### Concept data shape

```ts
interface Concept {
  title: string;        // short headline
  description: string;  // one-liner
  prompt: string;       // the actual prompt to send to Qwen if the user picks this concept
  flow?: 'icon' | 'banner' | 'spot'; // stamped when the concept is created
}
```

### LLM proxy

Files:
- Frontend: `src/app/components/llm-service.ts` (OpenAI), `src/app/components/gemini-service.ts` (Gemini)
- Edge: `app.post("/llm/chat", ...)` in `supabase/functions/server/index.ts`

Both frontend services:
- POST to the proxy with `{ messages, provider, model, temperature, maxTokens, stream }`
- Parse Server-Sent Events line by line, call `onChunk(delta)` for each
- Return the full accumulated text

The edge function accepts the API key under multiple env var names so you don't have to rename existing Supabase secrets:
- OpenAI: `OPENAI_API_KEY` → `Picasso` → `picasso`
- Gemini: `GEMINI_API_KEY` → `Gemini` → `gemini`

Used in two places:
1. **Conceptualise streaming** — during the Conceptualise phase, LLM output is piped into the chat bubble in real time.
2. **Prompt restructuring** (Generate phase) — if the brand+flow combo has a `restructureSkill` defined in `prompt-skills.ts`, the raw prompt is rewritten by the LLM into a Qwen-friendly structured prompt **before** being sent to ComfyUI. Non-streaming here — just request/response.

### Prompt skills

File: `src/app/components/prompt-skills.ts`

Dictionary keyed by `brand-flow` (e.g. `indus-icon`, `phonepe-icon`). Each value is a system prompt that tells the LLM how to reshape a casual user prompt into a workflow-ready one (detailed style instructions, lighting, composition, etc.). This is how we get brand-consistent output even when users type one-word prompts.

When no skill is defined for a given combo, generation uses the raw prompt as-is.

### Conceptualise prompt builders

File: `src/app/components/llm-prompts.ts`

`buildConceptualiseMessages(brief, brand, flow)` returns:

```ts
[
  { role: "system", content: "... brand-specific + flow-specific system prompt ..." },
  { role: "user", content: "Brief: " + brief }
]
```

The system prompt instructs the LLM to output a JSON block with 3–5 concept cards. `parseConcepts` finds the JSON block in the reply (tolerant of ```json fences) and returns the array.

## Pitfalls

- **LLM must return parseable JSON for Conceptualise to work.** If the model hallucinates plain text, `parseConcepts` returns null and the UI just shows the raw streamed text instead of concept cards.
- **Streaming SSE parsing is fragile.** Both `streamChat` and `streamGeminiChat` handle partial line buffering manually; any malformed chunk is silently dropped.
- **Same LLM key powers both Conceptualise and prompt restructuring.** If the key is missing or quota-exhausted, both paths break.
- **No retry on LLM errors.** A single 429 fails the whole generation. We log a warning and fall back to the raw prompt for restructuring, but Conceptualise just errors out.
