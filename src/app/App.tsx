import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "./components/types";
import { ASPECT_RATIOS } from "./components/types";
import { ChatPanel } from "./components/chat-panel";
import { PromptBar } from "./components/prompt-bar";
import { ImageGridPanel, type GeneratedImage } from "./components/image-grid-panel";
import { generateImage, cancelGeneration } from "./components/api-service";
import type { StyleKey } from "./components/brand-logos";
import { AuthProvider } from "./components/auth-context";
import { streamChat, chat, getStoredConfig, saveConfig, isConfigured, getActiveProvider, type LLMConfig, type LLMProvider } from "./components/llm-service";
import { streamGeminiChat, geminiChat, getStoredGeminiConfig, saveGeminiConfig, isGeminiConfigured } from "./components/gemini-service";
import { buildConceptualiseMessages, parseConcepts, type Concept } from "./components/llm-prompts";
import { SettingsDialog } from "./components/settings-dialog";
import { getLoraConfig } from "./components/lora-config";
import { getRestructureSkill } from "./components/prompt-skills";

function MainApp() {
  // TODO: Re-enable auth later
  return <AuthenticatedApp />;
}

function AuthenticatedApp() {
  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [generationPhase, setGenerationPhase] = useState("");
  const [generationProgress, setGenerationProgress] = useState(0);

  // Whether we've left the landing state (first prompt sent)
  const [hasStarted, setHasStarted] = useState(false);

  // Prompt bar state
  const [prompt, setPrompt] = useState("");
  const [selectedBrand, setSelectedBrand] = useState<string>("Indus");
  const [selectedPhase, setSelectedPhase] = useState<"conceptualise" | "generate" | null>(null);
  const [selectedFlow, setSelectedFlow] = useState<"icon" | "banner" | "spot">("icon");

  // Derive ratio from flow
  const FLOW_RATIOS: Record<string, string> = { icon: "1:1", banner: "16:9", spot: "1:1" };
  const selectedRatio = FLOW_RATIOS[selectedFlow] || "1:1";

  // LLM config
  const [llmConfig, setLlmConfig] = useState<LLMConfig | null>(null);
  const [llmProvider, setLlmProvider] = useState<LLMProvider>(getActiveProvider());

  // Clarification state — when a prompt is too vague, we ask follow-up questions
  const [pendingClarification, setPendingClarification] = useState<string | null>(null);

  // Image reference state (clicked from grid)
  const [referencedImage, setReferencedImage] = useState<{ url: string; label: string } | null>(null);

  // Attachment state (external upload)
  const [attachedImage, setAttachedImage] = useState<string | null>(null);
  const [attachedImageName, setAttachedImageName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Image grid panel state
  const [generatedImages, setGeneratedImages] = useState<GeneratedImage[]>([]);
  const [gridPanelOpen, setGridPanelOpen] = useState(false);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);

  // Pre-computed particle data — stable across renders
  const particles = useMemo(() =>
    Array.from({ length: 100 }, (_, i) => ({
      size: 1 + Math.random() * 1.5,
      left: Math.random() * 100,
      top: Math.random() * 100,
      shineDuration: 1.5 + Math.random() * 3,
      driftDuration: 14 + Math.random() * 22,
      delay: Math.random() * 6,
      glow: 2 + Math.random() * 4,
      driftIdx: i % 5,
    })),
  []);

  // Load LLM config on mount — auto-save default keys if not configured
  useEffect(() => {
    const stored = getStoredConfig();
    if (stored) {
      setLlmConfig(stored);
    } else {
      const defaultConfig: LLMConfig = {
        apiKey: '',
        model: 'gpt-4o-mini',
        temperature: 0.8,
        maxTokens: 2000,
      };
      saveConfig(defaultConfig);
      setLlmConfig(defaultConfig);
    }

    // Auto-save Gemini key if not configured
    const geminiStored = getStoredGeminiConfig();
    if (!geminiStored) {
      saveGeminiConfig({
        apiKey: '',
        model: 'gemini-2.0-flash',
        temperature: 0.8,
        maxTokens: 4000,
      });
    }

    setLlmProvider(getActiveProvider());
  }, []);

  // ─── Smart phase detection ──────────────────────────────────────────────
  // Default is generate. Conceptualise only when user explicitly selects it.
  const detectPhase = useCallback((_text: string): "conceptualise" | "generate" => {
    return "generate";
  }, []);

  // ─── Auto-detect flow from prompt ────────────────────────────────────────
  const detectFlow = useCallback((text: string): "icon" | "banner" | "spot" => {
    const lower = text.toLowerCase();
    if (/\b(banner|header|hero|wide|landscape|16.?9)\b/.test(lower)) return "banner";
    if (/\b(spot|simple|minimal|small|element|motif)\b/.test(lower)) return "spot";
    return "icon";
  }, []);

  // ─── Get LoRA config for current brand + flow ────────────────────────────
  const getLoraForGeneration = useCallback((flow: "icon" | "banner" | "spot") => {
    const lora = getLoraConfig(selectedBrand, flow);
    const refImage = referencedImage?.url || attachedImage;
    if (!lora) return { lora_name: null as string | null, lora_strength: undefined as number | undefined };
    return {
      lora_name: lora.lora_name,
      lora_strength: refImage ? (lora.controlnet_strength ?? lora.strength) : lora.strength,
    };
  }, [selectedBrand, referencedImage, attachedImage]);

  const handleResetChat = useCallback(() => {
    setMessages([]);
    setGeneratedImages([]);
    setGridPanelOpen(false);
    setSelectedImageId(null);
    setReferencedImage(null);
    setHasStarted(false);
    setSelectedPhase(null);
  }, []);

  const handleCancelGeneration = useCallback(async () => {
    try {
      await cancelGeneration();
    } catch (e) {
      console.warn("[Picasso] Cancel error:", e);
    }
    setIsGenerating(false);
    setGenerationPhase("");
    setGenerationProgress(0);
  }, []);

  const handleAttach = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = () => {
          setAttachedImage(reader.result as string);
          setAttachedImageName(file.name);
        };
        reader.readAsDataURL(file);
      }
      if (e.target) e.target.value = "";
    },
    [],
  );

  const handleClearAttachment = useCallback(() => {
    setAttachedImage(null);
    setAttachedImageName(null);
  }, []);

  const handleSelectImage = useCallback((image: GeneratedImage) => {
    setSelectedImageId(image.id);
    setReferencedImage({ url: image.url, label: image.description.slice(0, 40) });
  }, []);

  const handleDeselectImage = useCallback(() => {
    setSelectedImageId(null);
    setReferencedImage(null);
  }, []);

  const handleClearReference = useCallback(() => {
    setSelectedImageId(null);
    setReferencedImage(null);
  }, []);

  // ─── Run generation (shared by handleSend and auto-transition) ──────────
  const runGeneration = useCallback(async (
    genPrompt: string,
    flow: "icon" | "banner" | "spot",
    refImage: string | null = null
  ) => {
    // Derive dimensions from the flow parameter — NOT from UI state
    // This ensures changing the chip mid-generation doesn't affect the result
    const flowRatio = FLOW_RATIOS[flow] || "1:1";
    const dims = ASPECT_RATIOS[flowRatio] || { width: 1328, height: 1328 };
    const lora = getLoraForGeneration(flow);

    setSelectedPhase("generate");
    setSelectedFlow(flow);
    setIsGenerating(true);
    setGenerationPhase("Preparing prompt...");
    setGenerationProgress(3);

    // ─── Prompt restructuring: if a skill exists for this brand+flow,
    // call the LLM to reformat the raw prompt before sending to RunPod
    let finalPrompt = genPrompt;
    const restructureSkill = getRestructureSkill(selectedBrand, flow);
    if (restructureSkill) {
      try {
        setGenerationPhase("Restructuring prompt...");
        setGenerationProgress(5);

        const restructureMessages = [
          { role: "system" as const, content: restructureSkill },
          { role: "user" as const, content: genPrompt },
        ];

        let restructured = '';
        if (llmProvider === 'gemini') {
          const gConfig = getStoredGeminiConfig();
          if (gConfig?.apiKey) {
            restructured = await geminiChat(restructureMessages, gConfig);
          }
        } else {
          const config = llmConfig || getStoredConfig();
          if (config?.apiKey) {
            restructured = await chat(restructureMessages, config);
          }
        }

        if (restructured && restructured.trim().length > 20) {
          finalPrompt = restructured.trim();
          console.log("[Picasso] Prompt restructured:", finalPrompt.substring(0, 80));
        }
      } catch (err) {
        console.warn("[Picasso] Prompt restructure failed, using raw prompt:", err);
      }
    }

    setGenerationPhase("Sending to RunPod...");
    setGenerationProgress(8);

    try {
      const result = await generateImage(
        {
          prompt: finalPrompt,
          width: dims.width,
          height: dims.height,
          referenceImage: refImage,
          style: selectedBrand,
          flow,
          lora_name: lora.lora_name,
          lora_strength: lora.lora_strength,
        },
        {
          onPhase: (p, progress) => {
            setGenerationPhase(p);
            setGenerationProgress(progress);
          },
        }
      );

      if (result.success) {
        const botMsg: ChatMessage = {
          id: `msg-${Date.now()}`,
          type: "bot",
          content: "",
          image: result.image,
          style: selectedBrand as StyleKey,
          metadata: {
            mode: result.mode,
            seed: result.seed,
            width: result.width,
            height: result.height,
            time: result.executionTime,
          },
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, botMsg]);

        const genImage: GeneratedImage = {
          id: `img-${Date.now()}`,
          url: result.image,
          description: genPrompt,
          metadata: { mode: result.mode, seed: result.seed, width: result.width, height: result.height, time: result.executionTime },
          style: selectedBrand,
        };
        setGeneratedImages((prev) => [genImage, ...prev]);
        setGridPanelOpen(true);
      } else {
        setMessages((prev) => [...prev, {
          id: `msg-${Date.now()}`, type: "bot",
          content: result.error || "Generation failed.",
          style: selectedBrand as StyleKey, timestamp: new Date(),
        }]);
      }
    } catch {
      setMessages((prev) => [...prev, {
        id: `msg-${Date.now()}`, type: "bot",
        content: "Connection error. Please check your network.",
        style: selectedBrand as StyleKey, timestamp: new Date(),
      }]);
    } finally {
      setIsGenerating(false);
      setGenerationPhase("");
      setGenerationProgress(0);
    }
  }, [selectedBrand, llmConfig, llmProvider, getLoraForGeneration]);

  // ─── Handle "Generate from concept" button in chat ──────────────────────
  const handleGenerateFromConcept = useCallback(async (concept: Concept) => {
    const genPrompt = concept.prompt;

    // Use the flow stamped on the concept card (from when it was created),
    // NOT the current UI chip — so switching chips doesn't break existing concepts
    const flow = concept.flow || selectedFlow;

    // Add user message showing what we're generating
    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      type: "user",
      content: `Generate: ${concept.title}\n${concept.description}`,
      style: selectedBrand as StyleKey,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, userMsg]);

    const refImage = referencedImage?.url || attachedImage || null;
    await runGeneration(genPrompt, flow, refImage);
  }, [selectedBrand, selectedFlow, referencedImage, attachedImage, runGeneration]);

  // ─── Main send handler ─────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    if (!prompt.trim() || isGenerating || isStreaming) return;

    const currentPrompt = prompt.trim();

    // Auto-detect phase if not manually selected
    const phase = selectedPhase || detectPhase(currentPrompt);

    // Transition to chat mode
    setHasStarted(true);

    // Add user message to UI chat
    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      type: "user",
      content: currentPrompt,
      style: selectedBrand as StyleKey,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, userMsg]);

    // Clear prompt and attachments
    setPrompt("");
    const currentAttached = attachedImage;
    const currentRef = referencedImage?.url || null;
    setAttachedImage(null);
    setAttachedImageName(null);
    setReferencedImage(null);
    setSelectedImageId(null);

    // ─── If a reference image is present, always go to generate (ControlNet) ─
    const hasRefImage = !!(currentRef || currentAttached);
    if (hasRefImage || phase === "generate") {
      const refImage = currentRef || currentAttached || null;
      await runGeneration(currentPrompt, selectedFlow, refImage);
      return;
    }

    // ─── CONCEPTUALISE — need LLM ──────────────────────────────────
    const currentProvider = llmProvider;
    const config = llmConfig || getStoredConfig();
    const gConfig = getStoredGeminiConfig();

    const hasKey = currentProvider === 'gemini' ? !!gConfig?.apiKey : !!config?.apiKey;
    if (!hasKey) {
      setMessages((prev) => [...prev, {
        id: `msg-${Date.now()}`, type: "bot",
        content: `Please configure your ${currentProvider === 'gemini' ? 'Gemini' : 'OpenAI'} API key first. Click the settings icon to add it.`,
        style: selectedBrand as StyleKey, timestamp: new Date(),
      }]);
      return;
    }

    // ─── If we have a pending clarification, combine it with the new answer ─
    let conceptualiseInput = currentPrompt;
    if (pendingClarification) {
      conceptualiseInput = `Original request: ${pendingClarification}\nUser's clarification: ${currentPrompt}`;
      setPendingClarification(null);
    } else {
      // ─── Check if prompt is too vague and needs clarification ──────
      const wordCount = currentPrompt.split(/\s+/).length;
      const hasVisualDetail = /\b(color|colour|red|blue|green|gold|purple|orange|gradient|glossy|3d|isometric|scene|object|shield|umbrella|bag|phone|card|coin|cup|lamp|tree|car|house|building)\b/i.test(currentPrompt);

      if (wordCount <= 3 && !hasVisualDetail) {
        // Prompt is very vague — ask clarifying questions
        setPendingClarification(currentPrompt);
        setSelectedPhase("conceptualise");
        setIsStreaming(true);

        const clarifyMsgId = `msg-${Date.now()}-clarify`;
        const clarifyMsg: ChatMessage = {
          id: clarifyMsgId, type: "bot", content: "",
          style: selectedBrand as StyleKey, timestamp: new Date(),
        };
        setMessages((prev) => [...prev, clarifyMsg]);

        try {
          const clarifySystem = `You are helping a user create an illustration. They gave a very brief theme: "${currentPrompt}". Ask 1-2 SHORT clarifying questions to understand what they want better. Keep it conversational and concise — max 2 sentences total. Focus on: what specific object/scene they envision, or what mood/context (e.g., festive, professional, playful). Don't be formal. Example: "What kind of vibe are you going for — festive, corporate, or something else? Any specific objects in mind?"`;

          const clarifyMessages = [{ role: "system" as const, content: clarifySystem }, { role: "user" as const, content: currentPrompt }];
          const onClarifyChunk = (chunk: string) => {
            setMessages((prev) =>
              prev.map((m) => m.id === clarifyMsgId ? { ...m, content: m.content + chunk } : m)
            );
          };

          if (currentProvider === 'gemini' && gConfig?.apiKey) {
            await streamGeminiChat(clarifyMessages, gConfig, onClarifyChunk);
          } else if (config?.apiKey) {
            await streamChat(clarifyMessages, config, onClarifyChunk);
          }
        } catch {
          // If clarification fails, just proceed to conceptualise
          setPendingClarification(null);
        } finally {
          setIsStreaming(false);
        }
        return;
      }
    }

    // ─── CONCEPTUALISE (generate concept options) ────────────────────
    setSelectedPhase("conceptualise");
    setIsStreaming(true);

    const botMsgId2 = `msg-${Date.now()}-bot`;
    const botMsg2: ChatMessage = {
      id: botMsgId2, type: "bot", content: "",
      style: selectedBrand as StyleKey, timestamp: new Date(),
    };
    setMessages((prev) => [...prev, botMsg2]);

    try {
      const llmMessages = buildConceptualiseMessages(conceptualiseInput, selectedBrand, selectedFlow);

      const onConceptChunk = (chunk: string) => {
        setMessages((prev) =>
          prev.map((m) => m.id === botMsgId2 ? { ...m, content: m.content + chunk } : m)
        );
      };

      let fullResponse: string;
      if (currentProvider === 'gemini' && gConfig?.apiKey) {
        fullResponse = await streamGeminiChat(llmMessages, gConfig, onConceptChunk);
      } else {
        fullResponse = await streamChat(llmMessages, config!, onConceptChunk);
      }

      const concepts = parseConcepts(fullResponse);
      if (concepts && concepts.length > 0) {
        // Stamp the flow that was active when these concepts were created
        const stampedConcepts = concepts.map(c => ({ ...c, flow: selectedFlow }));
        const conceptMsg: ChatMessage = {
          id: `msg-${Date.now()}-concepts`, type: "system",
          content: JSON.stringify({ type: "concepts", concepts: stampedConcepts }),
          style: selectedBrand as StyleKey, timestamp: new Date(),
        };
        setMessages((prev) => [...prev, conceptMsg]);
      }
    } catch (error: any) {
      setMessages((prev) =>
        prev.map((m) => m.id === botMsgId2 ? { ...m, content: error?.message || "Failed to get response." } : m)
      );
    } finally {
      setIsStreaming(false);
    }
  }, [prompt, isGenerating, isStreaming, selectedBrand, selectedPhase, selectedFlow, referencedImage, attachedImage, llmConfig, llmProvider, pendingClarification, detectPhase, detectFlow, runGeneration]);

  // ─── LANDING STATE (centered prompt) ──────────────────────────────────
  if (!hasStarted) {
    return (
      <div
        className="w-full h-screen flex flex-col items-center justify-center font-['Inter',sans-serif] relative overflow-hidden"
        style={{ background: "#0c0f16" }}
      >
        {/* Shining dot particles — small, bright twinkle + drift */}
        <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
          {particles.map((p, i) => (
            <div
              key={i}
              className="absolute rounded-full"
              style={{
                width: p.size,
                height: p.size,
                left: `${p.left}%`,
                top: `${p.top}%`,
                backgroundColor: '#e2e8f0',
                boxShadow: `0 0 ${p.glow}px rgba(226,232,240,0.6)`,
                animation: `particleShine ${p.shineDuration}s ease-in-out ${p.delay}s infinite, particleDrift${p.driftIdx} ${p.driftDuration}s ease-in-out ${p.delay}s infinite`,
              }}
            />
          ))}
          <style>{`
            @keyframes particleShine {
              0%, 100% { opacity: 0.03; transform: scale(0.8); }
              50% { opacity: 0.7; transform: scale(1.2); }
            }
            @keyframes particleDrift0 {
              0%, 100% { translate: 0 0; }
              25% { translate: 10px -14px; }
              50% { translate: -6px -20px; }
              75% { translate: 12px -8px; }
            }
            @keyframes particleDrift1 {
              0%, 100% { translate: 0 0; }
              25% { translate: -12px 10px; }
              50% { translate: 16px 6px; }
              75% { translate: -8px 16px; }
            }
            @keyframes particleDrift2 {
              0%, 100% { translate: 0 0; }
              25% { translate: 14px 12px; }
              50% { translate: -10px -8px; }
              75% { translate: 6px -16px; }
            }
            @keyframes particleDrift3 {
              0%, 100% { translate: 0 0; }
              33% { translate: -16px -6px; }
              66% { translate: 8px 14px; }
            }
            @keyframes particleDrift4 {
              0%, 100% { translate: 0 0; }
              33% { translate: 11px -18px; }
              66% { translate: -14px 10px; }
            }
          `}</style>
        </div>

        {/* Settings icon — top right */}
        <div className="absolute top-4 right-4 z-10">
          <SettingsDialog onConfigChange={setLlmConfig} onProviderChange={setLlmProvider} />
        </div>

        {/* Title — large with gradient outline, overlapping with prompt bar */}
        <div className="relative z-10 leading-none mb-[-40px] select-none">
          <svg viewBox="0 0 580 160" width="580" height="160" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="picassoStroke" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="rgba(148,163,184,0.5)" />
                <stop offset="50%" stopColor="rgba(99,102,241,0.4)" />
                <stop offset="100%" stopColor="rgba(168,85,247,0.45)" />
              </linearGradient>
            </defs>
            <text
              x="290" y="125"
              textAnchor="middle"
              fontFamily="Inter, system-ui, sans-serif"
              fontSize="150"
              fontWeight="800"
              fill="rgba(148,163,184,0.08)"
              stroke="url(#picassoStroke)"
              strokeWidth="1.2"
              letterSpacing="-6"
              paintOrder="stroke"
            >
              Picasso
            </text>
          </svg>
        </div>

        {/* Centered prompt bar */}
        <div className="relative z-10 w-full">
          <PromptBar
            prompt={prompt}
            onPromptChange={setPrompt}
            onSend={handleSend}
            isGenerating={isGenerating || isStreaming}
            selectedBrand={selectedBrand}
            onBrandChange={setSelectedBrand}
            selectedPhase={selectedPhase}
            onPhaseChange={(p) => setSelectedPhase(p)}
            selectedFlow={selectedFlow}
            onFlowChange={setSelectedFlow}
            referencedImage={referencedImage}
            onClearReference={handleClearReference}
            attachedImage={attachedImage}
            attachedImageName={attachedImageName}
            onAttach={handleAttach}
            onClearAttachment={handleClearAttachment}
            isCentered={true}
          />
        </div>

        {/* LLM status */}
        {!(llmProvider === 'gemini' ? isGeminiConfigured() : isConfigured()) && (
          <p className="text-slate-700 text-[11px] mt-6 relative z-10">
            Add your {llmProvider === 'gemini' ? 'Gemini' : 'OpenAI'} API key in settings to enable Ideate & Conceptualise
          </p>
        )}

        <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
      </div>
    );
  }

  // ─── CHAT STATE (prompt at bottom) ────────────────────────────────────
  return (
    <div
      className="w-full h-screen flex overflow-hidden font-['Inter',sans-serif]"
      style={{ background: "#0c0f16" }}
    >
      {/* Main chat area */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex-1 min-h-0">
          <ChatPanel
            messages={messages}
            isGenerating={isGenerating}
            isStreaming={isStreaming}
            onSendMessage={() => {}}
            generationPhase={generationPhase}
            generationProgress={generationProgress}
            selectedStyle={selectedBrand as StyleKey}
            onResetChat={handleResetChat}
            onGenerateFromConcept={handleGenerateFromConcept}
            onCancelGeneration={handleCancelGeneration}
            selectedRatio={selectedRatio}
            settingsSlot={<SettingsDialog onConfigChange={setLlmConfig} onProviderChange={setLlmProvider} />}
            onToggleGallery={() => setGridPanelOpen((prev) => !prev)}
            isGalleryOpen={gridPanelOpen}
          />
        </div>

        {/* Prompt bar at bottom */}
        <PromptBar
          prompt={prompt}
          onPromptChange={setPrompt}
          onSend={handleSend}
          isGenerating={isGenerating || isStreaming}
          selectedBrand={selectedBrand}
          onBrandChange={setSelectedBrand}
          selectedPhase={selectedPhase}
          onPhaseChange={(p) => setSelectedPhase(p)}
          selectedFlow={selectedFlow}
          onFlowChange={setSelectedFlow}
          referencedImage={referencedImage}
          onClearReference={handleClearReference}
          attachedImage={attachedImage}
          attachedImageName={attachedImageName}
          onAttach={handleAttach}
          onClearAttachment={handleClearAttachment}
          isCentered={false}
        />
      </div>

      {/* Image grid panel — slides in from right */}
      <ImageGridPanel
        images={generatedImages}
        isOpen={gridPanelOpen}
        selectedImageId={selectedImageId}
        onSelectImage={handleSelectImage}
        onDeselectImage={handleDeselectImage}
        onClose={() => setGridPanelOpen(false)}
      />

      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <MainApp />
    </AuthProvider>
  );
}
