# 10 — ComfyUI Workflow (raw JSON internals)

The actual diffusion graph that runs inside ComfyUI. Two workflows, embedded in the edge function source. Can be overridden via Supabase KV without redeploying.

## Two workflows

Both live as `Record<string, unknown>` literals in `supabase/functions/server/runpod.ts`:
- `EMBEDDED_DEFAULT_WORKFLOW` — prompt only, no reference image
- `EMBEDDED_CONTROLNET_WORKFLOW` — prompt + reference image

Selected by `getWorkflow(type, params)` where `type = "default" | "controlnet"`.

## Default workflow (prompt-only)

```
              ┌──────────────┐
              │  92:37 UNET  │ qwen_image_2512_bf16.safetensors
              └──────┬───────┘
                     │ model
                     ▼
              ┌──────────────┐
              │ 92:73 LoRA   │ lora_name + strength_model SWAPPED at runtime
              │LoaderModelOnly│
              └──────┬───────┘
                     │ model
                     ▼
              ┌──────────────────────┐
              │ 92:66 ModelSampling  │ shift = 3.1 (AuraFlow tuning)
              │ AuraFlow             │
              └──────┬───────────────┘
                     │ model
                     │
                     ▼
┌────────────┐   ┌───────┐    ┌──────────────┐
│ 103 String │──▶│ 92:6  │───▶│              │
│ Concatenate│   │ CLIP  │    │              │
│ (a + b)    │   │ (pos) │    │              │
└────────────┘   └───────┘    │              │
   │ a=prompt     ▲           │   92:3       │    ┌──────┐    ┌──────┐
   │ b=style     clip         │   KSampler   │───▶│ 92:8 │───▶│  90  │
   │              │           │   30 steps   │    │ VAE  │    │ Save │
   │           ┌──┴───┐       │   CFG 2.5    │    │Decode│    │Image │
   │           │ 92:38│       │   euler      │    └──────┘    └──────┘
   │           │ CLIP │       │   simple     │       ▲
   │           │Loader│       └──────────────┘       │
   │           └──────┘             ▲                │
   │                                │                │
   │                        ┌───────┴─────┐          │
   │                        │  92:7 CLIP  │   ┌──────┴──┐
   │                        │  (negative) │   │  92:39  │
   │                        └─────────────┘   │  VAE    │
   │                        text = SWAPPED    │ Loader  │
   │                                          └─────────┘
   │
   └─ string_a = user prompt (SWAPPED)
   └─ string_b = style description (SWAPPED per brand+flow)
                        
                        ┌──────────────┐
                        │ 92:58 Empty  │ width, height = SWAPPED
                        │ SD3 Latent   │ (1328×1328 default)
                        └──────────────┘
                               │
                               ▼ latent_image ──▶ 92:3
```

### Node reference (default workflow)

| Node ID | class_type | Purpose | Swapped at runtime? |
|---|---|---|---|
| `90` | `SaveImage` | Writes PNG | filename_prefix |
| `92:37` | `UNETLoader` | Base Qwen model | No |
| `92:38` | `CLIPLoader` | Text encoder | No |
| `92:39` | `VAELoader` | VAE | No |
| `92:73` | `LoraLoaderModelOnly` | Applies LoRA to model only | **`lora_name`, `strength_model`** (or node removed if `Generic` brand) |
| `92:66` | `ModelSamplingAuraFlow` | AuraFlow sampler wrapper | No |
| `103` | `StringConcatenate` | Prompt + style | **`string_a` (prompt), `string_b` (style desc)** |
| `92:6` | `CLIPTextEncode` | Positive | No (reads from 103 + 92:38) |
| `92:7` | `CLIPTextEncode` | Negative | **`text` (negative prompt)** |
| `92:58` | `EmptySD3LatentImage` | Latent size | **`width`, `height`** |
| `92:3` | `KSampler` | 30 steps, CFG 2.5, euler/simple | **`seed`** |
| `92:8` | `VAEDecode` | Latent → pixels | No |

Sampler config, hardcoded:
```
steps: 30
cfg: 2.5
sampler_name: "euler"
scheduler: "simple"
denoise: 1
```

### Mapping (used by `applyWorkflowParams`)

```ts
DEFAULT_WORKFLOW_MAPPING = {
  prompt_node: "103",        prompt_field: "string_a",
  seed_node: "92:3",         seed_field: "seed",
  dimensions_node: "92:58",  width_field: "width", height_field: "height",
}
```

## ControlNet workflow

Same base + extra Canny edge → ControlNet chain:

```
   (base model + LoRA chain same as default)
                │
                ▼
         ┌─────────────┐            ┌─────────────┐
         │ 16 Control  │            │ 28 LoadImage │
         │ NetLoader   │            │ image=SWAPPED│
         └──────┬──────┘            └──────┬──────┘
                │                          │
         ┌──────▼──────┐            ┌──────▼──────┐
         │ 22 SetUnion │            │ 23 Canny    │
         │ ControlNet  │            │ 0.4/0.8     │
         │ Type        │            └──────┬──────┘
         └──────┬──────┘                   │
                │                          │
                ▼                          ▼
              ┌────────────────────────────────────────┐
              │ 18 ControlNetApplyAdvanced             │
              │ strength=2, percent 0→1                │
              │ positive/negative → 10 KSampler        │
              └────────────────────────────────────────┘
                                            │
                                            ▼
                                          10 KSampler → 12 VAEDecode → 13 SaveImage
```

### Node reference (ControlNet)

| Node ID | class_type | Purpose | Swapped at runtime? |
|---|---|---|---|
| `1` | `UNETLoader` | Qwen model | No |
| `2` | `CLIPLoader` | Text encoder | No |
| `3` | `VAELoader` | VAE | No |
| `5` | `LoraLoaderModelOnly` | LoRA | **`lora_name`, `strength_model`** (strength_model=1.5 default — higher than plain generation because ControlNet constrains structure) |
| `6` | `CLIPTextEncode` | Positive | **`text` (full prompt)** — note: style description is baked into the prompt text here, not a separate concat |
| `7` | `CLIPTextEncode` | Negative | **`text`** (negative prompt) |
| `10` | `KSampler` | 30 steps, CFG 2.5, euler | **`seed`** |
| `11` | `EmptyLatentImage` | Latent size | **`width`, `height`** |
| `12` | `VAEDecode` | Latent → pixels | No |
| `13` | `SaveImage` | Writes PNG | No |
| `16` | `ControlNetLoader` | ControlNet model | No |
| `18` | `ControlNetApplyAdvanced` | Applies ControlNet | No (strength=2, full range) |
| `22` | `SetUnionControlNetType` | Sets to `canny/lineart/anime_lineart/mlsd` | No |
| `23` | `Canny` | Edge detection on reference | No (thresholds 0.4/0.8) |
| `25` | `PreviewImage` | Shows canny preview | No |
| `28` | `LoadImage` | Reference image | **`image` (filename)** |

### Mapping (ControlNet)

```ts
CONTROLNET_WORKFLOW_MAPPING = {
  prompt_node: "6",          prompt_field: "text",
  seed_node: "10",           seed_field: "seed",
  dimensions_node: "11",     width_field: "width", height_field: "height",
  image_node: "28",          image_field: "image",
}
```

## Runtime param injection

`applyWorkflowParams(workflow, mapping, { prompt, seed, width, height, imageFilename })`:

1. Deep-clone the workflow (`JSON.parse(JSON.stringify(...))`) so the embedded source isn't mutated
2. Set `workflow[mapping.prompt_node].inputs[mapping.prompt_field] = prompt`
3. Set seed, width, height similarly
4. If ControlNet, set image filename
5. Return the cloned workflow

Then `applyLoraConfig(wf, loraNodeId, lora_name, lora_strength)`:
- If `lora_name`: just sets `inputs.lora_name` + `inputs.strength_model`
- If `lora_name` is null (Generic brand): removes the LoRA loader node entirely and rewires any downstream references to point at the UNET directly

Finally, in `/comfyui/generate` handler, the brand+flow **style description** (default) and **negative prompt** (both) are overridden:

```ts
// default workflow
workflow["103"].inputs.string_b = getStyleDescription(brand, flow)
workflow["92:7"].inputs.text = getNegativePrompt(flow)

// controlnet workflow
workflow["7"].inputs.text = getNegativePrompt(flow)
```

## Overriding the whole workflow

`POST /comfyui/workflow/upload` with body `{ workflow, type, mapping? }` stores the JSON in KV at `indus_workflow_default` or `indus_workflow_controlnet`. `getWorkflow()` checks KV first and uses the stored workflow if present. Useful for:
- A/B testing a new graph without deploying
- Swapping in a community node graph from ComfyUI UI export
- Temporary fixes before landing in code

Pass `mapping` if the new workflow uses different node IDs for prompt/seed/dimensions.

## Why embedded and not a .json file?

The edge function is deployed as a single bundle to Supabase — easier to ship the JSON as a TS literal than to try to bundle a .json file. Also makes it trivially diffable in git.

## Known frictions

- **The embedded default `string_b` is the PhonePe-icon style by default** — fine because it's always overridden at runtime, but if the override ever skips, you'd get PhonePe-style output regardless of brand. Keep `getStyleDescription` in sync.
- **Sampler params are hardcoded** (steps, cfg, sampler, scheduler). Changing them requires a redeploy — there's no KV override for the `indus_workflow_config` fields even though the endpoint exists.
- **No prompt validation.** If the user prompt is empty the workflow still runs (producing garbage).
