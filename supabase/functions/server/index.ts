import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { logger } from "npm:hono/logger";
import * as kv from "./kv.ts";
import {
  getEndpointHealth,
  submitServerlessJob,
  pollServerlessJob,
  buildIndusPrompt,
  buildControlnetPrompt,
  getWorkflow,
  KV_WORKFLOW_DEFAULT,
  KV_WORKFLOW_CONTROLNET,
  KV_WORKFLOW_CONFIG,
} from "./runpod.ts";

const app = new Hono();

app.use("*", logger(console.log));

app.use(
  "/*",
  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
  })
);

// ─── Health check ────────────────────────────────────────────────────────────

app.get("/make-server-1a0af268/health", (c) => {
  return c.json({ status: "ok" });
});

// ─── Serverless Endpoint Status ──────────────────────────────────────────────
// Replaces the old pod-lifecycle status check. Queries the RunPod Serverless
// /health endpoint to report worker availability and queue depth.

app.get("/make-server-1a0af268/comfyui/status", async (c) => {
  try {
    const health = await getEndpointHealth();

    if (!health) {
      return c.json({
        connected: false,
        pod_status: "unknown",
        message: "Cannot reach RunPod Serverless endpoint",
      });
    }

    const totalWorkers = health.workers.idle + health.workers.running + health.workers.initializing;
    const isReady = health.workers.idle > 0 || health.workers.running > 0;
    const isColdStart = totalWorkers === 0;

    let podStatus: string;
    let message: string;

    if (isReady) {
      podStatus = "ready";
      message = `Serverless ready — ${health.workers.idle} idle, ${health.workers.running} running`;
    } else if (health.workers.initializing > 0) {
      podStatus = "starting";
      message = `Worker initializing (${health.workers.initializing} spinning up)`;
    } else if (isColdStart) {
      podStatus = "ready"; // Serverless auto-starts on request — report as ready
      message = "Serverless standby — will cold-start on first request (~30-60s)";
    } else {
      podStatus = "ready";
      message = "Serverless endpoint available";
    }

    return c.json({
      connected: true,
      pod_status: podStatus,
      message,
      workers: health.workers,
      jobs: health.jobs,
    });
  } catch (err: unknown) {
    console.log("Status check error:", (err as Error).message);
    return c.json({
      connected: false,
      pod_status: "unknown",
      message: `Error: ${(err as Error).message?.substring(0, 100)}`,
    });
  }
});

// ─── Workflow Config (preserved from old architecture) ───────────────────────

app.get("/make-server-1a0af268/comfyui/config", async (c) => {
  try {
    const config = await kv.get(KV_WORKFLOW_CONFIG);
    return c.json({
      success: true,
      config: config || {
        checkpoint: "qwen_image_2512_bf16.safetensors",
        sampler: "euler",
        scheduler: "simple",
        steps: 30,
        cfg: 2.5,
      },
    });
  } catch {
    return c.json({
      success: true,
      config: {
        checkpoint: "qwen_image_2512_bf16.safetensors",
        sampler: "euler",
        scheduler: "simple",
        steps: 30,
        cfg: 2.5,
      },
    });
  }
});

app.post("/make-server-1a0af268/comfyui/config", async (c) => {
  try {
    const body = await c.req.json();
    await kv.set(KV_WORKFLOW_CONFIG, body);
    return c.json({ success: true, message: "Config saved" });
  } catch (err: unknown) {
    return c.json({ success: false, message: (err as Error).message });
  }
});

// ─── Upload custom workflow JSON (preserved) ─────────────────────────────────

app.post("/make-server-1a0af268/comfyui/workflow/upload", async (c) => {
  try {
    const body = await c.req.json();
    const { workflow, type = "default", mapping } = body;

    if (!workflow || typeof workflow !== "object") {
      return c.json({ success: false, error: "workflow JSON object required" }, 400);
    }

    const kvKey =
      type === "controlnet" ? KV_WORKFLOW_CONTROLNET : KV_WORKFLOW_DEFAULT;

    await kv.set(kvKey, { workflow, mapping: mapping || null });
    console.log(
      `[Indus] Uploaded ${type} workflow (${Object.keys(workflow).length} nodes)`
    );

    return c.json({
      success: true,
      message: `${type} workflow saved (${Object.keys(workflow).length} nodes)`,
    });
  } catch (err: unknown) {
    return c.json({ success: false, error: (err as Error).message });
  }
});

app.get("/make-server-1a0af268/comfyui/workflow", async (c) => {
  try {
    const type = c.req.query("type") || "default";
    const kvKey =
      type === "controlnet" ? KV_WORKFLOW_CONTROLNET : KV_WORKFLOW_DEFAULT;
    const data = await kv.get(kvKey);
    return c.json({
      success: true,
      type,
      has_workflow: !!data,
      node_count: data?.workflow ? Object.keys(data.workflow).length : 0,
    });
  } catch {
    return c.json({ success: true, has_workflow: false });
  }
});

// ─── Generate Image (SERVERLESS — replaces old pod-based generation) ─────────
// Instead of finding/creating a pod, health-checking ComfyUI, and submitting
// the workflow to a pod's ComfyUI /prompt endpoint, we now:
//   1. Build the prompt using Indus templates
//   2. Build workflow with parameters applied
//   3. Prepare images payload for ControlNet
//   4. Submit to RunPod Serverless
//   5. Store job metadata in KV for the status polling route
//   6. Return the job_id for frontend polling

app.post("/make-server-1a0af268/comfyui/generate", async (c) => {
  try {
    const body = await c.req.json();
    const {
      prompt,
      width = 1328,
      height = 1328,
      seed,
      style,
      reference_image, // base64 data URL or raw base64
      mode,
      lora_name,       // LoRA safetensors filename (null = no LoRA)
      lora_strength,   // LoRA strength (default 1.0)
    } = body;

    if (!prompt) {
      return c.json({ success: false, error: "prompt is required" }, 400);
    }

    const hasReference = !!(reference_image && mode === "controlnet");

    // Determine brand from style parameter (frontend sends brand name as style)
    const brand = style || "Indus";

    console.log(`\n${"=".repeat(50)}`);
    console.log(`[Picasso] New generation request: '${prompt}'`);
    console.log(
      `[Picasso] Brand: ${brand}, Dimensions: ${width}x${height}, ControlNet: ${hasReference}, LoRA: ${lora_name || "none (Generic)"}`
    );

    // Step 1: Build the prompt using brand-specific templates
    const fullPrompt = hasReference
      ? buildControlnetPrompt(prompt, brand)
      : buildIndusPrompt(prompt, brand);

    console.log(`[Picasso] Prompt: ${fullPrompt.substring(0, 80)}...`);

    const actualSeed =
      seed ?? Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    console.log(`[Picasso] Seed: ${actualSeed}`);

    // Step 2: Build workflow with parameters applied
    const workflowType = hasReference ? "controlnet" : "default";

    // For ControlNet, the reference image is passed to the serverless worker
    // via the `images` field. The worker writes it to ComfyUI's input folder.
    const imageFilename = hasReference ? `ref_${Date.now()}.png` : undefined;

    const workflow = await getWorkflow(workflowType, {
      prompt: fullPrompt,
      seed: actualSeed,
      width: Math.min(width, 2048),
      height: Math.min(height, 2048),
      imageFilename,
      lora_name: lora_name !== undefined ? lora_name : undefined,
      lora_strength: lora_strength !== undefined ? lora_strength : undefined,
    });

    // Debug: log the final LoRA node state in the workflow
    const loraDebugNode = workflowType === "controlnet" ? "5" : "92:73";
    const loraNodeState = (workflow as Record<string, any>)[loraDebugNode];
    console.log(`[Picasso] Final workflow LoRA node "${loraDebugNode}":`, loraNodeState ? JSON.stringify((loraNodeState as any).inputs) : "NODE REMOVED (Generic)");

    // Step 3: Prepare images payload for ControlNet
    let images: Record<string, string> | undefined;
    if (hasReference && imageFilename) {
      // Strip data URL prefix if present
      let b64Data = reference_image;
      if (b64Data.includes(",")) {
        b64Data = b64Data.split(",")[1];
      }
      images = { [imageFilename]: b64Data };
      console.log(`[Picasso] Reference image included as: ${imageFilename}`);
    }

    // Step 4: Submit to RunPod Serverless
    console.log(`[Picasso] Submitting workflow to RunPod Serverless...`);
    const job = await submitServerlessJob(workflow, images);

    // Step 5: Store job metadata in KV for the status polling route
    await kv.set(`indus_job_${job.id}`, {
      prompt: fullPrompt,
      width,
      height,
      seed: actualSeed,
      style: style || "Indus",
      mode: hasReference ? "ControlNet" : "Prompt",
      submitted_at: Date.now(),
    });

    return c.json({
      success: true,
      job_id: job.id,
      request_id: job.id,
      seed: actualSeed,
      message: "Generation submitted to serverless endpoint",
    });
  } catch (err: unknown) {
    console.log("Generate error:", (err as Error).message);
    return c.json({
      success: false,
      error: `Generation failed: ${(err as Error).message}`,
    });
  }
});

// ─── Check generation job status (SERVERLESS — replaces ComfyUI /history) ────
// Instead of querying a pod's ComfyUI /history endpoint, we now poll the
// RunPod Serverless /status/{job_id} endpoint. When the job completes, the
// serverless worker returns the image as base64 in its output.

app.get("/make-server-1a0af268/comfyui/status/:jobId", async (c) => {
  try {
    const jobId = c.req.param("jobId");

    // Get job metadata from KV
    let jobMeta: Record<string, unknown> = {};
    try {
      const saved = await kv.get(`indus_job_${jobId}`);
      if (saved && typeof saved === "object")
        jobMeta = saved as Record<string, unknown>;
    } catch { /* ignore */ }

    // Poll RunPod Serverless status
    const result = await pollServerlessJob(jobId);

    // ── COMPLETED ──
    if (result.status === "COMPLETED" && result.output) {
      const elapsed = jobMeta.submitted_at
        ? Math.round((Date.now() - (jobMeta.submitted_at as number)) / 1000)
        : 0;

      // Extract image from serverless output
      // The handler may return: { image: "base64..." } or { images: [{ data: "base64..." }] }
      let imageBase64 = result.output.image || "";
      if (!imageBase64 && result.output.images?.[0]?.data) {
        imageBase64 = result.output.images[0].data;
      }

      if (imageBase64) {
        console.log(
          `[Indus] Job ${jobId} completed in ${elapsed}s`
        );

        // Clean up job metadata
        try { await kv.del(`indus_job_${jobId}`); } catch { /* ignore */ }

        // Ensure the image has a data URL prefix
        const imageUrl = imageBase64.startsWith("data:")
          ? imageBase64
          : `data:image/png;base64,${imageBase64}`;

        return c.json({
          status: "COMPLETED",
          completed: true,
          success: true,
          image: imageUrl,
          data: [{ b64_json: imageBase64.startsWith("data:") ? imageBase64.split(",")[1] : imageBase64 }],
          seed: (jobMeta.seed as number) ?? result.output.seed ?? 0,
          width: (jobMeta.width as number) ?? 1328,
          height: (jobMeta.height as number) ?? 1328,
          mode: (jobMeta.mode as string) || "Prompt",
          style: (jobMeta.style as string) || "Indus",
          execution_time: result.output.execution_time ?? elapsed,
        });
      }

      // Completed but no image found — treat as error
      console.log(`[Picasso] Job ${jobId} completed but no image in output:`, JSON.stringify(result.output).substring(0, 200));
      try { await kv.del(`indus_job_${jobId}`); } catch { /* ignore */ }
      return c.json({
        status: "FAILED",
        error: "Generation completed but no image was returned",
      });
    }

    // ── FAILED / CANCELLED / TIMED_OUT ──
    if (result.status === "FAILED" || result.status === "CANCELLED" || result.status === "TIMED_OUT") {
      try { await kv.del(`indus_job_${jobId}`); } catch { /* ignore */ }
      const errorMsg = result.error || result.output?.error || `Job ${result.status.toLowerCase()}`;
      console.log(`[Picasso] Job ${jobId} ${result.status}: ${errorMsg}`);
      return c.json({
        status: "FAILED",
        error: errorMsg,
      });
    }

    // ── IN_QUEUE / IN_PROGRESS ──
    return c.json({
      status: result.status,
      completed: false,
    });
  } catch (err: unknown) {
    console.log("Job status check error:", (err as Error).message);
    return c.json({
      status: "IN_PROGRESS",
      completed: false,
    });
  }
});

// ─── Debug endpoint ──────────────────────────────────────────────────────────

app.get("/make-server-1a0af268/comfyui/debug/check", async (c) => {
  try {
    const apiKey = Deno.env.get("RUNPOD_API_KEY");
    const endpointId = Deno.env.get("RUNPOD_ENDPOINT_ID");

    const results: Record<string, unknown> = {
      api_key_set: !!(apiKey && apiKey.length > 10),
      api_key_prefix: apiKey ? apiKey.substring(0, 10) + "..." : "NOT SET",
      endpoint_id_set: !!endpointId,
      endpoint_id: endpointId || "NOT SET",
      architecture: "serverless",
    };

    // Check endpoint health
    const health = await getEndpointHealth();
    results.endpoint_health = health || "unreachable";

    // Check stored workflows
    let hasDefault = false;
    let hasControlnet = false;
    try {
      const d = await kv.get(KV_WORKFLOW_DEFAULT);
      hasDefault = !!(d?.workflow);
    } catch { /* ignore */ }
    try {
      const cn = await kv.get(KV_WORKFLOW_CONTROLNET);
      hasControlnet = !!(cn?.workflow);
    } catch { /* ignore */ }
    results.workflows = { default: hasDefault, controlnet: hasControlnet };

    return c.json({ success: true, results });
  } catch (err: unknown) {
    return c.json({ success: false, error: (err as Error).message });
  }
});

Deno.serve(app.fetch);