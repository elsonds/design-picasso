import {
  useEffect,
  useRef,
  useState,
  useCallback,
} from "react";
import {
  Download,
  Maximize2,
  X,
  Sparkles,
  Trash2,
  AlertCircle,
  User,
  FolderDown,
  Wand2,
  LayoutGrid,
} from "lucide-react";
import { StatusIndicator } from "./status-indicator";
import { GenerationVisual } from "./generation-visual";
import type { ChatMessage } from "./types";
import { STYLE_CONFIG, type StyleKey } from "./brand-logos";
import { useAuth } from "./auth-context";
import type { Concept } from "./llm-prompts";

interface ChatPanelProps {
  messages: ChatMessage[];
  isGenerating: boolean;
  isStreaming?: boolean;
  onSendMessage: (
    prompt: string,
    options: {
      width: number;
      height: number;
      referenceImage?: string | null;
    },
  ) => void;
  generationPhase?: string;
  generationProgress?: number;
  selectedStyle: StyleKey;
  onResetChat: () => void;
  onGenerateFromConcept?: (concept: Concept) => void;
  onCancelGeneration?: () => void;
  selectedRatio?: string;
  settingsSlot?: React.ReactNode;
  onToggleGallery?: () => void;
  isGalleryOpen?: boolean;
}

/** Resolve the correct bot avatar for a message based on its stored style */
function getBotAvatar(msg: ChatMessage) {
  const msgStyle = (msg.style || "Indus") as StyleKey;
  const config = STYLE_CONFIG[msgStyle];
  return config?.logo || STYLE_CONFIG["Indus"].logo;
}

/** Try to parse a system message as concept cards */
function tryParseConcepts(content: string): Concept[] | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed?.type === "concepts" && Array.isArray(parsed.concepts)) {
      return parsed.concepts;
    }
  } catch {
    // Not concept JSON
  }
  return null;
}

/** Check if a bot message content looks like raw concept JSON (streamed LLM response) */
function isRawConceptJSON(content: string): boolean {
  const trimmed = content.trim();
  return (
    (trimmed.startsWith('```json') || trimmed.startsWith('{"concepts"')) &&
    trimmed.includes('"title"') &&
    trimmed.includes('"prompt"')
  );
}

/** Renders a generated image scaled to fit within maxSide px */
function ImageFrame({ src, width, height }: { src: string; width?: number; height?: number }) {
  const mw = width || 1328;
  const mh = height || 1328;
  const maxSide = 480;
  const scale = maxSide / Math.max(mw, mh);
  const imgW = Math.round(mw * scale);
  const imgH = Math.round(mh * scale);
  return (
    <div
      className="rounded-xl overflow-hidden border border-white/5"
      style={{ background: "rgba(15, 23, 42, 0.8)" }}
    >
      <img
        src={src}
        alt="Generated"
        className="object-contain bg-black/40 mx-auto"
        style={{ width: imgW, height: imgH }}
      />
    </div>
  );
}

export function ChatPanel({
  messages,
  isGenerating,
  isStreaming = false,
  onSendMessage,
  generationPhase,
  generationProgress,
  selectedStyle,
  onResetChat,
  onGenerateFromConcept,
  onCancelGeneration,
  selectedRatio = "1:1",
  settingsSlot,
  onToggleGallery,
  isGalleryOpen = false,
}: ChatPanelProps) {
  const { user } = useAuth();
  const [fullscreenImage, setFullscreenImage] = useState<string | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [isDownloadingAll, setIsDownloadingAll] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const StyleLogo = STYLE_CONFIG[selectedStyle]?.logo || STYLE_CONFIG["Indus"].logo;

  // Find the LAST concept message index (we only show this one)
  const lastConceptIdx = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === "system" && tryParseConcepts(messages[i].content)) return i;
    }
    return -1;
  })();

  // ─── Warn on page refresh/close if generated images exist ──────────────
  const hasGeneratedImages = messages.some((msg) => msg.image);

  useEffect(() => {
    if (!hasGeneratedImages) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasGeneratedImages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isGenerating]);

  // ─── Download all generated images ─────────────────────────────────────
  const imageMessages = messages.filter((msg) => msg.image);
  const imageCount = imageMessages.length;

  const handleDownloadAll = useCallback(async () => {
    if (imageCount === 0 || isDownloadingAll) return;
    setIsDownloadingAll(true);

    for (let i = 0; i < imageMessages.length; i++) {
      const msg = imageMessages[i];
      if (!msg.image) continue;
      const link = document.createElement("a");
      link.href = msg.image;
      link.download = `${(msg.style || selectedStyle).toLowerCase()}-${msg.metadata?.seed || `image-${i + 1}`}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      if (i < imageMessages.length - 1) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    setIsDownloadingAll(false);
  }, [imageMessages, imageCount, isDownloadingAll, selectedStyle]);

  return (
    <>
      {/* CSS keyframes */}
      <style>{`
        @keyframes cp-msg-enter {
          from { opacity: 0; transform: translateY(16px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes cp-loader-enter {
          from { opacity: 0; transform: translateY(20px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes cp-typing-dot {
          0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
          30% { opacity: 1; transform: translateY(-3px); }
        }
        @keyframes cp-concept-enter {
          from { opacity: 0; transform: translateY(10px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes cp-modal-enter {
          from { opacity: 0; transform: scale(0.95); }
          to   { opacity: 1; transform: scale(1); }
        }
        @keyframes cp-modal-overlay {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
      `}</style>
      <div
        className="flex flex-col h-full relative"
        style={{ background: "#0c0f16" }}
      >
        {/* Top bar — all controls left-aligned */}
        <div
          className="flex items-center px-4 py-2.5 border-b"
          style={{
            borderBottomColor: "rgba(148,163,184,0.08)",
            background: "rgba(15, 23, 42, 0.4)",
            backdropFilter: "blur(20px)",
          }}
        >
          {/* Left side — Picasso branding + Status */}
          <div className="flex items-center gap-1">
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg mr-1">
              <Sparkles size={14} className="text-slate-400" />
              <span className="text-[13px] font-semibold text-slate-300">
                Picasso
              </span>
            </div>

            <div className="w-px h-4" style={{ backgroundColor: "rgba(148,163,184,0.1)" }} />

            <div className="ml-1">
              <StatusIndicator />
            </div>
          </div>

          {/* Right side — action buttons: Gallery, Download, Delete, Settings */}
          <div className="ml-auto flex items-center gap-0.5">
            {/* 1. Gallery toggle */}
            {onToggleGallery && (
              <button
                onClick={onToggleGallery}
                className="p-1.5 rounded-lg transition-colors hover:bg-white/5"
                style={{ color: isGalleryOpen ? '#e2e8f0' : '#64748b' }}
                title={isGalleryOpen ? "Close Gallery" : "Open Gallery"}
              >
                <LayoutGrid size={16} />
              </button>
            )}

            {/* 2. Download all */}
            <button
              onClick={handleDownloadAll}
              disabled={imageCount === 0 || isDownloadingAll}
              className="relative p-1.5 rounded-lg transition-colors hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed"
              style={{ color: (imageCount > 0 && !isDownloadingAll) ? '#e2e8f0' : '#64748b' }}
              title={imageCount > 0 ? `Save All (${imageCount})` : "No images to save"}
            >
              <FolderDown size={16} />
              {imageCount > 0 && (
                <span
                  className="absolute -top-1 -right-1 min-w-[14px] h-[14px] rounded-full flex items-center justify-center text-[8px] font-bold text-white leading-none"
                  style={{ background: "linear-gradient(135deg, #94a3b8, #64748b)" }}
                >
                  {imageCount}
                </span>
              )}
            </button>

            {/* 3. Delete chat */}
            <button
              onClick={() => setShowResetConfirm(true)}
              disabled={messages.length === 0 || isGenerating}
              className="p-1.5 rounded-lg transition-colors hover:bg-white/5 hover:text-red-400 disabled:opacity-30 disabled:cursor-not-allowed"
              style={{ color: (messages.length > 0 && !isGenerating) ? '#e2e8f0' : '#64748b' }}
              title="Reset Chat"
            >
              <Trash2 size={16} />
            </button>

            {/* 4. Settings */}
            {settingsSlot && (
              <div>{settingsSlot}</div>
            )}
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 pt-6 pb-4 scrollbar-thin">
          {messages.length === 0 && !isGenerating && (
            <div className="flex flex-col items-center justify-center h-full text-center px-6">
              <div
                className="w-12 h-12 rounded-2xl flex items-center justify-center mb-4"
                style={{ backgroundColor: "rgba(148,163,184,0.08)" }}
              >
                <StyleLogo size={28} />
              </div>
              <p className="text-slate-600 text-[13px] font-['Inter',sans-serif] max-w-sm">
                Describe what you want to create.
              </p>
            </div>
          )}

          <div className="space-y-5 max-w-[740px] mx-auto">
            {messages.map((msg, msgIdx) => {
              const MsgBotAvatar = msg.type === "bot" ? getBotAvatar(msg) : null;

              // Hide bot messages that contain raw JSON concept data (streamed LLM output)
              if (msg.type === "bot" && !msg.image && msg.content && isRawConceptJSON(msg.content)) {
                return null;
              }

              // Hide transition messages like "Now generating 3 concept directions..."
              if (msg.type === "bot" && !msg.image && msg.content &&
                  /^now generating \d+ concept/i.test(msg.content.trim())) {
                return null;
              }

              // Handle system messages — concept cards
              if (msg.type === "system") {
                const concepts = tryParseConcepts(msg.content);
                if (concepts && onGenerateFromConcept) {
                  // Only render the LAST concept set
                  if (msgIdx !== lastConceptIdx) return null;

                  return (
                    <div
                      key={msg.id}
                      className="flex gap-2.5 justify-start"
                      style={{ animation: "cp-concept-enter 0.4s ease both" }}
                    >
                      <div className="flex-shrink-0 mt-1">
                        <div
                          className="w-6 h-6 rounded-full overflow-hidden flex items-center justify-center"
                          style={{ backgroundColor: "rgba(148,163,184,0.1)" }}
                        >
                          <StyleLogo size={24} />
                        </div>
                      </div>
                      <div className="space-y-2.5 flex-1 min-w-0">
                        <p className="text-[12px] text-slate-500 font-['Inter',sans-serif] px-0.5">
                          Pick a concept to generate:
                        </p>
                        {concepts.map((concept, idx) => (
                          <div
                            key={idx}
                            className="rounded-xl border p-3.5 transition-all cursor-default group"
                            style={{
                              background: "rgba(15, 23, 42, 0.6)",
                              borderColor: "rgba(148,163,184,0.08)",
                            }}
                            onMouseEnter={(e) => (e.currentTarget.style.borderColor = "rgba(148,163,184,0.2)")}
                            onMouseLeave={(e) => (e.currentTarget.style.borderColor = "rgba(148,163,184,0.08)")}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex-1 min-w-0">
                                <h4 className="text-slate-200 text-[13px] font-medium font-['Inter',sans-serif] mb-0.5">
                                  {concept.title}
                                </h4>
                                <p className="text-slate-500 text-[12px] font-['Inter',sans-serif] leading-relaxed">
                                  {concept.description}
                                </p>
                              </div>
                              <button
                                onClick={() => onGenerateFromConcept(concept)}
                                disabled={isGenerating}
                                className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium font-['Inter',sans-serif] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                                style={{
                                  color: "#e2e8f0",
                                  backgroundColor: "rgba(148,163,184,0.1)",
                                  border: "1px solid rgba(148,163,184,0.2)",
                                }}
                              >
                                <Wand2 size={12} />
                                Generate
                              </button>
                            </div>
                            <p className="text-[10px] text-slate-600 font-['JetBrains_Mono',monospace] mt-1.5 truncate">
                              {concept.prompt}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                }
                return null;
              }

              return (
                <div
                  key={msg.id}
                  className={`flex gap-2.5 ${msg.type === "user" ? "justify-end" : "justify-start"}`}
                  style={{ animation: "cp-msg-enter 0.35s ease both" }}
                >
                  {/* Bot avatar */}
                  {msg.type === "bot" && MsgBotAvatar && (
                    <div className="flex-shrink-0 mt-1">
                      <div
                        className="w-6 h-6 rounded-full overflow-hidden flex items-center justify-center"
                        style={{ backgroundColor: "rgba(148,163,184,0.1)" }}
                      >
                        <MsgBotAvatar size={24} />
                      </div>
                    </div>
                  )}

                  {/* Message content */}
                  <div className={`space-y-2 ${msg.type === "user" ? "max-w-[55%]" : "max-w-[520px]"}`}>
                    {msg.type === "user" ? (
                      <div
                        className="px-3.5 py-2 rounded-2xl rounded-br-sm text-slate-200 text-[13px] font-['Inter',sans-serif]"
                        style={{ background: "linear-gradient(135deg, #1e293b, #0f172a)" }}
                      >
                        {msg.content}
                      </div>
                    ) : (
                      <>
                        {msg.image && (
                          <ImageFrame
                            src={msg.image}
                            width={msg.metadata?.width}
                            height={msg.metadata?.height}
                          />
                        )}
                        {msg.content && !msg.image && (
                          <div
                            className="text-slate-300 text-[13px] font-['Inter',sans-serif] whitespace-pre-wrap leading-relaxed"
                          >
                            {msg.content}
                          </div>
                        )}
                        {msg.image && (
                          <div className="flex gap-2">
                            <a
                              href={msg.image}
                              download={`${(msg.style || selectedStyle).toLowerCase()}-${msg.metadata?.seed || "image"}.png`}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-['Inter',sans-serif] text-slate-400 border border-slate-700/50 hover:bg-white/5 hover:text-slate-300 transition-colors"
                              style={{ background: "rgba(15, 23, 42, 0.5)" }}
                            >
                              <Download size={11} />
                              Download
                            </a>
                            <button
                              onClick={() => setFullscreenImage(msg.image!)}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-['Inter',sans-serif] text-slate-400 border border-slate-700/50 hover:bg-white/5 hover:text-slate-300 transition-colors"
                              style={{ background: "rgba(15, 23, 42, 0.5)" }}
                            >
                              <Maximize2 size={11} />
                              Full Screen
                            </button>
                          </div>
                        )}
                        {msg.metadata && (
                          <p className="text-[10px] font-['JetBrains_Mono',monospace] text-slate-600 px-0.5">
                            Seed: {msg.metadata.seed} · {msg.metadata.width}x{msg.metadata.height} · {msg.metadata.time}s
                          </p>
                        )}
                      </>
                    )}
                  </div>

                  {/* User avatar */}
                  {msg.type === "user" && (
                    <div className="flex-shrink-0 mt-1">
                      {user?.user_metadata?.avatar_url ? (
                        <img
                          src={user.user_metadata.avatar_url}
                          alt=""
                          className="w-6 h-6 rounded-full object-cover ring-1 ring-slate-700"
                        />
                      ) : (
                        <div className="w-6 h-6 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center">
                          <User size={12} className="text-slate-500" />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Streaming indicator */}
            {isStreaming && (
              <div
                className="flex gap-2.5 justify-start"
                style={{ animation: "cp-loader-enter 0.35s ease both" }}
              >
                <div className="flex-shrink-0 mt-1">
                  <div
                    className="w-6 h-6 rounded-full overflow-hidden flex items-center justify-center"
                    style={{ backgroundColor: "rgba(148,163,184,0.1)" }}
                  >
                    <StyleLogo size={24} />
                  </div>
                </div>
                <div
                  className="flex items-center gap-1.5 px-4 py-3 rounded-xl rounded-bl-sm border"
                  style={{
                    background: "rgba(15, 23, 42, 0.6)",
                    borderColor: "rgba(148,163,184,0.06)",
                  }}
                >
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="w-1.5 h-1.5 rounded-full"
                      style={{
                        backgroundColor: "#94a3b8",
                        animation: `cp-typing-dot 1.4s ease-in-out ${i * 0.2}s infinite`,
                      }}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Generation visual */}
            {isGenerating && (
              <div
                className="flex gap-2.5 justify-start"
                style={{ animation: "cp-loader-enter 0.5s ease 0.2s both" }}
              >
                <div className="flex-shrink-0 mt-1">
                  <div
                    className="w-6 h-6 rounded-full overflow-hidden flex items-center justify-center"
                    style={{ backgroundColor: "rgba(148,163,184,0.1)" }}
                  >
                    <StyleLogo size={24} />
                  </div>
                </div>
                <div className="space-y-2 max-w-[520px]">
                  <GenerationVisual
                    phase={generationPhase || "Initializing..."}
                    progress={generationProgress ?? 0}
                    onCancel={onCancelGeneration}
                    selectedRatio={selectedRatio}
                  />
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>
      </div>

      {/* Reset Confirmation Modal */}
      {showResetConfirm && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm"
          style={{ animation: "cp-modal-overlay 0.2s ease both" }}
          onClick={() => setShowResetConfirm(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border p-6 shadow-2xl"
            style={{
              background: "rgba(15, 23, 42, 0.95)",
              borderColor: "rgba(148,163,184,0.1)",
              animation: "cp-modal-enter 0.3s ease both",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col items-center text-center gap-4">
              <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center mb-1">
                <AlertCircle size={24} className="text-red-500" />
              </div>
              <h3 className="text-slate-100 text-[18px] font-medium font-['Inter',sans-serif]">
                Reset Chat?
              </h3>
              <p className="text-slate-400 text-[14px] font-['Inter',sans-serif] leading-relaxed">
                This will clear all current messages and generated images.
                <br />
                <span className="text-slate-200 font-medium">
                  Please ensure you have saved any important generations.
                </span>
              </p>
              <div className="flex gap-3 w-full mt-2">
                <button
                  onClick={() => setShowResetConfirm(false)}
                  className="flex-1 px-4 py-2.5 rounded-xl text-slate-300 text-[13px] font-medium hover:bg-white/5 transition-colors border border-slate-700/50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => { onResetChat(); setShowResetConfirm(false); }}
                  className="flex-1 px-4 py-2.5 rounded-xl text-white text-[13px] font-medium bg-red-500 hover:bg-red-600 transition-colors shadow-lg shadow-red-500/20"
                >
                  Yes, Reset
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Fullscreen image modal */}
      {fullscreenImage && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90"
          onClick={() => setFullscreenImage(null)}
        >
          <button
            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
            onClick={() => setFullscreenImage(null)}
          >
            <X size={20} />
          </button>
          <img
            src={fullscreenImage}
            alt="Fullscreen"
            className="max-w-[90vw] max-h-[90vh] object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}
