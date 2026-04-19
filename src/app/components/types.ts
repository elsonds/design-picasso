export interface ChatMessage {
  id: string;
  type: "user" | "bot" | "system";
  content: string;
  image?: string;
  style?: string; // Style active when message was created
  metadata?: {
    mode: string;
    seed: number;
    width: number;
    height: number;
    time: number;
  };
  timestamp: Date;
  // In-flight generation state (bot messages only, while generating)
  pending?: boolean;
  phase?: string;
  progress?: number;
  generationId?: string;
  ratio?: string;
}

export type ExecutionMode = "serverless" | "pod";

// Statuses for both serverless and pod modes
export type PodStatus = "ready" | "starting" | "creating" | "comfyui_loading" | "stopped" | "none" | "unknown" | "error" | "degraded";

export interface StatusInfo {
  connected: boolean;
  pod_status: PodStatus;
  message: string;
  execution_mode?: ExecutionMode;
  // Serverless-specific
  workers?: { idle: number; running: number; initializing: number; total: number };
  jobs?: { completed: number; failed: number; inProgress: number; inQueue: number; retried: number };
  // Pod-specific
  pod_id?: string;
  gpu?: string;
  uptime?: number;
  cost_per_hr?: number;
  // Queue + ETA (both modes)
  queue_running?: number;
  queue_pending?: number;
  avg_exec_seconds?: number;
  eta_seconds?: number;
  // Pod idle auto-stop countdown
  idle_remaining_seconds?: number | null;
  idle_timeout_seconds?: number;
}

export const ASPECT_RATIOS: Record<string, { width: number; height: number }> = {
  "1:1": { width: 1328, height: 1328 },
  "16:9": { width: 1792, height: 1024 },
  "9:16": { width: 1024, height: 1792 },
  "4:3": { width: 1536, height: 1152 },
  "3:4": { width: 1152, height: 1536 },
  "4:5": { width: 1200, height: 1500 },
};
