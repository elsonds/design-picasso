# 06 — LoRAs and ComfyUI

How brand choice translates into a specific LoRA weight being loaded, and how style descriptions are swapped per brand+flow combo. Covers the base model stack too.

## The model stack

Running on the pod (or serverless worker), ComfyUI loads:

| File | Purpose | Location on volume |
|---|---|---|
| `qwen_image_2512_bf16.safetensors` | Base diffusion UNET (Qwen Image, 2512 build, bf16) | `ComfyUI/models/unet/` |
| `qwen_2.5_vl_7b_fp8_scaled.safetensors` | CLIP / text encoder (Qwen 2.5 VL 7B, fp8) | `ComfyUI/models/clip/` |
| `qwen_image_vae.safetensors` | VAE for decoding latents | `ComfyUI/models/vae/` |
| `{lora-name}.safetensors` | Per-brand LoRA layered on top | `ComfyUI/models/loras/` |
| `diffusion_pytorch_model.safetensors` | Union ControlNet (ControlNet mode only) | `ComfyUI/models/controlnet/` |

## LoRA map

File: `src/app/components/lora-config.ts` — the single source of truth for picking a LoRA.

```ts
"Indus": {
  icon:   { lora_name: "indus-style.safetensors",        strength: 1.00, controlnet_strength: 1.5 },
  banner: { lora_name: "indus-banner-style.safetensors", strength: 1.06, controlnet_strength: 1.5 },
  spot:   { lora_name: "indus-banner-style.safetensors", strength: 1.06, controlnet_strength: 1.5 },
},
"PhonePe": {
  icon:   { lora_name: "ppe_style.safetensors",          strength: 1.00, controlnet_strength: 1.5 },
  banner: { lora_name: "ppe_style.safetensors",          strength: 0.70, controlnet_strength: 1.0 },
  spot:   { lora_name: "ppe_style.safetensors",          strength: 0.80, controlnet_strength: 1.2 },
},
"PhonePe Business": { /* variants of ppe_style */ },
"Share.Market":     { /* uses indus-style with lower strengths */ },
```

- **Generic** brand → `getLoraConfig` returns `null` → no LoRA applied, raw Qwen output.
- Unknown brand combo → `DEFAULT_LORA = indus-style @ 0.6`.
- `controlnet_strength` is used when a reference image is attached (ControlNet path); otherwise plain `strength`.

## How the LoRA ends up in the workflow

File: `supabase/functions/server/runpod.ts`

1. `getWorkflow(type, params)` deep-clones an embedded workflow JSON (there's one default workflow and one ControlNet workflow — see [[10-comfyui-workflow]]).
2. `applyWorkflowParams()` injects `prompt`, `seed`, `width`, `height`, `imageFilename` into the pre-mapped node IDs.
3. `applyLoraConfig(workflow, loraNodeId, lora_name, lora_strength)`:
   - **If lora_name is set**: finds the `LoraLoaderModelOnly` node (`92:73` in default, `5` in ControlNet) and sets its `inputs.lora_name` + `inputs.strength_model`.
   - **If lora_name is null** (Generic brand): removes the LoRA node entirely and rewires its `model` input to whatever other nodes pointed at the LoRA's output. Qwen runs raw.

## Brand + flow style descriptions

Where LoRA handles the visual style, the STYLE DESCRIPTION string handles composition and detail instructions. It's injected into the workflow's `StringConcatenate` node.

In the default workflow, node `103` has:
```json
{
  "class_type": "StringConcatenate",
  "inputs": {
    "string_a": "",              // user prompt goes here
    "string_b": "",              // style description goes here
    "delimiter": ""
  }
}
```

The concatenated string is then fed to the CLIP text encoder.

### Per-combo descriptions

Defined in `runpod.ts::getStyleDescription(brand, flow)`:

| Brand+Flow | String content (truncated) |
|---|---|
| Indus icon | `High-end vector icon, glossy plastic, rounded beveled edges, soft studio lighting from upper-left, ... solid black background` |
| PhonePe icon | `Clean, minimalist, modern UI/UX icon design aesthetic. Orthographic projection, pseudo-3D volumetric effect. Lineless, flat opaque colors, hard-edged cel-shading ... pure white background` |
| (Any brand) banner | `Miniature diorama-style scene ... tilt-shift photography feel, solid black background with vibrant saturated colors` |
| (Any brand) spot | `Clean object-focused composition, stylized 3D render, ... solid black background with vibrant colors` |

The Indus icon has a **black** background, PhonePe a **white** background — this is the single biggest visual differentiator between the brand outputs. The LoRA reinforces these cues but the prompt string sets the baseline.

### Per-flow negative prompts

Also in `runpod.ts::getNegativePrompt(flow)`:

| Flow | Focus |
|---|---|
| icon | Prevents outlines, line art, gradients, photorealism, text/watermark/logo artifacts |
| banner | Prevents text/watermark, flat-2D, sketch, photorealism |
| spot | Prevents text/watermark, complex backgrounds, photorealism |

All three also append a `SAFETY_NEGATIVE` suffix (nsfw, gore, violence, etc.)

### Where they're applied

In the `POST /comfyui/generate` handler (`index.ts`), after `getWorkflow` returns the workflow JSON:

```ts
if (workflowType === "default") {
  workflow["103"].inputs.string_b = styleDesc;       // style
  workflow["92:7"].inputs.text = negPrompt;          // CLIP negative
} else { // controlnet
  workflow["7"].inputs.text = negPrompt;             // negative only — style is part of the prompt text directly
}
```

This is why the same user prompt (`mango`) produces different images for Indus vs PhonePe — both the LoRA and the `string_b` differ.

## ComfyUI custom nodes

The workflows reference these node classes. They must be installed on the pod's ComfyUI:

- `UNETLoader` — loads the Qwen Image UNET
- `CLIPLoader` — loads the text encoder
- `VAELoader` — loads the VAE
- `LoraLoaderModelOnly` — applies a LoRA only to the model (not CLIP)
- `ModelSamplingAuraFlow` — AuraFlow-style model sampling (Qwen-specific)
- `CLIPTextEncode` — encodes text prompts
- `StringConcatenate` — concatenates prompt + style description
- `KSampler` — the actual diffusion sampler
- `EmptySD3LatentImage` / `EmptyLatentImage` — dimension setup
- `VAEDecode` — decodes latents to pixels
- `SaveImage` — writes PNG
- **ControlNet only**: `ControlNetLoader`, `ControlNetApplyAdvanced`, `SetUnionControlNetType`, `Canny`, `LoadImage`, `PreviewImage`

The custom nodes for ComfyUI that provide these should be installed on the network volume as part of the initial pod setup.

## Why two workflows?

**Default workflow** (`EMBEDDED_DEFAULT_WORKFLOW` in `runpod.ts`) — prompt-only. No reference image. Uses `EmptySD3LatentImage`.

**ControlNet workflow** (`EMBEDDED_CONTROLNET_WORKFLOW`) — prompt + reference image. Uses `LoadImage` → `Canny` edge detection → `ControlNetApplyAdvanced` to constrain the generation to the reference's structure.

The generate handler picks one based on `hasReference = reference_image && mode === "controlnet"`.

## Overriding workflows without redeploying

`getWorkflow` first checks KV for a custom workflow at `indus_workflow_default` or `indus_workflow_controlnet`. If present, uses that instead of the embedded JSON. This lets you upload a new workflow via `POST /comfyui/workflow/upload` and switch immediately — useful for A/B testing or fixing a bug without a full deploy.

If the uploaded workflow uses different node IDs, pass a `mapping` override in the request body to update `DEFAULT_WORKFLOW_MAPPING` accordingly.
