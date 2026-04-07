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
}

// Serverless statuses — simplified from the old pod lifecycle statuses.
// "ready" = endpoint reachable (workers may cold-start on first request)
// "starting" = workers are initializing
// "unknown" = can't reach endpoint
export type PodStatus = "ready" | "starting" | "unknown";

export interface StatusInfo {
  connected: boolean;
  pod_status: PodStatus;
  message: string;
  workers?: { idle: number; running: number; initializing: number; total: number };
  jobs?: { completed: number; failed: number; inProgress: number; inQueue: number; retried: number };
}

export const ASPECT_RATIOS: Record<string, { width: number; height: number }> = {
  "1:1": { width: 1328, height: 1328 },
  "16:9": { width: 1792, height: 1024 },
  "9:16": { width: 1024, height: 1792 },
  "4:3": { width: 1536, height: 1152 },
  "3:4": { width: 1152, height: 1536 },
  "4:5": { width: 1200, height: 1500 },
};
