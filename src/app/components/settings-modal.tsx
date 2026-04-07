import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  X,
  Server,
  Wifi,
  WifiOff,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Settings2,
  Save,
  Upload,
  FileJson,
} from "lucide-react";
import {
  testConnection,
  fetchStatus,
  getWorkflowConfig,
  saveWorkflowConfig,
  uploadWorkflow,
  getWorkflowInfo,
  type WorkflowConfig,
} from "./api-service";
import type { StatusInfo } from "./types";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsModal({
  open,
  onClose,
}: SettingsModalProps) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [activeTab, setActiveTab] = useState<
    "status" | "config" | "workflow"
  >("status");

  // Workflow config
  const [config, setConfig] = useState<WorkflowConfig>({
    checkpoint: "qwen_image_2512_bf16.safetensors",
    sampler: "euler",
    scheduler: "simple",
    steps: 30,
    cfg: 2.5,
  });
  const [configSaved, setConfigSaved] = useState(false);

  // Workflow upload
  const [hasDefaultWorkflow, setHasDefaultWorkflow] =
    useState(false);
  const [hasControlnetWorkflow, setHasControlnetWorkflow] =
    useState(false);
  const [defaultNodeCount, setDefaultNodeCount] = useState(0);
  const [controlnetNodeCount, setControlnetNodeCount] =
    useState(0);
  const [uploadResult, setUploadResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadType, setUploadType] = useState<
    "default" | "controlnet"
  >("default");

  useEffect(() => {
    if (open) {
      setTestResult(null);
      setUploadResult(null);
      refreshStatus();
      loadConfig();
      loadWorkflowInfo();
    }
  }, [open]);

  const refreshStatus = useCallback(async () => {
    const s = await fetchStatus();
    setStatus(s);
  }, []);

  const loadConfig = useCallback(async () => {
    const c = await getWorkflowConfig();
    setConfig(c);
  }, []);

  const loadWorkflowInfo = useCallback(async () => {
    const d = await getWorkflowInfo("default");
    setHasDefaultWorkflow(d.has_workflow);
    setDefaultNodeCount(d.node_count);
    const cn = await getWorkflowInfo("controlnet");
    setHasControlnetWorkflow(cn.has_workflow);
    setControlnetNodeCount(cn.node_count);
  }, []);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    const result = await testConnection();
    setTestResult(result);
    setTesting(false);
    if (result.success) await refreshStatus();
  }, [refreshStatus]);

  const handleSaveConfig = useCallback(async () => {
    const result = await saveWorkflowConfig(config);
    setConfigSaved(result.success);
    setTimeout(() => setConfigSaved(false), 2000);
  }, [config]);

  const handleWorkflowFileSelect = useCallback(
    (type: "default" | "controlnet") => {
      setUploadType(type);
      fileInputRef.current?.click();
    },
    [],
  );

  const handleWorkflowUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setUploadResult(null);
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        const result = await uploadWorkflow(json, uploadType);
        setUploadResult({
          success: result.success,
          message: result.message || "Workflow uploaded!",
        });
        await loadWorkflowInfo();
      } catch (err) {
        setUploadResult({
          success: false,
          message: `Invalid JSON: ${(err as Error).message}`,
        });
      }
      // Reset file input
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [uploadType, loadWorkflowInfo],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      <div
        className="relative w-full max-w-md mx-4 rounded-2xl border border-white/8 overflow-hidden max-h-[90vh] flex flex-col"
        style={{
          background: "rgba(16, 16, 24, 0.98)",
          backdropFilter: "blur(24px)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/5 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <Server size={18} className="text-purple-400" />
            <h2 className="text-[#e5e5ea] text-[16px] font-['Inter',sans-serif]">
              RunPod Settings
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#5a5a64] hover:text-[#86868b] hover:bg-white/5 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-white/5 flex-shrink-0">
          {(
            [
              { key: "status", icon: Wifi, label: "Status" },
              {
                key: "workflow",
                icon: FileJson,
                label: "Workflows",
              },
              {
                key: "config",
                icon: Settings2,
                label: "Config",
              },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex-1 px-3 py-2.5 text-[12px] font-['Inter',sans-serif] transition-colors ${
                activeTab === tab.key
                  ? "text-purple-300 border-b-2 border-purple-500"
                  : "text-[#5a5a64] hover:text-[#86868b]"
              }`}
            >
              <div className="flex items-center justify-center gap-1.5">
                <tab.icon size={12} />
                {tab.label}
              </div>
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="px-6 py-5 space-y-5 overflow-y-auto">
          {/* ─── STATUS TAB (Serverless) ─── */}
          {activeTab === "status" && (
            <>
              <div className="flex gap-2">
                <button
                  onClick={handleTest}
                  disabled={testing}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-['Inter',sans-serif] text-purple-300 border border-purple-500/20 hover:bg-purple-500/10 transition-colors disabled:opacity-40"
                >
                  {testing ? (
                    <Loader2
                      size={13}
                      className="animate-spin"
                    />
                  ) : (
                    <RefreshCw size={13} />
                  )}
                  Test Connection
                </button>
              </div>

              {testResult && (
                <div
                  className={`flex items-start gap-2 px-3 py-2.5 rounded-lg border text-[12px] font-['Inter',sans-serif] ${
                    testResult.success
                      ? "border-green-500/20 bg-green-500/5 text-green-300"
                      : "border-red-500/20 bg-red-500/5 text-red-300"
                  }`}
                >
                  {testResult.success ? (
                    <CheckCircle2
                      size={14}
                      className="flex-shrink-0 mt-0.5"
                    />
                  ) : (
                    <AlertTriangle
                      size={14}
                      className="flex-shrink-0 mt-0.5"
                    />
                  )}
                  <span>{testResult.message}</span>
                </div>
              )}

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] text-[#86868b] font-['Inter',sans-serif]">
                    Serverless Endpoint
                  </span>
                  <button
                    onClick={refreshStatus}
                    className="text-[11px] text-[#5a5a64] hover:text-[#86868b] transition-colors flex items-center gap-1 font-['Inter',sans-serif]"
                  >
                    <RefreshCw size={10} />
                    Refresh
                  </button>
                </div>

                <div
                  className="rounded-xl border border-white/5 p-4 space-y-3"
                  style={{
                    background: "rgba(10, 10, 16, 0.6)",
                  }}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {status?.connected ? (
                        <Wifi
                          size={14}
                          className="text-green-400"
                        />
                      ) : (
                        <WifiOff
                          size={14}
                          className="text-red-400"
                        />
                      )}
                      <span className="text-[13px] text-[#e5e5ea] font-['Inter',sans-serif]">
                        {status?.message || "Unknown"}
                      </span>
                    </div>
                    <span
                      className="text-[11px] px-2 py-0.5 rounded-full font-['JetBrains_Mono',monospace]"
                      style={{
                        background:
                          status?.pod_status === "ready"
                            ? "rgba(34, 197, 94, 0.1)"
                            : status?.pod_status === "starting"
                              ? "rgba(245, 158, 11, 0.1)"
                              : "rgba(107, 114, 128, 0.1)",
                        color:
                          status?.pod_status === "ready"
                            ? "#22c55e"
                            : status?.pod_status === "starting"
                              ? "#f59e0b"
                              : "#6b7280",
                      }}
                    >
                      {status?.pod_status || "unknown"}
                    </span>
                  </div>

                  {/* Worker stats */}
                  {status?.workers && (
                    <div className="grid grid-cols-3 gap-2 pt-1">
                      {[
                        { label: "Idle", value: status.workers.idle, color: "#22c55e" },
                        { label: "Running", value: status.workers.running, color: "#f59e0b" },
                        { label: "Starting", value: status.workers.initializing, color: "#6b7280" },
                      ].map((w) => (
                        <div key={w.label} className="text-center">
                          <div
                            className="text-[16px] font-['JetBrains_Mono',monospace]"
                            style={{ color: w.color }}
                          >
                            {w.value}
                          </div>
                          <div className="text-[10px] text-[#5a5a64] font-['Inter',sans-serif]">
                            {w.label}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <p className="text-[11px] text-[#3a3a44] font-['Inter',sans-serif] leading-relaxed">
                Connected via Supabase Edge Functions to RunPod
                Serverless. Workers cold-start on first request
                (~30-60s) then stay warm for subsequent
                generations. No pod management needed.
              </p>
            </>
          )}

          {/* ─── WORKFLOW TAB ─── */}
          {activeTab === "workflow" && (
            <>
              <p className="text-[13px] text-[#86868b] font-['Inter',sans-serif]">
                Qwen Image 2512 workflows are built-in. You
                can optionally upload custom overrides (API
                format).
              </p>

              {/* Built-in indicator */}
              <div
                className="rounded-xl border border-purple-500/15 p-3 flex items-center gap-2.5"
                style={{ background: "rgba(147, 51, 234, 0.05)" }}
              >
                <CheckCircle2 size={14} className="text-purple-400 flex-shrink-0" />
                <div>
                  <span className="text-[12px] text-purple-300 font-['Inter',sans-serif]">
                    Built-in workflows active
                  </span>
                  <p className="text-[10px] text-[#5a5a64] font-['Inter',sans-serif] mt-0.5">
                    Default (12 nodes) + ControlNet (14 nodes)
                  </p>
                </div>
              </div>

              {/* Custom override status */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-[#86868b] font-['Inter',sans-serif]">
                    Default Override
                  </span>
                  {hasDefaultWorkflow ? (
                    <span className="text-[10px] text-green-400 font-['JetBrains_Mono',monospace]">
                      Custom ({defaultNodeCount} nodes)
                    </span>
                  ) : (
                    <span className="text-[10px] text-[#3a3a44] font-['JetBrains_Mono',monospace]">
                      Using built-in
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-[#86868b] font-['Inter',sans-serif]">
                    ControlNet Override
                  </span>
                  {hasControlnetWorkflow ? (
                    <span className="text-[10px] text-green-400 font-['JetBrains_Mono',monospace]">
                      Custom ({controlnetNodeCount} nodes)
                    </span>
                  ) : (
                    <span className="text-[10px] text-[#3a3a44] font-['JetBrains_Mono',monospace]">
                      Using built-in
                    </span>
                  )}
                </div>
              </div>

              {/* Upload buttons */}
              <div className="flex gap-2">
                <button
                  onClick={() => handleWorkflowFileSelect("default")}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-['Inter',sans-serif] text-[#86868b] border border-white/8 hover:bg-white/5 hover:text-[#e5e5ea] transition-colors"
                >
                  <Upload size={12} />
                  Upload Default
                </button>
                <button
                  onClick={() => handleWorkflowFileSelect("controlnet")}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-['Inter',sans-serif] text-[#86868b] border border-white/8 hover:bg-white/5 hover:text-[#e5e5ea] transition-colors"
                >
                  <Upload size={12} />
                  Upload ControlNet
                </button>
              </div>

              {uploadResult && (
                <div
                  className={`flex items-start gap-2 px-3 py-2 rounded-lg border text-[12px] font-['Inter',sans-serif] ${
                    uploadResult.success
                      ? "border-green-500/20 bg-green-500/5 text-green-300"
                      : "border-red-500/20 bg-red-500/5 text-red-300"
                  }`}
                >
                  {uploadResult.success ? (
                    <CheckCircle2
                      size={13}
                      className="flex-shrink-0 mt-0.5"
                    />
                  ) : (
                    <AlertTriangle
                      size={13}
                      className="flex-shrink-0 mt-0.5"
                    />
                  )}
                  <span>{uploadResult.message}</span>
                </div>
              )}

              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                className="hidden"
                onChange={handleWorkflowUpload}
              />
            </>
          )}

          {/* ─── CONFIG TAB ─── */}
          {activeTab === "config" && (
            <>
              <p className="text-[13px] text-[#86868b] font-['Inter',sans-serif]">
                Workflow parameters. Changes only affect KV-stored custom
                workflows (not the built-in embedded ones).
              </p>

              <div className="space-y-3">
                {[
                  {
                    label: "Checkpoint",
                    key: "checkpoint",
                    type: "text",
                  },
                  {
                    label: "Sampler",
                    key: "sampler",
                    type: "text",
                  },
                  {
                    label: "Scheduler",
                    key: "scheduler",
                    type: "text",
                  },
                  {
                    label: "Steps",
                    key: "steps",
                    type: "number",
                  },
                  {
                    label: "CFG",
                    key: "cfg",
                    type: "number",
                  },
                ].map((field) => (
                  <div key={field.key} className="space-y-1">
                    <label className="text-[12px] text-[#86868b] font-['Inter',sans-serif]">
                      {field.label}
                    </label>
                    <input
                      type={field.type}
                      value={
                        config[
                          field.key as keyof WorkflowConfig
                        ] as string | number
                      }
                      onChange={(e) =>
                        setConfig((prev) => ({
                          ...prev,
                          [field.key]:
                            field.type === "number"
                              ? parseFloat(e.target.value) ||
                                0
                              : e.target.value,
                        }))
                      }
                      step={
                        field.key === "cfg" ? "0.1" : "1"
                      }
                      className="w-full px-3 py-2 rounded-lg bg-white/3 border border-white/8 text-[#e5e5ea] text-[13px] font-['JetBrains_Mono',monospace] focus:outline-none focus:border-purple-500/40"
                    />
                  </div>
                ))}
              </div>

              <button
                onClick={handleSaveConfig}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg text-[13px] font-['Inter',sans-serif] text-purple-300 border border-purple-500/20 hover:bg-purple-500/10 transition-colors"
              >
                {configSaved ? (
                  <CheckCircle2 size={14} />
                ) : (
                  <Save size={14} />
                )}
                {configSaved ? "Saved!" : "Save Config"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
