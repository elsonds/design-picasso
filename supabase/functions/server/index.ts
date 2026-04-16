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
  getStyleDescription,
  getNegativePrompt,
  getWorkflow,
  KV_WORKFLOW_DEFAULT,
  KV_WORKFLOW_CONTROLNET,
  KV_WORKFLOW_CONFIG,
} from "./runpod.ts";
import {
  getExecutionMode,
  setExecutionMode,
  ensurePodRunning,
  startOrCreatePod,
  stopPod,
  checkIdleAutoStop,
  probeComfyUI,
  uploadImage,
  queuePrompt,
  pollHistory,
  type ExecutionMode,
} from "./pod.ts";

const app = new Hono().basePath("/server/make-server-1a0af268");

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

app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

// ─── Execution Mode ─────────────────────────────────────────────────────────

app.get("/comfyui/mode", async (c) => {
  const mode = await getExecutionMode();
  return c.json({ mode });
});

app.post("/comfyui/mode", async (c) => {
  try {
    const body = await c.req.json();
    const mode = body.mode as ExecutionMode;
    if (mode !== "serverless" && mode !== "pod") {
      return c.json({ error: "mode must be 'serverless' or 'pod'" }, 400);
    }
    await setExecutionMode(mode);
    return c.json({ success: true, mode });
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ─── Pod Control ────────────────────────────────────────────────────────────

app.post("/comfyui/pod/start", async (c) => {
  try {
    const result = await startOrCreatePod();
    return c.json({
      success: !("error" === result.status),
      ...result,
    });
  } catch (err: unknown) {
    return c.json({ success: false, error: (err as Error).message }, 500);
  }
});

app.post("/comfyui/pod/stop", async (c) => {
  try {
    await stopPod();
    return c.json({ success: true, message: "Pod stop requested" });
  } catch (err: unknown) {
    return c.json({ success: false, error: (err as Error).message }, 500);
  }
});

// ─── Endpoint Status (mode-aware) ───────────────────────────────────────────

app.get("/comfyui/status", async (c) => {
  try {
    const mode = await getExecutionMode();

    if (mode === "pod") {
      // Pod mode: check pod status + idle auto-stop
      await checkIdleAutoStop();
      const podStatus = await ensurePodRunning();

      return c.json({
        connected: true,
        pod_status: podStatus.status,
        message: podStatus.message,
        execution_mode: "pod",
        pod_id: podStatus.podId,
        gpu: podStatus.gpu,
        uptime: podStatus.uptime,
        cost_per_hr: podStatus.costPerHr,
      });
    }

    // Serverless mode (default)
    const health = await getEndpointHealth();

    if (!health) {
      return c.json({
        connected: false,
        pod_status: "unknown",
        message: "Cannot reach RunPod Serverless endpoint",
        execution_mode: "serverless",
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
      podStatus = "ready";
      message = "Serverless standby — will cold-start on first request (~30-60s)";
    } else {
      podStatus = "ready";
      message = "Serverless endpoint available";
    }

    return c.json({
      connected: true,
      pod_status: podStatus,
      message,
      execution_mode: "serverless",
      workers: health.workers,
      jobs: health.jobs,
    });
  } catch (err: unknown) {
    console.log("Status check error:", (err as Error).message);
    return c.json({
      connected: false,
      pod_status: "unknown",
      message: `Error: ${(err as Error).message?.substring(0, 100)}`,
      execution_mode: "serverless",
    });
  }
});

// ─── Workflow Config (preserved from old architecture) ───────────────────────

app.get("/comfyui/config", async (c) => {
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

app.post("/comfyui/config", async (c) => {
  try {
    const body = await c.req.json();
    await kv.set(KV_WORKFLOW_CONFIG, body);
    return c.json({ success: true, message: "Config saved" });
  } catch (err: unknown) {
    return c.json({ success: false, message: (err as Error).message });
  }
});

// ─── Upload custom workflow JSON (preserved) ─────────────────────────────────

app.post("/comfyui/workflow/upload", async (c) => {
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

app.get("/comfyui/workflow", async (c) => {
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

// ─── Generate Image (mode-aware: serverless or pod) ─────────────────────────

app.post("/comfyui/generate", async (c) => {
  try {
    const body = await c.req.json();
    const {
      prompt,
      width = 1328,
      height = 1328,
      seed,
      style,
      flow = "icon",   // "icon" | "banner" | "spot"
      reference_image, // base64 data URL or raw base64
      mode,
      lora_name,       // LoRA safetensors filename (null = no LoRA)
      lora_strength,   // LoRA strength (default 1.0)
    } = body;

    if (!prompt) {
      return c.json({ success: false, error: "prompt is required" }, 400);
    }

    const executionMode = await getExecutionMode();
    const hasReference = !!(reference_image && mode === "controlnet");
    const brand = style || "Indus";

    console.log(`\n${"=".repeat(50)}`);
    console.log(`[Picasso] New generation: '${prompt}' [${executionMode}]`);
    console.log(
      `[Picasso] Brand: ${brand}, Flow: ${flow}, ${width}x${height}, ControlNet: ${hasReference}, LoRA: ${lora_name || "none"}`
    );

    // Build prompt (pass-through)
    const fullPrompt = hasReference
      ? buildControlnetPrompt(prompt, brand)
      : buildIndusPrompt(prompt, brand);

    const actualSeed =
      seed ?? Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);

    // Build workflow (shared by both modes)
    const workflowType = hasReference ? "controlnet" : "default";
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

    // Override style description and negative prompt per brand+flow
    const styleDesc = getStyleDescription(brand, flow);
    const negPrompt = getNegativePrompt(flow);

    if (workflowType === "default") {
      if ((workflow as Record<string, any>)["103"]) {
        (workflow as Record<string, any>)["103"].inputs.string_b = styleDesc;
      }
      if ((workflow as Record<string, any>)["92:7"]) {
        (workflow as Record<string, any>)["92:7"].inputs.text = negPrompt;
      }
    } else {
      if ((workflow as Record<string, any>)["7"]) {
        (workflow as Record<string, any>)["7"].inputs.text = negPrompt;
      }
    }

    // Debug logging
    const loraDebugNode = workflowType === "controlnet" ? "5" : "92:73";
    const loraNodeState = (workflow as Record<string, any>)[loraDebugNode];
    console.log(`[Picasso] LoRA "${loraDebugNode}":`, loraNodeState ? JSON.stringify((loraNodeState as any).inputs) : "REMOVED");

    // ── POD MODE ──
    if (executionMode === "pod") {
      // Auto-start pod if needed
      const podStatus = await startOrCreatePod();
      if (!podStatus.podId) {
        return c.json({
          success: false,
          error: podStatus.message || "Failed to start pod",
          pod_status: podStatus.status,
        }, 503);
      }

      if (!podStatus.ready) {
        // Pod starting — tell frontend to retry
        return c.json({
          success: false,
          error: "Pod starting, please wait...",
          pod_status: podStatus.status,
          pod_id: podStatus.podId,
          retry: true,
        }, 503);
      }

      // Pod is ready — upload reference image if ControlNet
      let podImageFilename = imageFilename;
      if (hasReference && reference_image && podStatus.podId) {
        podImageFilename = await uploadImage(podStatus.podId, reference_image);
        // Update workflow with actual filename from ComfyUI
        if ((workflow as Record<string, any>)["28"]) {
          (workflow as Record<string, any>)["28"].inputs.image = podImageFilename;
        }
      }

      // Queue workflow to ComfyUI
      const promptId = await queuePrompt(podStatus.podId, workflow);

      // Store job metadata
      await kv.set(`indus_pod_job_${promptId}`, {
        prompt: fullPrompt,
        width,
        height,
        seed: actualSeed,
        style: style || "Indus",
        mode: hasReference ? "ControlNet" : "Prompt",
        pod_id: podStatus.podId,
        submitted_at: Date.now(),
      });

      return c.json({
        success: true,
        job_id: promptId,
        request_id: promptId,
        seed: actualSeed,
        execution_mode: "pod",
        message: "Generation submitted to pod",
      });
    }

    // ── SERVERLESS MODE (default) ──
    let images: Record<string, string> | undefined;
    if (hasReference && imageFilename) {
      let b64Data = reference_image;
      if (b64Data.includes(",")) b64Data = b64Data.split(",")[1];
      images = { [imageFilename]: b64Data };
    }

    const job = await submitServerlessJob(workflow, images);

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
      execution_mode: "serverless",
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

// ─── Check generation job status (mode-aware) ──────────────────────────────

app.get("/comfyui/status/:jobId", async (c) => {
  try {
    const jobId = c.req.param("jobId");

    // Check if this is a pod job first
    let podJobMeta: Record<string, unknown> | null = null;
    try {
      const saved = await kv.get(`indus_pod_job_${jobId}`);
      if (saved && typeof saved === "object") podJobMeta = saved as Record<string, unknown>;
    } catch { /* ignore */ }

    // ── POD JOB ──
    if (podJobMeta) {
      const podId = podJobMeta.pod_id as string;
      if (!podId) {
        return c.json({ status: "FAILED", error: "Pod ID missing from job metadata" });
      }

      const result = await pollHistory(podId, jobId);

      if (result.status === "COMPLETED" && result.image) {
        const elapsed = podJobMeta.submitted_at
          ? Math.round((Date.now() - (podJobMeta.submitted_at as number)) / 1000)
          : 0;

        console.log(`[Pod] Job ${jobId} completed in ${elapsed}s`);
        try { await kv.del(`indus_pod_job_${jobId}`); } catch { /* ignore */ }

        return c.json({
          status: "COMPLETED",
          completed: true,
          success: true,
          image: result.image,
          seed: (podJobMeta.seed as number) ?? 0,
          width: (podJobMeta.width as number) ?? 1328,
          height: (podJobMeta.height as number) ?? 1328,
          mode: (podJobMeta.mode as string) || "Prompt",
          style: (podJobMeta.style as string) || "Indus",
          execution_time: elapsed,
        });
      }

      if (result.status === "FAILED") {
        try { await kv.del(`indus_pod_job_${jobId}`); } catch { /* ignore */ }
        return c.json({ status: "FAILED", error: result.error || "Generation failed" });
      }

      return c.json({ status: "IN_PROGRESS", completed: false });
    }

    // ── SERVERLESS JOB (default) ──
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

app.get("/comfyui/debug/check", async (c) => {
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

// ─── LLM Proxy (OpenAI + Gemini) ────────────────────────────────────────────
// Proxies LLM requests so API keys stay server-side.
// Frontend sends messages + config, Edge Function adds the API key and forwards.

app.post("/llm/chat", async (c) => {
  try {
    const body = await c.req.json();
    const { messages, provider = "openai", model, temperature = 0.8, maxTokens = 2000, stream = true } = body;

    if (!messages || !Array.isArray(messages)) {
      return c.json({ error: "messages array is required" }, 400);
    }

    if (provider === "gemini") {
      // ── Gemini ──
      const apiKey = Deno.env.get("GEMINI_API_KEY");
      if (!apiKey) return c.json({ error: "GEMINI_API_KEY not configured" }, 500);

      const geminiModel = model || "gemini-2.0-flash";

      // Convert messages to Gemini format
      let systemInstruction: string | null = null;
      const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
      for (const msg of messages) {
        if (msg.role === "system") {
          systemInstruction = (systemInstruction ? systemInstruction + "\n\n" : "") + msg.content;
        } else {
          contents.push({
            role: msg.role === "assistant" ? "model" : "user",
            parts: [{ text: msg.content }],
          });
        }
      }

      const geminiBody: Record<string, unknown> = {
        contents,
        generationConfig: { temperature, maxOutputTokens: maxTokens },
      };
      if (systemInstruction) {
        geminiBody.systemInstruction = { parts: [{ text: systemInstruction }] };
      }

      const endpoint = stream ? "streamGenerateContent?alt=sse" : "generateContent";
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:${endpoint}&key=${apiKey}`;

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geminiBody),
      });

      if (!res.ok) {
        const text = await res.text();
        return c.json({ error: `Gemini API error (${res.status}): ${text.substring(0, 200)}` }, res.status);
      }

      // Stream passthrough
      return new Response(res.body, {
        status: res.status,
        headers: {
          "Content-Type": res.headers.get("Content-Type") || "text/event-stream",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } else {
      // ── OpenAI ──
      const apiKey = Deno.env.get("OPENAI_API_KEY");
      if (!apiKey) return c.json({ error: "OPENAI_API_KEY not configured" }, 500);

      const openaiModel = model || "gpt-4o-mini";
      const url = "https://api.openai.com/v1/chat/completions";

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: openaiModel,
          messages,
          temperature,
          max_tokens: maxTokens,
          stream,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        return c.json({ error: `OpenAI API error (${res.status}): ${text.substring(0, 200)}` }, res.status);
      }

      // Stream passthrough
      return new Response(res.body, {
        status: res.status,
        headers: {
          "Content-Type": res.headers.get("Content-Type") || "text/event-stream",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
  } catch (err: unknown) {
    console.log("LLM proxy error:", (err as Error).message);
    return c.json({ error: `LLM proxy error: ${(err as Error).message}` }, 500);
  }
});

Deno.serve(app.fetch);