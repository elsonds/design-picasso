import type { StatusInfo, PodStatus } from "./types";
import { supabaseUrl, supabaseKey } from "./supabase-client";

// ─── Supabase Edge Function Base URL ────────────────────────────────────────
const SUPABASE_FUNCTIONS_BASE = `${supabaseUrl}/functions/v1/server/make-server-1a0af268`;

function supabaseHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${supabaseKey}`,
  };
}

// ─── Icon Workflow (from old working Supabase/Flask pipeline) ─────────────────
// Uses node 91 (PrimitiveStringMultiline) for prompt — single string to CLIP.
// No StringConcatenate. Prompt template baked into the string at runtime.
//
// Node map:
//   91   — PrimitiveStringMultiline: full formatted prompt goes here
//   92:6 — CLIP positive prompt (reads from 91)
//   92:7 — CLIP negative prompt (hardcoded)
//   92:3 — KSampler (seed, steps=30, cfg=2.5, euler, simple)
//   92:73 — LoRA loader (swapped per brand)
//   92:66 — ModelSamplingAuraFlow (shift=3.1)
//   92:58 — EmptySD3LatentImage (dimensions)
//   92:37 — UNETLoader (qwen_image_2512_bf16)
//   92:38 — CLIPLoader (qwen_2.5_vl_7b_fp8_scaled)
//   92:39 — VAELoader (qwen_image_vae)
//   92:8  — VAEDecode
//   90    — SaveImage

const ICON_WORKFLOW: Record<string, unknown> = {
  "90": {
    inputs: { filename_prefix: "Qwen-Image-2512", images: ["92:8", 0] },
    class_type: "SaveImage",
    _meta: { title: "Save Image" },
  },
  "91": {
    inputs: { value: "" },
    class_type: "PrimitiveStringMultiline",
    _meta: { title: "Prompt" },
  },
  "92:66": {
    inputs: { shift: 3.1000000000000005, model: ["92:73", 0] },
    class_type: "ModelSamplingAuraFlow",
    _meta: { title: "ModelSamplingAuraFlow" },
  },
  "92:8": {
    inputs: { samples: ["92:3", 0], vae: ["92:39", 0] },
    class_type: "VAEDecode",
    _meta: { title: "VAE Decode" },
  },
  "92:58": {
    inputs: { width: 1328, height: 1328, batch_size: 1 },
    class_type: "EmptySD3LatentImage",
    _meta: { title: "EmptySD3LatentImage" },
  },
  "92:6": {
    inputs: { text: ["91", 0], clip: ["92:38", 0] },
    class_type: "CLIPTextEncode",
    _meta: { title: "CLIP Text Encode (Positive Prompt)" },
  },
  "92:7": {
    inputs: {
      text: "Photorealistic, flat design, hand-drawn, sketch, noise, grain, rough texture, fabric, metal scratches, hard reflections, dull colors, thin outlines, outline-only, background scenery, clutter, text artifacts, watermark.",
      clip: ["92:38", 0],
    },
    class_type: "CLIPTextEncode",
    _meta: { title: "CLIP Text Encode (Negative Prompt)" },
  },
  "92:3": {
    inputs: {
      seed: 0,
      steps: 30,
      cfg: 2.5,
      sampler_name: "euler",
      scheduler: "simple",
      denoise: 1,
      model: ["92:66", 0],
      positive: ["92:6", 0],
      negative: ["92:7", 0],
      latent_image: ["92:58", 0],
    },
    class_type: "KSampler",
    _meta: { title: "KSampler" },
  },
  "92:73": {
    inputs: {
      lora_name: "indus-style.safetensors",
      strength_model: 1,
      model: ["92:37", 0],
    },
    class_type: "LoraLoaderModelOnly",
    _meta: { title: "LoraLoaderModelOnly" },
  },
  "92:37": {
    inputs: {
      unet_name: "qwen_image_2512_bf16.safetensors",
      weight_dtype: "default",
    },
    class_type: "UNETLoader",
    _meta: { title: "Load Diffusion Model" },
  },
  "92:38": {
    inputs: {
      clip_name: "qwen_2.5_vl_7b_fp8_scaled.safetensors",
      type: "qwen_image",
      device: "default",
    },
    class_type: "CLIPLoader",
    _meta: { title: "Load CLIP" },
  },
  "92:39": {
    inputs: { vae_name: "qwen_image_vae.safetensors" },
    class_type: "VAELoader",
    _meta: { title: "Load VAE" },
  },
};

// ─── PhonePe Icon Workflow (from ComfyUI export — uses StringConcatenate) ────
// Uses node 103 (StringConcatenate) with a prompt prefix + style description.
// The style says "pure white background" — different from Indus icon (black bg).
// UNET: qwen_image_2512_bf16 (same as Indus icon), steps=30, cfg=2.5, euler.

const PPE_ICON_PROMPT_PREFIX = "Generate a highly stylized, 3D isometric vector-style illustration of ";

const PPE_ICON_STYLE_DESC =
  "The artistic execution must strictly adhere to a clean, minimalist, and modern UI/UX icon design aesthetic. The perspective must be an orthographic projection, creating a distinct pseudo-3D volumetric effect without any natural perspective distortion or vanishing points. The visual language is entirely lineless, meaning there are absolutely no outlines, strokes, or sketched borders; every form and volume is defined purely through the precise juxtaposition of solid color blocks. The color palette must be exceptionally vibrant, utilizing flat, opaque colors with a slight pastel or soft undertone, avoiding any use of smooth gradients, blending, or textured brushwork. Shading is achieved through a stark, hard-edged cel-shading technique, dividing the object into clear zones of bright highlight, solid mid-tone, and deep shadow. The shadows should be rendered as crisp, dark, desaturated geometric shapes that ground the forms, while highlights should appear as sharp, flat, bright polygons or stylized four-pointed star glints to suggest a smooth, matte, plastic-like surface finish. The proportions of the object should be chunky, simplified, and playful, featuring heavily rounded corners and exaggerated, thick geometry that abstracts the subject into its most basic, recognizable geometric components. The final image must look like a premium, professionally crafted digital asset, completely smooth and textureless, isolated on a pure white background, perfectly embodying the contemporary, flat-design-evolved-to-3D corporate illustration trend.";

const PPE_ICON_NEGATIVE =
  "outlines, strokes, line art, sketch, crosshatching, smooth gradients, airbrush, glossy plastic, PBR, photorealistic, realistic texture, noise, grain, dithering, complex background, scenery, ground plane, cast shadow blob, harsh rim light, metallic chrome, glass refraction, text, watermark, logo, multiple unrelated objects, inconsistent perspective, wrong viewing angle, front orthographic only, muddy colors, low resolution, blur, jpeg artifacts";

const PPE_ICON_WORKFLOW: Record<string, unknown> = {
  "90": {
    inputs: { filename_prefix: "Qwen-Image-2512", images: ["92:8", 0] },
    class_type: "SaveImage",
    _meta: { title: "Save Image" },
  },
  "103": {
    inputs: {
      string_a: "",
      string_b: PPE_ICON_STYLE_DESC,
      delimiter: "",
    },
    class_type: "StringConcatenate",
    _meta: { title: "Concatenate" },
  },
  "92:66": {
    inputs: { shift: 3.1000000000000005, model: ["92:73", 0] },
    class_type: "ModelSamplingAuraFlow",
    _meta: { title: "ModelSamplingAuraFlow" },
  },
  "92:8": {
    inputs: { samples: ["92:3", 0], vae: ["92:39", 0] },
    class_type: "VAEDecode",
    _meta: { title: "VAE Decode" },
  },
  "92:58": {
    inputs: { width: 1328, height: 1328, batch_size: 1 },
    class_type: "EmptySD3LatentImage",
    _meta: { title: "EmptySD3LatentImage" },
  },
  "92:6": {
    inputs: { text: ["103", 0], clip: ["92:38", 0] },
    class_type: "CLIPTextEncode",
    _meta: { title: "CLIP Text Encode (Positive Prompt)" },
  },
  "92:7": {
    inputs: {
      text: PPE_ICON_NEGATIVE,
      clip: ["92:38", 0],
    },
    class_type: "CLIPTextEncode",
    _meta: { title: "CLIP Text Encode (Negative Prompt)" },
  },
  "92:3": {
    inputs: {
      seed: 0,
      steps: 30,
      cfg: 2.5,
      sampler_name: "euler",
      scheduler: "simple",
      denoise: 1,
      model: ["92:66", 0],
      positive: ["92:6", 0],
      negative: ["92:7", 0],
      latent_image: ["92:58", 0],
    },
    class_type: "KSampler",
    _meta: { title: "KSampler" },
  },
  "92:73": {
    inputs: {
      lora_name: "ppe_style.safetensors",
      strength_model: 1,
      model: ["92:37", 0],
    },
    class_type: "LoraLoaderModelOnly",
    _meta: { title: "LoraLoaderModelOnly" },
  },
  "92:37": {
    inputs: {
      unet_name: "qwen_image_2512_bf16.safetensors",
      weight_dtype: "default",
    },
    class_type: "UNETLoader",
    _meta: { title: "Load Diffusion Model" },
  },
  "92:38": {
    inputs: {
      clip_name: "qwen_2.5_vl_7b_fp8_scaled.safetensors",
      type: "qwen_image",
      device: "default",
    },
    class_type: "CLIPLoader",
    _meta: { title: "Load CLIP" },
  },
  "92:39": {
    inputs: { vae_name: "qwen_image_vae.safetensors" },
    class_type: "VAELoader",
    _meta: { title: "Load VAE" },
  },
};

// ─── Banner/Spot Workflow (from ComfyUI export — uses StringConcatenate) ─────
// Uses node 103 (StringConcatenate) to combine user prompt (string_a) with
// style description (string_b). Different sampler/steps/negative from icon.
//
// Node map:
//   103  — StringConcatenate: string_a = user prompt, string_b = style desc
//   92:6 — CLIP positive (reads from 103)
//   92:7 — CLIP negative (new detailed negative)
//   92:3 — KSampler (seed, steps=20, cfg=3.5, euler_ancestral, simple)
//   92:73 — LoRA loader (indus-banner-style @ 1.06)
//   92:66 — ModelSamplingAuraFlow (shift=3.1)
//   92:58 — EmptySD3LatentImage (1664×928 for banner, square for spot)
//   92:37 — UNETLoader (qwen_image_edit_2509_fp8_e4m3fn)
//   92:38 — CLIPLoader
//   92:39 — VAELoader
//   92:8  — VAEDecode
//   90    — SaveImage

const BANNER_WORKFLOW: Record<string, unknown> = {
  "90": {
    inputs: { filename_prefix: "Qwen-Image-2512", images: ["92:8", 0] },
    class_type: "SaveImage",
    _meta: { title: "Save Image" },
  },
  "103": {
    inputs: {
      string_a: "",
      string_b: "High-end vector illustration, smooth glossy plastic material, rounded edges, thick soft outline lighter than fill, vibrant controlled gradients with tinted highlights, soft studio lighting from upper-left, subtle rim light, gentle inner shading for faux depth, short soft drop shadows beneath objects grounding in scene, layered scene composition with distinct foreground midground and background, environmental depth and relative scale, concept-driven thematic arrangement, staged surface and landscape setting, premium modern UI illustration, ultra-clean surface, no texture grain, no realism, highly vectorized minimalisitc human figures and animals in same glossy plastic material with simplified rounded forms, solid black background\n",
      delimiter: "",
    },
    class_type: "StringConcatenate",
    _meta: { title: "Concatenate" },
  },
  "92:39": {
    inputs: { vae_name: "qwen_image_vae.safetensors" },
    class_type: "VAELoader",
    _meta: { title: "Load VAE" },
  },
  "92:38": {
    inputs: {
      clip_name: "qwen_2.5_vl_7b_fp8_scaled.safetensors",
      type: "qwen_image",
      device: "default",
    },
    class_type: "CLIPLoader",
    _meta: { title: "Load CLIP" },
  },
  "92:66": {
    inputs: { shift: 3.1000000000000005, model: ["92:73", 0] },
    class_type: "ModelSamplingAuraFlow",
    _meta: { title: "ModelSamplingAuraFlow" },
  },
  "92:8": {
    inputs: { samples: ["92:3", 0], vae: ["92:39", 0] },
    class_type: "VAEDecode",
    _meta: { title: "VAE Decode" },
  },
  "92:58": {
    inputs: { width: 1664, height: 928, batch_size: 1 },
    class_type: "EmptySD3LatentImage",
    _meta: { title: "EmptySD3LatentImage" },
  },
  "92:6": {
    inputs: { text: ["103", 0], clip: ["92:38", 0] },
    class_type: "CLIPTextEncode",
    _meta: { title: "CLIP Text Encode (Positive Prompt)" },
  },
  "92:7": {
    inputs: {
      text: "photorealistic, 3D, hyperrealistic, photograph, photo, cinematic, film grain, texture grain, wood grain, brick, concrete, noisy, gritty, blurry, soft focus, window view, skyline, cityscape, outdoor scene, landscape photo, natural lighting, dramatic lighting, rim lighting harsh, sharp shadows, flat colors, banding, pixelated, low resolution, cartoon 2D, anime, watercolor, painted, brush strokes, messy, cluttered background, busy background, white background, bright background, daylight, highly detailed, maximallistic",
      clip: ["92:38", 0],
    },
    class_type: "CLIPTextEncode",
    _meta: { title: "CLIP Text Encode (Negative Prompt)" },
  },
  "92:3": {
    inputs: {
      seed: 0,
      steps: 20,
      cfg: 3.5,
      sampler_name: "euler_ancestral",
      scheduler: "simple",
      denoise: 1,
      model: ["92:66", 0],
      positive: ["92:6", 0],
      negative: ["92:7", 0],
      latent_image: ["92:58", 0],
    },
    class_type: "KSampler",
    _meta: { title: "KSampler" },
  },
  "92:73": {
    inputs: {
      lora_name: "indus-banner-style.safetensors",
      strength_model: 1.06,
      model: ["92:37", 0],
    },
    class_type: "LoraLoaderModelOnly",
    _meta: { title: "LoraLoaderModelOnly" },
  },
  "92:37": {
    inputs: {
      unet_name: "qwen_image_2512_bf16.safetensors",
      weight_dtype: "default",
    },
    class_type: "UNETLoader",
    _meta: { title: "Load Diffusion Model" },
  },
};

// ─── Indus Icon Prompt Template (from old working Flask pipeline) ─────────────
const INDUS_ICON_PROMPT_TEMPLATE =
  "High-end vector icon of {subject}, smooth glossy plastic material, rounded and beveled edges, thick soft outline slightly lighter than fill, vibrant controlled gradients with tinted highlights, soft studio lighting from upper-left, subtle rim light, gentle inner shading for faux depth, short soft drop shadow beneath object, floating centered composition with slight perspective tilt, premium modern UI illustration, ultra-clean surface, no texture grain, no realism, solid black background";

// ─── ControlNet Workflow (from ComfyUI API export) ───────────────────────────
// LoRA node "5", prompt node "6", seed node "10", dimensions node "11",
// reference image node "28"

const CONTROLNET_WORKFLOW: Record<string, unknown> = {
  "1": {
    inputs: { unet_name: "qwen_image_2512_bf16.safetensors", weight_dtype: "default" },
    class_type: "UNETLoader",
    _meta: { title: "Load Diffusion Model" },
  },
  "2": {
    inputs: { clip_name: "qwen_2.5_vl_7b_fp8_scaled.safetensors", type: "qwen_image", device: "default" },
    class_type: "CLIPLoader",
    _meta: { title: "Load CLIP" },
  },
  "3": {
    inputs: { vae_name: "qwen_image_vae.safetensors" },
    class_type: "VAELoader",
    _meta: { title: "Load VAE" },
  },
  "5": {
    inputs: { lora_name: "indus-style.safetensors", strength_model: 1.5, model: ["1", 0] },
    class_type: "LoraLoaderModelOnly",
    _meta: { title: "LoraLoaderModelOnly" },
  },
  "6": {
    inputs: { text: "", clip: ["2", 0] },
    class_type: "CLIPTextEncode",
    _meta: { title: "Positive Prompt" },
  },
  "7": {
    inputs: {
      text: "outlines, strokes, line art, sketch, crosshatching, smooth gradients, airbrush, glossy plastic, PBR, photorealistic, realistic texture, noise, grain, dithering, complex background, scenery, ground plane, cast shadow blob, harsh rim light, metallic chrome, glass refraction, text, watermark, logo, multiple unrelated objects, inconsistent perspective, wrong viewing angle, front orthographic only, muddy colors, low resolution, blur, jpeg artifacts",
      clip: ["2", 0],
    },
    class_type: "CLIPTextEncode",
    _meta: { title: "Negative Prompt" },
  },
  "10": {
    inputs: {
      seed: 0, steps: 30, cfg: 2.5, sampler_name: "euler", scheduler: "simple", denoise: 1,
      model: ["5", 0], positive: ["18", 0], negative: ["18", 1], latent_image: ["11", 0],
    },
    class_type: "KSampler",
    _meta: { title: "KSampler" },
  },
  "11": {
    inputs: { width: 1328, height: 1328, batch_size: 1 },
    class_type: "EmptyLatentImage",
    _meta: { title: "Empty Latent Image" },
  },
  "12": {
    inputs: { samples: ["10", 0], vae: ["3", 0] },
    class_type: "VAEDecode",
    _meta: { title: "VAE Decode" },
  },
  "13": {
    inputs: { filename_prefix: "ComfyUI", images: ["12", 0] },
    class_type: "SaveImage",
    _meta: { title: "Save Image" },
  },
  "16": {
    inputs: { control_net_name: "diffusion_pytorch_model.safetensors" },
    class_type: "ControlNetLoader",
    _meta: { title: "Load ControlNet Model" },
  },
  "18": {
    inputs: {
      strength: 2, start_percent: 0, end_percent: 1,
      positive: ["6", 0], negative: ["7", 0], control_net: ["22", 0], image: ["23", 0], vae: ["3", 0],
    },
    class_type: "ControlNetApplyAdvanced",
    _meta: { title: "Apply ControlNet" },
  },
  "22": {
    inputs: { type: "canny/lineart/anime_lineart/mlsd", control_net: ["16", 0] },
    class_type: "SetUnionControlNetType",
    _meta: { title: "SetUnionControlNetType" },
  },
  "23": {
    inputs: { low_threshold: 0.4, high_threshold: 0.8, image: ["28", 0] },
    class_type: "Canny",
    _meta: { title: "Canny" },
  },
  "25": {
    inputs: { images: ["23", 0] },
    class_type: "PreviewImage",
    _meta: { title: "Preview Image" },
  },
  "28": {
    inputs: { image: "input.png" },
    class_type: "LoadImage",
    _meta: { title: "Load Image" },
  },
};

// ─── Banner ControlNet Workflow (sketch-to-illustration) ─────────────────────
// Combines the banner workflow structure (StringConcatenate node 103, banner
// negative prompt, euler_ancestral, steps 20, cfg 3.5) with ControlNet nodes
// (Canny edge detection + ControlNetApplyAdvanced) for sketch-guided generation.
//
// Node map:
//   103  — StringConcatenate: string_a = user prompt, string_b = banner style
//   92:6 — CLIP positive (reads from 103)
//   92:7 — CLIP negative (banner negative)
//   92:3 — KSampler (steps=20, cfg=3.5, euler_ancestral)
//   92:73 — LoRA loader
//   92:66 — ModelSamplingAuraFlow (shift=3.1)
//   92:58 — EmptySD3LatentImage (dimensions)
//   92:37 — UNETLoader
//   92:38 — CLIPLoader
//   92:39 — VAELoader
//   92:8  — VAEDecode
//   90    — SaveImage
//   16    — ControlNetLoader
//   18    — ControlNetApplyAdvanced
//   22    — SetUnionControlNetType
//   23    — Canny edge detector
//   28    — LoadImage (sketch input)

const BANNER_CONTROLNET_WORKFLOW: Record<string, unknown> = {
  "90": {
    inputs: { filename_prefix: "Qwen-Image-2512", images: ["92:8", 0] },
    class_type: "SaveImage",
    _meta: { title: "Save Image" },
  },
  "103": {
    inputs: {
      string_a: "",
      string_b: "High-end vector illustration, smooth glossy plastic material, rounded edges, thick soft outline lighter than fill, vibrant controlled gradients with tinted highlights, soft studio lighting from upper-left, subtle rim light, gentle inner shading for faux depth, short soft drop shadows beneath objects grounding in scene, layered scene composition with distinct foreground midground and background, environmental depth and relative scale, concept-driven thematic arrangement, staged surface and landscape setting, premium modern UI illustration, ultra-clean surface, no texture grain, no realism, highly vectorized minimalisitc human figures and animals in same glossy plastic material with simplified rounded forms, solid black background\n",
      delimiter: "",
    },
    class_type: "StringConcatenate",
    _meta: { title: "Concatenate" },
  },
  "92:39": {
    inputs: { vae_name: "qwen_image_vae.safetensors" },
    class_type: "VAELoader",
    _meta: { title: "Load VAE" },
  },
  "92:38": {
    inputs: {
      clip_name: "qwen_2.5_vl_7b_fp8_scaled.safetensors",
      type: "qwen_image",
      device: "default",
    },
    class_type: "CLIPLoader",
    _meta: { title: "Load CLIP" },
  },
  "92:66": {
    inputs: { shift: 3.1000000000000005, model: ["92:73", 0] },
    class_type: "ModelSamplingAuraFlow",
    _meta: { title: "ModelSamplingAuraFlow" },
  },
  "92:8": {
    inputs: { samples: ["92:3", 0], vae: ["92:39", 0] },
    class_type: "VAEDecode",
    _meta: { title: "VAE Decode" },
  },
  "92:58": {
    inputs: { width: 1664, height: 928, batch_size: 1 },
    class_type: "EmptySD3LatentImage",
    _meta: { title: "EmptySD3LatentImage" },
  },
  "92:6": {
    inputs: { text: ["103", 0], clip: ["92:38", 0] },
    class_type: "CLIPTextEncode",
    _meta: { title: "CLIP Text Encode (Positive Prompt)" },
  },
  "92:7": {
    inputs: {
      text: "photorealistic, 3D, hyperrealistic, photograph, photo, cinematic, film grain, texture grain, wood grain, brick, concrete, noisy, gritty, blurry, soft focus, window view, skyline, cityscape, outdoor scene, landscape photo, natural lighting, dramatic lighting, rim lighting harsh, sharp shadows, flat colors, banding, pixelated, low resolution, cartoon 2D, anime, watercolor, painted, brush strokes, messy, cluttered background, busy background, white background, bright background, daylight, highly detailed, maximallistic",
      clip: ["92:38", 0],
    },
    class_type: "CLIPTextEncode",
    _meta: { title: "CLIP Text Encode (Negative Prompt)" },
  },
  "92:3": {
    inputs: {
      seed: 0,
      steps: 20,
      cfg: 3.5,
      sampler_name: "euler_ancestral",
      scheduler: "simple",
      denoise: 1,
      model: ["92:66", 0],
      positive: ["18", 0],    // Routed through ControlNet
      negative: ["18", 1],    // Routed through ControlNet
      latent_image: ["92:58", 0],
    },
    class_type: "KSampler",
    _meta: { title: "KSampler" },
  },
  "92:73": {
    inputs: {
      lora_name: "indus-banner-style.safetensors",
      strength_model: 1.06,
      model: ["92:37", 0],
    },
    class_type: "LoraLoaderModelOnly",
    _meta: { title: "LoraLoaderModelOnly" },
  },
  "92:37": {
    inputs: {
      unet_name: "qwen_image_2512_bf16.safetensors",
      weight_dtype: "default",
    },
    class_type: "UNETLoader",
    _meta: { title: "Load Diffusion Model" },
  },
  // ── ControlNet nodes ──
  "16": {
    inputs: { control_net_name: "diffusion_pytorch_model.safetensors" },
    class_type: "ControlNetLoader",
    _meta: { title: "Load ControlNet Model" },
  },
  "18": {
    inputs: {
      strength: 2, start_percent: 0, end_percent: 1,
      positive: ["92:6", 0], negative: ["92:7", 0],
      control_net: ["22", 0], image: ["23", 0], vae: ["92:39", 0],
    },
    class_type: "ControlNetApplyAdvanced",
    _meta: { title: "Apply ControlNet" },
  },
  "22": {
    inputs: { type: "canny/lineart/anime_lineart/mlsd", control_net: ["16", 0] },
    class_type: "SetUnionControlNetType",
    _meta: { title: "SetUnionControlNetType" },
  },
  "23": {
    inputs: { low_threshold: 0.4, high_threshold: 0.8, image: ["28", 0] },
    class_type: "Canny",
    _meta: { title: "Canny" },
  },
  "28": {
    inputs: { image: "input.png" },
    class_type: "LoadImage",
    _meta: { title: "Load Image" },
  },
};

// ─── Build workflow with parameters ──────────────────────────────────────────
// The LoRA handles the visual style entirely. The prompt slot just takes the
// user's raw subject/description — no brand prefixes, style suffixes, or
// negative-prompt overrides. The workflow's embedded string_b and negatives
// are already tuned for the LoRA.

function swapLora(
  wf: Record<string, any>,
  loraNodeId: string,
  loraName: string | null,
  loraStrength: number
) {
  if (loraName && loraName.trim()) {
    wf[loraNodeId].inputs.lora_name = loraName;
    wf[loraNodeId].inputs.strength_model = loraStrength;
    console.log(`[Picasso] LoRA SET on node ${loraNodeId}: ${loraName} @ ${loraStrength}`);
  } else {
    // No LoRA — bypass node, rewire model chain
    const modelSource = wf[loraNodeId].inputs.model;
    for (const [nodeId, nodeData] of Object.entries(wf)) {
      if (nodeId === loraNodeId) continue;
      const nd = nodeData as any;
      if (!nd.inputs) continue;
      for (const [key, val] of Object.entries(nd.inputs)) {
        if (Array.isArray(val) && val[0] === loraNodeId) {
          nd.inputs[key] = modelSource;
        }
      }
    }
    delete wf[loraNodeId];
    console.log(`[Picasso] LoRA REMOVED from node ${loraNodeId} (Generic mode)`);
  }
}

// ─── Resize reference image for ControlNet ──────────────────────────────────
// Generated images are 1328×1328 which produces ~8MB base64.
// Downscale to max 1024px to keep RunPod payload reasonable.
function resizeBase64Image(
  dataUrl: string,
  maxSize: number = 1024
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width <= maxSize && height <= maxSize) {
        // Already small enough — return stripped base64
        resolve(dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl);
        return;
      }
      const scale = maxSize / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("Canvas not supported")); return; }
      ctx.drawImage(img, 0, 0, width, height);
      const resized = canvas.toDataURL("image/png");
      resolve(resized.split(",")[1]);
    };
    img.onerror = () => reject(new Error("Failed to load reference image"));
    img.src = dataUrl;
  });
}

// ─── Flow-specific negative prompts ──────────────────────────────────────────
const ICON_NEGATIVE =
  "outlines, strokes, line art, sketch, crosshatching, smooth gradients, airbrush, glossy plastic, PBR, photorealistic, realistic texture, noise, grain, dithering, complex background, scenery, ground plane, cast shadow blob, harsh rim light, metallic chrome, glass refraction, text, watermark, logo, multiple unrelated objects, inconsistent perspective, wrong viewing angle, front orthographic only, muddy colors, low resolution, blur, jpeg artifacts";

const BANNER_NEGATIVE =
  "outlines, strokes, line art, sketch, crosshatching, smooth gradients, airbrush, glossy plastic, PBR, photorealistic, realistic texture, noise, grain, dithering, text, watermark, logo, muddy colors, low resolution, blur, jpeg artifacts, deformed hands, extra fingers, bad anatomy";

const SPOT_NEGATIVE =
  "outlines, strokes, line art, sketch, crosshatching, smooth gradients, airbrush, glossy plastic, PBR, photorealistic, realistic texture, noise, grain, dithering, text, watermark, logo, muddy colors, low resolution, blur, jpeg artifacts, deformed hands, extra fingers, bad anatomy";

function getNegativePrompt(flow: "icon" | "banner" | "spot"): string {
  if (flow === "banner") return BANNER_NEGATIVE;
  if (flow === "spot") return SPOT_NEGATIVE;
  return ICON_NEGATIVE;
}

// ─── Flow-specific style descriptions (concatenated with user prompt in node 103) ──
// These reinforce the LoRA's trained style — without them the model drifts away.

const ICON_STYLE_DESC =
  "The artistic execution must strictly adhere to a clean, minimalist, and modern UI/UX icon design aesthetic. The perspective must be an orthographic projection, creating a distinct pseudo-3D volumetric effect without any natural perspective distortion or vanishing points. The visual language is entirely lineless, meaning there are absolutely no outlines, strokes, or sketched borders; every form and volume is defined purely through the precise juxtaposition of solid color blocks. The color palette must be exceptionally vibrant, utilizing flat, opaque colors with a slight pastel or soft undertone, avoiding any use of smooth gradients, blending, or textured brushwork. Shading is achieved through a stark, hard-edged cel-shading technique, dividing the object into clear zones of bright highlight, solid mid-tone, and deep shadow. The shadows should be rendered as crisp, dark, desaturated geometric shapes that ground the forms, while highlights should appear as sharp, flat, bright polygons or stylized four-pointed star glints to suggest a smooth, matte, plastic-like surface finish. The proportions of the object should be chunky, simplified, and playful, featuring heavily rounded corners and exaggerated, thick geometry that abstracts the subject into its most basic, recognizable geometric components. The final image must look like a premium, professionally crafted digital asset, completely smooth and textureless, isolated on a pure white background, perfectly embodying the contemporary, flat-design-evolved-to-3D corporate illustration trend.";

const BANNER_STYLE_DESC =
  "The artistic execution must strictly adhere to a richly colored, layered isometric diorama-style illustration aesthetic. The scene must feel like a premium 3D miniature world rendered with a stylized, non-photorealistic look. The visual language is entirely lineless — no outlines, strokes, or sketched borders. Every form is defined through solid color blocks, hard-edged cel-shading, and vibrant gradient fills (e.g., magenta-to-purple, orange-to-red, green-to-teal). Textures must be glossy and plastic-like with bright specular highlights rendered as sharp geometric glints. Lighting should create warm, atmospheric glows with strong ambient color bleeding. All elements must have chunky, rounded, slightly exaggerated 3D proportions. The composition must show clear depth layering with distinct foreground, midground, and background planes. Surfaces should appear dark and reflective. The overall image must be rendered on a solid black background with vibrant, saturated colors that pop against the darkness. The style should feel like a premium mobile app illustration — polished, vibrant, and contemporary.";

const SPOT_STYLE_DESC =
  "The artistic execution must strictly adhere to a richly colored, object-composition illustration aesthetic. The composition features 2-5 thematically related objects arranged together — NOT a scene, NOT an environment, just objects. The visual language is entirely lineless — no outlines, strokes, or sketched borders. Every form is defined through solid color blocks, hard-edged cel-shading, and vibrant gradient fills. Textures must be glossy and plastic-like with bright specular highlights as sharp geometric glints. Objects must have chunky, rounded, slightly exaggerated 3D proportions with clear volumetric depth. Colors must be exceptionally vibrant and saturated — use bold gradients (magenta-to-purple, orange-to-red, gold-to-amber). Objects should rest on a dark reflective surface with clear foreground and midground layering. The overall image must be rendered on a solid black background with vibrant colors that pop. The style should feel like a premium mobile app spot illustration — polished, vibrant, and contemporary.";

function getStyleDescription(flow: "icon" | "banner" | "spot"): string {
  if (flow === "banner") return BANNER_STYLE_DESC;
  if (flow === "spot") return SPOT_STYLE_DESC;
  return ICON_STYLE_DESC;
}

function buildDefaultWorkflow(params: {
  prompt: string;
  seed: number;
  width: number;
  height: number;
  loraName: string | null;
  loraStrength: number;
  flow?: "icon" | "banner" | "spot";
}): Record<string, unknown> {
  const flow = params.flow || "icon";

  const isPPE = params.loraName === "ppe_style.safetensors";

  if (flow === "icon" && isPPE) {
    // ── PPE ICON: uses StringConcatenate (node 103) + white background style ──
    const wf = JSON.parse(JSON.stringify(PPE_ICON_WORKFLOW)) as Record<string, any>;
    wf["103"].inputs.string_a = PPE_ICON_PROMPT_PREFIX + params.prompt.trim();

    wf["92:3"].inputs.seed = params.seed;
    wf["92:58"].inputs.width = params.width;
    wf["92:58"].inputs.height = params.height;

    // LoRA is already baked in PPE_ICON_WORKFLOW but update strength if different
    swapLora(wf, "92:73", params.loraName, params.loraStrength);

    console.log("[Picasso] PPE Icon workflow built", {
      lora: wf["92:73"] ? `${wf["92:73"].inputs.lora_name} @ ${wf["92:73"].inputs.strength_model}` : "REMOVED",
      seed: params.seed,
      dims: `${params.width}x${params.height}`,
      prompt: wf["103"].inputs.string_a.substring(0, 100),
    });

    return wf;
  } else if (flow === "icon") {
    // ── INDUS ICON: old working pipeline from Flask/Supabase ──
    // Uses ICON_WORKFLOW with node 91 (PrimitiveStringMultiline).
    // Template: "High-end vector icon of {subject}, ...solid black background"
    const wf = JSON.parse(JSON.stringify(ICON_WORKFLOW)) as Record<string, any>;
    const fullPrompt = INDUS_ICON_PROMPT_TEMPLATE.replace("{subject}", params.prompt.trim());
    wf["91"].inputs.value = fullPrompt;

    wf["92:3"].inputs.seed = params.seed;
    wf["92:58"].inputs.width = params.width;
    wf["92:58"].inputs.height = params.height;

    swapLora(wf, "92:73", params.loraName, params.loraStrength);

    console.log("[Picasso] Indus Icon workflow built", {
      lora: wf["92:73"] ? `${wf["92:73"].inputs.lora_name} @ ${wf["92:73"].inputs.strength_model}` : "REMOVED",
      seed: params.seed,
      dims: `${params.width}x${params.height}`,
      prompt: fullPrompt.substring(0, 100),
    });

    return wf;
  } else {
    // ── BANNER / SPOT: uses same ICON_WORKFLOW base (node 91) ──
    // Banner/spot prompts are already detailed from LLM conceptualise,
    // so they go directly into node 91 as-is.
    // Override negative prompt for banner/spot style.
    const wf = JSON.parse(JSON.stringify(ICON_WORKFLOW)) as Record<string, any>;
    wf["91"].inputs.value = params.prompt.trim();
    wf["92:7"].inputs.text = getNegativePrompt(flow);

    wf["92:3"].inputs.seed = params.seed;
    wf["92:58"].inputs.width = params.width;
    wf["92:58"].inputs.height = params.height;

    swapLora(wf, "92:73", params.loraName, params.loraStrength);

    console.log("[Picasso] Banner/Spot workflow built", {
      flow,
      lora: wf["92:73"] ? `${wf["92:73"].inputs.lora_name} @ ${wf["92:73"].inputs.strength_model}` : "REMOVED",
      seed: params.seed,
      dims: `${params.width}x${params.height}`,
      prompt: params.prompt.substring(0, 100),
    });

    return wf;
  }
}

function buildControlnetWorkflow(params: {
  prompt: string;
  seed: number;
  width: number;
  height: number;
  loraName: string | null;
  loraStrength: number;
  imageFilename: string;
  flow?: "icon" | "banner" | "spot";
}): Record<string, unknown> {
  const flow = params.flow || "icon";

  if (flow === "banner" || flow === "spot") {
    // ── BANNER/SPOT ControlNet: sketch-to-illustration ──
    // Uses BANNER_CONTROLNET_WORKFLOW — StringConcatenate (103) + ControlNet nodes.
    // User prompt → node 103 string_a, style baked in string_b.
    const wf = JSON.parse(JSON.stringify(BANNER_CONTROLNET_WORKFLOW)) as Record<string, any>;
    wf["103"].inputs.string_a = params.prompt.trim();

    wf["92:3"].inputs.seed = params.seed;
    wf["92:58"].inputs.width = params.width;
    wf["92:58"].inputs.height = params.height;
    wf["28"].inputs.image = params.imageFilename;

    // LoRA swap on node 92:73
    swapLora(wf, "92:73", params.loraName, params.loraStrength);

    console.log("[Picasso] Banner ControlNet (sketch-to-illus) workflow built", {
      flow,
      lora: wf["92:73"] ? `${wf["92:73"].inputs.lora_name} @ ${wf["92:73"].inputs.strength_model}` : "REMOVED",
      refImage: params.imageFilename,
      prompt: params.prompt.substring(0, 80),
    });

    return wf;
  } else {
    // ── ICON ControlNet: reference-guided icon generation ──
    // Uses original CONTROLNET_WORKFLOW with node 6 for prompt.
    const wf = JSON.parse(JSON.stringify(CONTROLNET_WORKFLOW)) as Record<string, any>;

    const isPPE = params.loraName === "ppe_style.safetensors";
    if (isPPE) {
      // PPE icon ControlNet: use PPE prompt prefix + style desc
      wf["6"].inputs.text = PPE_ICON_PROMPT_PREFIX + params.prompt.trim() + " " + PPE_ICON_STYLE_DESC;
      wf["7"].inputs.text = PPE_ICON_NEGATIVE;
    } else {
      // Indus icon ControlNet: old working template
      const CONTROLNET_ICON_TEMPLATE =
        "Flat vector illustration of a {subject}, smooth glossy plastic material, rounded and beveled edges, thick soft outline slightly lighter than fill, vibrant controlled gradients with tinted highlights, soft studio lighting from upper-left, subtle rim light, gentle inner shading for faux depth, short soft drop shadow beneath object, floating centered composition with slight perspective tilt, premium modern UI illustration, ultra-clean surface, no texture grain, no realism, solid black background";
      wf["6"].inputs.text = CONTROLNET_ICON_TEMPLATE.replace("{subject}", params.prompt.trim());
      wf["7"].inputs.text = "Photorealistic, flat design, hand-drawn, sketch, noise, grain, rough texture, fabric, metal scratches, hard reflections, dull colors, thin outlines, outline-only, background scenery, clutter, text artifacts, watermark.";
    }

    wf["10"].inputs.seed = params.seed;
    wf["11"].inputs.width = params.width;
    wf["11"].inputs.height = params.height;
    wf["28"].inputs.image = params.imageFilename;

    // LoRA swap on node 5
    swapLora(wf, "5", params.loraName, params.loraStrength);

    console.log("[Picasso] Icon ControlNet workflow built", {
      lora: wf["5"] ? wf["5"].inputs.lora_name : "REMOVED",
      refImage: params.imageFilename,
      prompt: params.prompt.substring(0, 60),
    });

    return wf;
  }
}

// ─── Status (RunPod Serverless Health) ───────────────────────────────────────

let cachedStatus: StatusInfo = {
  connected: false,
  pod_status: "unknown",
  message: "Connecting to RunPod Serverless...",
};

export function getCachedStatus(): StatusInfo {
  return { ...cachedStatus };
}

export async function fetchStatus(): Promise<StatusInfo> {
  try {
    const res = await fetch(`${SUPABASE_FUNCTIONS_BASE}/comfyui/status`, {
      headers: supabaseHeaders(),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      cachedStatus = {
        connected: false,
        pod_status: "unknown",
        message: `RunPod health check failed (${res.status})`,
      };
      return { ...cachedStatus };
    }

    const health = await res.json();

    cachedStatus = {
      connected: health.connected ?? true,
      pod_status: (health.pod_status as PodStatus) ?? "ready",
      message: health.message ?? "Serverless Ready",
      workers: health.workers,
      jobs: health.jobs,
    };
    return { ...cachedStatus };
  } catch (err: unknown) {
    cachedStatus = {
      connected: false,
      pod_status: "unknown",
      message: `Error: ${(err as Error).message?.substring(0, 60) || "Unknown"}`,
    };
    return { ...cachedStatus };
  }
}

// ─── Workflow config (stub — not needed for direct RunPod) ───────────────────

export interface WorkflowConfig {
  checkpoint: string;
  sampler: string;
  scheduler: string;
  steps: number;
  cfg: number;
}

export async function getWorkflowConfig(): Promise<WorkflowConfig> {
  return {
    checkpoint: "qwen_image_2512_bf16.safetensors",
    sampler: "euler",
    scheduler: "simple",
    steps: 30,
    cfg: 2.5,
  };
}

export async function saveWorkflowConfig(
  _config: Partial<WorkflowConfig>
): Promise<{ success: boolean }> {
  return { success: true };
}

export async function uploadWorkflow(
  _workflow: Record<string, unknown>,
  _type: "default" | "controlnet" = "default",
  _mapping?: Record<string, string>
): Promise<{ success: boolean; message?: string }> {
  return { success: true, message: "Direct RunPod mode — no workflow upload needed" };
}

export async function getWorkflowInfo(
  _type: "default" | "controlnet" = "default"
): Promise<{ has_workflow: boolean; node_count: number }> {
  return { has_workflow: true, node_count: Object.keys(ICON_WORKFLOW).length };
}

// ─── Generation Cancel Support ───────────────────────────────────────────────

let currentAbortController: AbortController | null = null;
let currentJobId: string | null = null;

export async function cancelGeneration() {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
    console.log("[Picasso] Generation cancelled by user");
  }
  // Also cancel the RunPod job so it stops using GPU
  if (currentJobId) {
    const jobId = currentJobId;
    currentJobId = null;
    try {
      await fetch(`${SUPABASE_FUNCTIONS_BASE}/comfyui/cancel/${jobId}`, {
        method: "POST",
        headers: supabaseHeaders(),
      });
      console.log(`[Picasso] RunPod job ${jobId} cancel requested`);
    } catch (err) {
      console.log(`[Picasso] Failed to cancel RunPod job ${jobId}:`, err);
    }
  }
}

// ─── Image Generation (Direct to RunPod) ─────────────────────────────────────

export interface GenerateRequest {
  prompt: string;
  seed?: number;
  width?: number;
  height?: number;
  style?: string;
  flow?: "icon" | "banner" | "spot";
  referenceImage?: string | null;
  lora_name?: string | null;
  lora_strength?: number;
}

export interface GenerateResponse {
  success: boolean;
  image: string;
  seed: number;
  executionTime: number;
  mode: string;
  width: number;
  height: number;
  error?: string;
}

interface GenerateCallbacks {
  onPhase?: (phase: string, progress: number) => void;
}

export async function generateImage(
  req: GenerateRequest,
  callbacks?: GenerateCallbacks
): Promise<GenerateResponse> {
  const { onPhase } = callbacks || {};

  // Set up abort controller for cancellation
  currentAbortController = new AbortController();
  currentJobId = null;
  const { signal } = currentAbortController;

  onPhase?.("Building workflow...", 5);

  const seed = req.seed ?? Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
  const width = Math.min(req.width ?? 1328, 2048);
  const height = Math.min(req.height ?? 1328, 2048);
  const hasReference = !!(req.referenceImage);
  const loraName = req.lora_name ?? null;
  const loraStrength = req.lora_strength ?? 1.0;

  // Build the right workflow
  let workflow: Record<string, unknown>;
  let images: Record<string, string> | undefined;

  const flow = req.flow || "icon";

  if (hasReference) {
    const imageFilename = `ref_${Date.now()}.png`;
    workflow = buildControlnetWorkflow({
      prompt: req.prompt,
      seed,
      width,
      height,
      loraName,
      loraStrength,
      imageFilename,
      flow,
    });
    // Resize reference image to max 1024px and strip data URL prefix
    onPhase?.("Preparing reference image...", 7);
    let b64Data: string;
    try {
      b64Data = await resizeBase64Image(req.referenceImage!, 1024);
    } catch (e) {
      console.warn("[Picasso] Image resize failed, using raw:", e);
      b64Data = req.referenceImage!;
      if (b64Data.includes(",")) {
        b64Data = b64Data.split(",")[1];
      }
    }
    images = { [imageFilename]: b64Data };
    const sizeMB = (b64Data.length * 0.75 / 1024 / 1024).toFixed(1);
    console.log(`[Picasso] ControlNet mode — reference image: ${imageFilename}, size: ~${sizeMB}MB`);
  } else {
    workflow = buildDefaultWorkflow({
      prompt: req.prompt,
      seed,
      width,
      height,
      loraName,
      loraStrength,
      flow,
    });
  }

  console.log("[Picasso] Submitting directly to RunPod...", {
    prompt: req.prompt.substring(0, 50),
    lora: loraName,
    style: req.style,
    mode: hasReference ? "ControlNet" : "Default",
  });

  onPhase?.("Sending to RunPod...", 10);

  try {
    // Submit to RunPod /run — include images if ControlNet
    const input: Record<string, unknown> = { workflow };
    if (images && Object.keys(images).length > 0) {
      input.images = images;
    }

    const submitRes = await fetch(`${SUPABASE_FUNCTIONS_BASE}/comfyui/generate`, {
      method: "POST",
      headers: supabaseHeaders(),
      body: JSON.stringify({
        prompt: req.prompt,
        width,
        height,
        seed,
        style: req.style,
        mode: hasReference ? "controlnet" : undefined,
        reference_image: hasReference ? req.referenceImage : undefined,
        lora_name: loraName,
        lora_strength: loraStrength,
        // Also send the pre-built workflow for the edge function to use
        _workflow: workflow,
        _images: images,
      }),
      signal,
    });

    if (!submitRes.ok) {
      const text = await submitRes.text().catch(() => "");
      throw new Error(`RunPod submit failed (${submitRes.status}): ${text.substring(0, 200)}`);
    }

    const submitData = await submitRes.json();
    const jobId = submitData.job_id || submitData.id;
    if (!jobId) {
      throw new Error(submitData.error || `No job ID returned: ${JSON.stringify(submitData).substring(0, 200)}`);
    }

    currentJobId = jobId;
    console.log(`[Picasso] Job submitted: ${jobId}`);
    onPhase?.("Generation queued...", 15);

    // Poll for result
    return await pollRunPodJob(jobId, req, seed, signal, onPhase);
  } catch (err) {
    const isCancelled = signal.aborted || (err as Error).name === "AbortError" || (err as Error).message?.includes("cancelled");
    if (isCancelled) {
      console.log("[Picasso] Generation was cancelled");
      onPhase?.("Cancelled", 0);
      return makeError(req, "Generation cancelled");
    }
    console.error("[Picasso] Generate error:", err);
    onPhase?.("Generation failed", 0);
    return makeError(req, (err as Error).message);
  } finally {
    currentAbortController = null;
    currentJobId = null;
  }
}

function makeError(req: GenerateRequest, message: string): GenerateResponse {
  return {
    success: false,
    image: "",
    seed: 0,
    executionTime: 0,
    mode: "Error",
    width: req.width ?? 1328,
    height: req.height ?? 1328,
    error: message,
  };
}

// ─── Poll RunPod directly ────────────────────────────────────────────────────

async function pollRunPodJob(
  jobId: string,
  req: GenerateRequest,
  seed: number,
  signal: AbortSignal,
  onPhase?: (phase: string, progress: number) => void
): Promise<GenerateResponse> {
  const maxAttempts = 150;
  const pollInterval = 2000;
  let attempts = 0;

  const phaseMessages = [
    { at: 0, msg: "Waking up GPU...", pct: 25 },
    { at: 3, msg: "Loading models...", pct: 35 },
    { at: 8, msg: "Generating...", pct: 50 },
    { at: 15, msg: "Painting details...", pct: 65 },
    { at: 25, msg: "Adding final touches...", pct: 80 },
    { at: 40, msg: "Almost done...", pct: 88 },
    { at: 60, msg: "Still working...", pct: 92 },
  ];

  while (attempts < maxAttempts) {
    await new Promise((r) => setTimeout(r, pollInterval));
    if (signal.aborted) throw new Error("Generation cancelled");
    attempts++;

    const phase = [...phaseMessages].reverse().find((p) => attempts >= p.at);
    if (phase) onPhase?.(phase.msg, phase.pct);

    try {
      const res = await fetch(`${SUPABASE_FUNCTIONS_BASE}/comfyui/status/${jobId}`, {
        headers: supabaseHeaders(),
        signal,
      });

      if (!res.ok) continue; // Transient error, keep polling

      const data = await res.json();

      if (
        data.status === "FAILED" ||
        data.status === "CANCELLED" ||
        data.status === "TIMED_OUT"
      ) {
        const errorMsg =
          data.error || data.output?.error || `Job ${data.status.toLowerCase()}`;
        throw new Error(errorMsg);
      }

      if (data.status === "COMPLETED") {
        // Edge Function returns image directly, or check data.output for raw RunPod
        let imageUrl = data.image || "";
        if (!imageUrl && data.output) {
          let imageBase64 = data.output.image || "";
          if (!imageBase64 && data.output.images?.[0]?.data) {
            imageBase64 = data.output.images[0].data;
          }
          if (imageBase64) {
            imageUrl = imageBase64.startsWith("data:")
              ? imageBase64
              : `data:image/png;base64,${imageBase64}`;
          }
        }

        if (imageUrl) {
          onPhase?.("Done!", 100);
          console.log(`[Picasso] Job ${jobId} completed`);

          return {
            success: true,
            image: imageUrl,
            seed: data.seed ?? data.output?.seed ?? seed,
            executionTime: data.execution_time ?? data.output?.execution_time ?? 0,
            mode: req.referenceImage ? "ControlNet" : "Prompt",
            width: req.width ?? 1328,
            height: req.height ?? 1328,
          };
        }

        throw new Error(data.error || "Generation completed but no image returned");
      }

      // IN_QUEUE or IN_PROGRESS — keep polling
    } catch (err) {
      if (
        (err as Error).message?.includes("failed") ||
        (err as Error).message?.includes("FAILED") ||
        (err as Error).message?.includes("cancelled") ||
        (err as Error).message?.includes("TIMED_OUT") ||
        (err as Error).message?.includes("no image")
      ) {
        throw err;
      }
      // Transient error, continue polling
    }
  }

  throw new Error("Generation timed out after 5 minutes");
}

// ─── Connection Test ─────────────────────────────────────────────────────────

export async function testConnection(): Promise<{
  success: boolean;
  message: string;
  latency?: number;
}> {
  const start = performance.now();
  try {
    const status = await fetchStatus();
    const latency = Math.round(performance.now() - start);
    return {
      success: status.connected || status.pod_status !== "unknown",
      message: status.connected
        ? `Connected (${latency}ms) — ${status.message}`
        : `Cannot reach RunPod endpoint (${latency}ms)`,
      latency,
    };
  } catch {
    return {
      success: false,
      message: "Cannot reach RunPod serverless endpoint.",
    };
  }
}
