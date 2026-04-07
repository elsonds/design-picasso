import { useEffect, useState } from "react";
import type { StatusInfo, PodStatus } from "./types";
import { fetchStatus, getCachedStatus } from "./api-service";

const STATUS_COLORS: Record<PodStatus, string> = {
  ready: "#22c55e",
  starting: "#f59e0b",
  unknown: "#6b7280",
};

const STATUS_LABELS: Record<PodStatus, string> = {
  ready: "Serverless Ready",
  starting: "Starting...",
  unknown: "Checking...",
};

export function StatusIndicator() {
  const [status, setStatus] = useState<StatusInfo>(getCachedStatus());

  useEffect(() => {
    // Initial fetch
    fetchStatus().then((s) => setStatus(s));

    // Poll every 15 seconds (less aggressive than pod polling since serverless
    // doesn't need idle-stop checks)
    const interval = setInterval(async () => {
      const s = await fetchStatus();
      setStatus(s);
    }, 15000);

    return () => clearInterval(interval);
  }, []);

  const color = STATUS_COLORS[status.pod_status] || STATUS_COLORS.unknown;
  const label = STATUS_LABELS[status.pod_status] || status.message;

  return (
    <div className="flex items-center gap-1.5">
      <div className="relative">
        <div
          className="w-1.5 h-1.5 rounded-full"
          style={{ backgroundColor: color }}
        />
        {status.pod_status === "ready" && (
          <div
            className="absolute inset-0 w-1.5 h-1.5 rounded-full animate-ping opacity-40"
            style={{ backgroundColor: color }}
          />
        )}
        {status.pod_status === "starting" && (
          <div
            className="absolute inset-0 w-1.5 h-1.5 rounded-full animate-pulse opacity-60"
            style={{ backgroundColor: color }}
          />
        )}
      </div>
      <span
        className="text-[12px] font-['Inter',sans-serif] transition-colors duration-300"
        style={{ color: "#475569" }}
      >
        {label}
      </span>
    </div>
  );
}
