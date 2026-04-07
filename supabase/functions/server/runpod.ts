// ─── RunPod Serverless API Integration ───────────────────────────────────────
// Replaces the old dedicated-pod + ComfyUI-proxy architecture with RunPod
// Serverless endpoints. The serverless worker runs ComfyUI internally;
// we just send it a workflow JSON and poll for the result.

import * as kv from "./kv.ts";

// ─── Serverless Configuration ────────────────────────────────────────────────

const RUNPOD_API_BASE = "https://api.runpod.ai/v2";

function getApiKey(): string {
  const key = Deno.env.get("RUNPOD_API_KEY");
  if (!key) throw new Error("RUNPOD_API_KEY secret not configured");
  return key;
}

function getEndpointId(): string {
  const id = Deno.env.get("RUNPOD_ENDPOINT_ID");
  if (!id) throw new Error("RUNPOD_ENDPOINT_ID secret not configured");
  return id;
}

function serverlessUrl(path = ""): string {
  return `${RUNPOD_API_BASE}/${getEndpointId()}${path}`;
}

function apiHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${getApiKey()}`,
  };
}

// ─── Prompt Templates ────────────────────────────────────────────────────────
// The default workflow uses StringConcatenate (node 103): string_a = subject,
// string_b = style description (baked into the workflow). So we only need to
// set string_a with the subject. The LoRA handles the brand-specific style.

const PROMPT_TEMPLATE = `Generate a highly stylized, 3D isometric vector-style illustration of {subject}.`;

const CONTROLNET_TEMPLATE = `Flat vector illustration of a {subject}, smooth glossy plastic material, rounded and beveled edges, thick soft outline slightly lighter than fill, vibrant controlled gradients with tinted highlights, soft studio lighting from upper-left, subtle rim light, gentle inner shading for faux depth, short soft drop shadow beneath object, floating centered composition with slight perspective tilt, premium modern UI illustration, ultra-clean surface, no texture grain, no realism, solid black background`;

const NEGATIVE_PROMPT =
  "nsfw, nude, naked, nudity, porn, pornographic, sexual, explicit, " +
  "gore, blood, violence, violent, gruesome, disturbing, horror, scary, " +
  "drugs, weapons, guns, knife, death, dead, corpse, " +
  "racist, sexist, offensive, hate, hateful, discrimination, " +
  "child abuse, minor, underage, illegal, " +
  "watermark, signature, text, logo, banner, " +
  "low quality, blurry, distorted, disfigured, bad anatomy";

export function buildIndusPrompt(subject: string, _brand?: string): string {
  return PROMPT_TEMPLATE.replace("{subject}", subject.trim());
}

export function buildControlnetPrompt(subject: string, _brand?: string): string {
  return CONTROLNET_TEMPLATE.replace("{subject}", subject.trim());
}

export function getNegativePrompt(): string {
  return NEGATIVE_PROMPT;
}

// ─── Serverless Endpoint Health ──────────────────────────────────────────────

export interface EndpointHealth {
  workers: { idle: number; running: number; initializing: number; total: number };
  jobs: { completed: number; failed: number; inProgress: number; inQueue: number; retried: number };
}

/**
 * Check the health of the RunPod Serverless endpoint.
 * GET /v2/{endpoint_id}/health
 */
export async function getEndpointHealth(): Promise<EndpointHealth | null> {
  try {
    const res = await fetch(serverlessUrl("/health"), {
      headers: apiHeaders(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json() as EndpointHealth;
  } catch {
    return null;
  }
}

// ─── Serverless Job Submission ───────────────────────────────────────────────

export interface ServerlessJobResponse {
  id: string;
  status: string;
}

/**
 * Submit a ComfyUI workflow to the RunPod Serverless endpoint.
 *
 * POST /v2/{endpoint_id}/run
 * Body: { input: { workflow: {...}, images?: { "filename.png": "base64..." } } }
 *
 * The serverless worker (handler.py) receives this input, writes any images
 * to ComfyUI's input folder, submits the workflow to its local ComfyUI
 * instance, and returns the generated image as base64.
 */
export async function submitServerlessJob(
  workflow: Record<string, unknown>,
  images?: Record<string, string> // { filename: base64_data }
): Promise<ServerlessJobResponse> {
  const input: Record<string, unknown> = { workflow };
  if (images && Object.keys(images).length > 0) {
    input.images = images;
  }

  const res = await fetch(serverlessUrl("/run"), {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify({ input }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`RunPod Serverless submit failed (${res.status}): ${text.substring(0, 200)}`);
  }

  const data = await res.json();
  if (!data.id) {
    throw new Error(`RunPod Serverless did not return a job ID: ${JSON.stringify(data).substring(0, 200)}`);
  }

  console.log(`[Picasso] Serverless job submitted: ${data.id} (status: ${data.status})`);
  return { id: data.id, status: data.status || "IN_QUEUE" };
}

// ─── Serverless Job Polling ──────────────────────────────────────────────────

export interface ServerlessJobResult {
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "CANCELLED" | "TIMED_OUT";
  output?: {
    image?: string;         // base64 image data (primary)
    images?: { data: string }[]; // alternative format: array of { data: base64 }
    seed?: number;
    execution_time?: number;
    status?: string;        // sub-status from the handler
    error?: string;         // error from the handler
  };
  error?: string;           // top-level RunPod error
}

/**
 * Poll the status of a serverless job.
 *
 * GET /v2/{endpoint_id}/status/{job_id}
 */
export async function pollServerlessJob(jobId: string): Promise<ServerlessJobResult> {
  const res = await fetch(serverlessUrl(`/status/${jobId}`), {
    headers: apiHeaders(),
    signal: AbortSignal.timeout(12000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Non-200 on status poll — treat as still processing so frontend keeps polling
    console.log(`[Picasso] Status poll non-200 for ${jobId}: ${res.status} ${text.substring(0, 100)}`);
    return { status: "IN_PROGRESS" };
  }

  const data = await res.json();
  return {
    status: data.status || "IN_PROGRESS",
    output: data.output,
    error: data.error,
  };
}

// ─── Workflow Node Mapping ───────────────────────────────────────────────────

export interface WorkflowMapping {
  prompt_node: string;
  prompt_field: string;
  seed_node: string;
  seed_field: string;
  dimensions_node: string;
  width_field: string;
  height_field: string;
  image_node?: string; // For ControlNet
  image_field?: string; // For ControlNet
}

export const DEFAULT_WORKFLOW_MAPPING: WorkflowMapping = {
  prompt_node: "103",
  prompt_field: "string_a",
  seed_node: "92:3",
  seed_field: "seed",
  dimensions_node: "92:58",
  width_field: "width",
  height_field: "height",
};

export const CONTROLNET_WORKFLOW_MAPPING: WorkflowMapping = {
  prompt_node: "6",
  prompt_field: "text",
  seed_node: "10",
  seed_field: "seed",
  dimensions_node: "11",
  width_field: "width",
  height_field: "height",
  image_node: "28",
  image_field: "image",
};

/**
 * Apply parameters to a ComfyUI workflow JSON using the node mapping.
 */
export function applyWorkflowParams(
  workflow: Record<string, unknown>,
  mapping: WorkflowMapping,
  params: {
    prompt: string;
    seed: number;
    width: number;
    height: number;
    imageFilename?: string;
  }
): Record<string, unknown> {
  const wf = JSON.parse(JSON.stringify(workflow)); // Deep clone

  // Set prompt
  if (wf[mapping.prompt_node]) {
    (wf[mapping.prompt_node] as Record<string, unknown>).inputs =
      (wf[mapping.prompt_node] as Record<string, unknown>).inputs || {};
    (
      (wf[mapping.prompt_node] as Record<string, unknown>)
        .inputs as Record<string, unknown>
    )[mapping.prompt_field] = params.prompt;
  }

  // Set seed
  if (wf[mapping.seed_node]) {
    (wf[mapping.seed_node] as Record<string, unknown>).inputs =
      (wf[mapping.seed_node] as Record<string, unknown>).inputs || {};
    (
      (wf[mapping.seed_node] as Record<string, unknown>)
        .inputs as Record<string, unknown>
    )[mapping.seed_field] = params.seed;
  }

  // Set dimensions
  if (wf[mapping.dimensions_node]) {
    (wf[mapping.dimensions_node] as Record<string, unknown>).inputs =
      (wf[mapping.dimensions_node] as Record<string, unknown>).inputs || {};
    const dimInputs = (wf[mapping.dimensions_node] as Record<string, unknown>)
      .inputs as Record<string, unknown>;
    dimInputs[mapping.width_field] = params.width;
    dimInputs[mapping.height_field] = params.height;
  }

  // Set image filename (ControlNet)
  if (
    mapping.image_node &&
    mapping.image_field &&
    params.imageFilename &&
    wf[mapping.image_node]
  ) {
    (wf[mapping.image_node] as Record<string, unknown>).inputs =
      (wf[mapping.image_node] as Record<string, unknown>).inputs || {};
    (
      (wf[mapping.image_node] as Record<string, unknown>)
        .inputs as Record<string, unknown>
    )[mapping.image_field] = params.imageFilename;
  }

  return wf;
}

// ─── Embedded Qwen Image 2512 Workflows ──────────────────────────────────────
// Exported directly from ComfyUI API. The LoRA node (92:73) lora_name is
// swapped at runtime by applyLoraConfig() — the default here is just a placeholder.

/** Default prompt-only workflow (Qwen-Image-2512 API export) */
export const EMBEDDED_DEFAULT_WORKFLOW: Record<string, unknown> = {
  "90": {
    inputs: { filename_prefix: "Qwen-Image-2512", images: ["92:8", 0] },
    class_type: "SaveImage",
    _meta: { title: "Save Image" },
  },
  "103": {
    inputs: {
      string_a: "",
      string_b: "The artistic execution must strictly adhere to a clean, minimalist, and modern UI/UX icon design aesthetic. The perspective must be an orthographic projection, creating a distinct pseudo-3D volumetric effect without any natural perspective distortion or vanishing points. The visual language is entirely lineless, meaning there are absolutely no outlines, strokes, or sketched borders; every form and volume is defined purely through the precise juxtaposition of solid color blocks. The color palette must be exceptionally vibrant, utilizing flat, opaque colors with a slight pastel or soft undertone, avoiding any use of smooth gradients, blending, or textured brushwork. Shading is achieved through a stark, hard-edged cel-shading technique, dividing the object into clear zones of bright highlight, solid mid-tone, and deep shadow. The shadows should be rendered as crisp, dark, desaturated geometric shapes that ground the forms, while highlights should appear as sharp, flat, bright polygons or stylized four-pointed star glints to suggest a smooth, matte, plastic-like surface finish. The proportions of the object should be chunky, simplified, and playful, featuring heavily rounded corners and exaggerated, thick geometry that abstracts the subject into its most basic, recognizable geometric components. The final image must look like a premium, professionally crafted digital asset, completely smooth and textureless, isolated on a pure white background, perfectly embodying the contemporary, flat-design-evolved-to-3D corporate illustration trend.",
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
      text: "outlines, strokes, line art, sketch, crosshatching, smooth gradients, airbrush, glossy plastic, PBR, photorealistic, realistic texture, noise, grain, dithering, complex background, scenery, ground plane, cast shadow blob, harsh rim light, metallic chrome, glass refraction, text, watermark, logo, multiple unrelated objects, inconsistent perspective, wrong viewing angle, front orthographic only, muddy colors, low resolution, blur, jpeg artifacts",
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

/** ControlNet workflow (image_controlnet_2512.json) */
export const EMBEDDED_CONTROLNET_WORKFLOW: Record<string, unknown> = {
  "1": {
    inputs: {
      unet_name: "qwen_image_2512_bf16.safetensors",
      weight_dtype: "default",
    },
    class_type: "UNETLoader",
    _meta: { title: "Load Diffusion Model" },
  },
  "2": {
    inputs: {
      clip_name: "qwen_2.5_vl_7b_fp8_scaled.safetensors",
      type: "qwen_image",
      device: "default",
    },
    class_type: "CLIPLoader",
    _meta: { title: "Load CLIP" },
  },
  "3": {
    inputs: { vae_name: "qwen_image_vae.safetensors" },
    class_type: "VAELoader",
    _meta: { title: "Load VAE" },
  },
  "5": {
    inputs: {
      lora_name: "indus-style.safetensors",
      strength_model: 1.5,
      model: ["1", 0],
    },
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
      text: "Photorealistic, flat design, hand-drawn, sketch, noise, grain, rough texture, fabric, metal scratches, hard reflections, dull colors, thin outlines, outline-only, background scenery, clutter, text artifacts, watermark.  ",
      clip: ["2", 0],
    },
    class_type: "CLIPTextEncode",
    _meta: { title: "Negative Prompt" },
  },
  "10": {
    inputs: {
      seed: 0,
      steps: 30,
      cfg: 2.5,
      sampler_name: "euler",
      scheduler: "simple",
      denoise: 1,
      model: ["5", 0],
      positive: ["18", 0],
      negative: ["18", 1],
      latent_image: ["11", 0],
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
      strength: 2,
      start_percent: 0,
      end_percent: 1,
      positive: ["6", 0],
      negative: ["7", 0],
      control_net: ["22", 0],
      image: ["23", 0],
      vae: ["3", 0],
    },
    class_type: "ControlNetApplyAdvanced",
    _meta: { title: "Apply ControlNet" },
  },
  "22": {
    inputs: {
      type: "canny/lineart/anime_lineart/mlsd",
      control_net: ["16", 0],
    },
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

// ─── LoRA Node IDs in embedded workflows ────────────────────────────────────
// Default workflow: node "92:73" is LoraLoaderModelOnly
// ControlNet workflow: node "5" is LoraLoaderModelOnly
const DEFAULT_LORA_NODE = "92:73";
const CONTROLNET_LORA_NODE = "5";

/**
 * Apply LoRA configuration to a workflow.
 * If lora_name is null/empty, removes the LoRA node and rewires the model chain.
 */
function applyLoraConfig(
  workflow: Record<string, unknown>,
  loraNodeId: string,
  loraName: string | null,
  loraStrength: number = 1.0
): Record<string, unknown> {
  const wf = workflow; // Already cloned by caller

  if (loraName && loraName.trim()) {
    // Set LoRA name and strength
    if (wf[loraNodeId]) {
      const node = wf[loraNodeId] as Record<string, unknown>;
      node.inputs = node.inputs || {};
      const inputs = node.inputs as Record<string, unknown>;
      inputs.lora_name = loraName;
      inputs.strength_model = loraStrength;
      console.log(`[Picasso] LoRA: ${loraName} @ strength ${loraStrength}`);
    }
  } else {
    // No LoRA — bypass the LoRA loader node
    // Rewire: anything pointing to LoRA output → point to LoRA's model input instead
    if (wf[loraNodeId]) {
      const loraNode = wf[loraNodeId] as Record<string, unknown>;
      const loraInputs = loraNode.inputs as Record<string, unknown>;
      const modelSource = loraInputs?.model; // e.g. ["92:37", 0] or ["1", 0]

      if (modelSource) {
        // Find all nodes that reference the LoRA node output and rewire them
        for (const [nodeId, nodeData] of Object.entries(wf)) {
          if (nodeId === loraNodeId) continue;
          const nd = nodeData as Record<string, unknown>;
          const inputs = nd.inputs as Record<string, unknown>;
          if (!inputs) continue;
          for (const [key, val] of Object.entries(inputs)) {
            if (Array.isArray(val) && val[0] === loraNodeId) {
              inputs[key] = modelSource;
            }
          }
        }
        // Remove the LoRA node
        delete wf[loraNodeId];
        console.log(`[Picasso] LoRA bypassed (Generic mode) — node ${loraNodeId} removed`);
      }
    }
  }

  return wf;
}

/**
 * Get the appropriate workflow with parameters applied.
 * Priority: KV-stored custom workflow > Embedded workflow
 */
export async function getWorkflow(
  type: "default" | "controlnet",
  params: {
    prompt: string;
    seed: number;
    width: number;
    height: number;
    imageFilename?: string;
    lora_name?: string | null;
    lora_strength?: number;
  }
): Promise<Record<string, unknown>> {
  const mapping =
    type === "controlnet"
      ? CONTROLNET_WORKFLOW_MAPPING
      : DEFAULT_WORKFLOW_MAPPING;

  const loraNodeId = type === "controlnet" ? CONTROLNET_LORA_NODE : DEFAULT_LORA_NODE;

  // Check for KV-stored custom workflow (user upload overrides built-in)
  const kvKey =
    type === "controlnet" ? KV_WORKFLOW_CONTROLNET : KV_WORKFLOW_DEFAULT;

  try {
    const customData = await kv.get(kvKey) as { workflow?: Record<string, unknown>; mapping?: Record<string, string> } | null;
    if (customData?.workflow) {
      const customMapping = customData.mapping
        ? { ...mapping, ...customData.mapping }
        : mapping;
      console.log(`[Picasso] Using KV-stored custom ${type} workflow`);
      const wf = applyWorkflowParams(
        customData.workflow as Record<string, unknown>,
        customMapping,
        params
      );
      // Apply LoRA config if provided
      if (params.lora_name !== undefined) {
        return applyLoraConfig(wf, loraNodeId, params.lora_name, params.lora_strength ?? 1.0);
      }
      return wf;
    }
  } catch {
    /* KV miss — use embedded */
  }

  // Use embedded workflow
  const embedded =
    type === "controlnet"
      ? EMBEDDED_CONTROLNET_WORKFLOW
      : EMBEDDED_DEFAULT_WORKFLOW;

  console.log(`[Picasso] Using built-in ${type} workflow`);
  const wf = applyWorkflowParams(embedded, mapping, params);

  // Apply LoRA config if provided
  if (params.lora_name !== undefined) {
    return applyLoraConfig(wf, loraNodeId, params.lora_name, params.lora_strength ?? 1.0);
  }
  return wf;
}

// ─── KV Storage Keys ─────────────────────────────────────────────────────────

export const KV_WORKFLOW_DEFAULT = "indus_workflow_default";
export const KV_WORKFLOW_CONTROLNET = "indus_workflow_controlnet";
export const KV_WORKFLOW_CONFIG = "indus_workflow_config";