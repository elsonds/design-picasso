'use client';

import React, { useState, useRef, useEffect } from 'react';
import {
  Paperclip,
  ChevronDown,
  X,
  ArrowUp,
  Lock,
} from 'lucide-react';
import { STYLE_CONFIG, type StyleKey, IndusLogo, PhonePeLogo, ShareMarketLogo, GenericLogo } from './brand-logos';

export type FlowType = 'icon' | 'spot' | 'banner';

interface PromptBarProps {
  prompt: string;
  onPromptChange: (value: string) => void;
  onSend: () => void;
  isGenerating: boolean;
  // Brand
  selectedBrand: string;
  onBrandChange: (brand: string) => void;
  // Phase
  selectedPhase: 'conceptualise' | 'generate' | null;
  onPhaseChange: (phase: 'conceptualise' | 'generate' | null) => void;
  // Flow (icon / spot / banner)
  selectedFlow: FlowType;
  onFlowChange: (flow: FlowType) => void;
  // Image reference (selected from grid)
  referencedImage: { url: string; label: string } | null;
  onClearReference: () => void;
  // Attachment (external image)
  attachedImage: string | null;
  attachedImageName: string | null;
  onAttach: () => void;
  onClearAttachment: () => void;
  // Layout mode
  isCentered: boolean;
}

const BRANDS = ['Indus', 'PhonePe', 'Share.Market', 'Generic'] as const;

const BRAND_LOGOS: Record<string, React.FC<{ size?: number }>> = {
  'Indus': IndusLogo,
  'PhonePe': PhonePeLogo,
  'Share.Market': ShareMarketLogo,
  'Generic': GenericLogo,
};
const PHASES = [
  { key: 'conceptualise' as const, label: 'Conceptualise' },
  { key: 'generate' as const, label: 'Generate' },
];
const FLOWS: { key: FlowType; label: string }[] = [
  { key: 'icon', label: 'Icon' },
  { key: 'spot', label: 'Spot' },
  { key: 'banner', label: 'Banner' },
];

export function PromptBar({
  prompt,
  onPromptChange,
  onSend,
  isGenerating,
  selectedBrand,
  onBrandChange,
  selectedPhase,
  onPhaseChange,
  selectedFlow,
  onFlowChange,
  referencedImage,
  onClearReference,
  attachedImage,
  attachedImageName,
  onAttach,
  onClearAttachment,
  isCentered,
}: PromptBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [phaseDropdownOpen, setPhaseDropdownOpen] = useState(false);
  const phaseDropdownRef = useRef<HTMLDivElement>(null);

  // Theme no longer used for UI colors — everything is neutral

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      const maxH = isCentered ? 200 : 160;
      textareaRef.current.style.height = Math.min(
        textareaRef.current.scrollHeight,
        maxH
      ) + 'px';
    }
  }, [prompt, isCentered]);

  // Focus textarea on mount when centered
  useEffect(() => {
    if (isCentered && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isCentered]);

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (phaseDropdownRef.current && !phaseDropdownRef.current.contains(event.target as Node)) {
        setPhaseDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Handle Enter key
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isGenerating && prompt.trim()) {
        onSend();
      }
    }
  };

  return (
    <div
      className={`w-full ${isCentered ? 'max-w-[740px]' : 'max-w-[740px]'} mx-auto`}
      style={{ padding: isCentered ? '0 16px' : '0 16px 16px 16px' }}
    >
      {/* Referenced Image */}
      {referencedImage && (
        <div className="flex items-center gap-2 mb-2 px-1">
          <div
            className="w-10 h-10 rounded-md bg-cover bg-center border border-white/10 flex-shrink-0"
            style={{ backgroundImage: `url(${referencedImage.url})` }}
          />
          <span className="text-slate-500 text-xs truncate flex-1">{referencedImage.label}</span>
          <button onClick={onClearReference} className="text-slate-500 hover:text-white transition-colors">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Attached Image */}
      {attachedImage && (
        <div className="flex items-center gap-2 mb-2 px-1">
          <div
            className="w-10 h-10 rounded-md bg-cover bg-center border border-white/10 flex-shrink-0"
            style={{ backgroundImage: `url(${attachedImage})` }}
          />
          <span className="text-slate-500 text-xs truncate flex-1">{attachedImageName || 'Attached image'}</span>
          <button onClick={onClearAttachment} className="text-slate-500 hover:text-white transition-colors">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Main input container */}
      <div
        className="rounded-2xl border transition-all overflow-hidden"
        style={{
          backgroundColor: '#141820',
          borderColor: 'rgba(148,163,184,0.08)',
          boxShadow: '0 0 0 1px rgba(148,163,184,0.04), 0 4px 24px rgba(0,0,0,0.3)',
        }}
      >
        {/* Brand tabs — top row */}
        <div
          className="flex items-center gap-1 px-1 pt-1 border-b"
          style={{ borderBottomColor: 'rgba(148,163,184,0.06)' }}
        >
          {BRANDS.map((brand) => {
            const isActive = selectedBrand === brand;
            const LogoComponent = BRAND_LOGOS[brand];
            return (
              <button
                key={brand}
                onClick={() => onBrandChange(brand)}
                className="relative flex items-center gap-2 px-4 py-2.5 text-[16px] font-medium transition-colors rounded-t-lg"
                style={{
                  color: isActive ? '#e2e8f0' : '#64748b',
                  backgroundColor: isActive ? 'rgba(148,163,184,0.08)' : 'transparent',
                }}
              >
                {LogoComponent && <LogoComponent size={20} />}
                {brand}
                {isActive && (
                  <div
                    className="absolute bottom-0 left-2 right-2 h-[2px] rounded-full"
                    style={{ backgroundColor: '#94a3b8' }}
                  />
                )}
              </button>
            );
          })}
        </div>

        {/* Textarea */}
        <div className="px-4 pt-3 pb-1">
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => onPromptChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isCentered ? "What do you want to create?" : "Describe what you want to create..."}
            className="w-full bg-transparent text-white text-[16px] leading-relaxed resize-none outline-none placeholder:text-slate-500"
            style={{ fontFamily: 'Inter, system-ui, sans-serif', minHeight: isCentered ? '56px' : '44px' }}
            rows={1}
          />
        </div>

        {/* Bottom bar — flow chips left, phase + attach + send right */}
        <div className="flex items-center justify-between px-3 pb-2.5 pt-0.5">
          {/* Left — flow chips */}
          <div className="flex items-center gap-0.5">
            {FLOWS.map((f) => {
              const isLocked = f.key !== 'icon' && selectedBrand !== 'Indus';
              return (
                <div key={f.key} className="relative group">
                  <button
                    onClick={() => !isLocked && onFlowChange(f.key)}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[14px] font-medium transition-all"
                    style={{
                      color: isLocked ? '#475569' : (selectedFlow === f.key ? '#e2e8f0' : '#64748b'),
                      backgroundColor: selectedFlow === f.key && !isLocked ? 'rgba(148,163,184,0.1)' : 'transparent',
                      border: selectedFlow === f.key && !isLocked
                        ? '1px solid rgba(148,163,184,0.2)'
                        : '1px solid transparent',
                      cursor: isLocked ? 'not-allowed' : 'pointer',
                      opacity: isLocked ? 0.5 : 1,
                    }}
                  >
                    {f.label}
                    {isLocked && <Lock size={11} />}
                  </button>
                  {isLocked && (
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2.5 py-1.5 rounded-lg text-[12px] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50"
                      style={{ backgroundColor: '#1e293b', color: '#e2e8f0', border: '1px solid rgba(148,163,184,0.15)' }}
                    >
                      🔒 Coming soon!
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Right — phase dropdown, attach, send */}
          <div className="flex items-center gap-1">
            {/* Phase dropdown */}
            <div ref={phaseDropdownRef} className="relative">
              <button
                onClick={() => setPhaseDropdownOpen(!phaseDropdownOpen)}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[14px] font-medium transition-colors hover:bg-white/5"
                style={{
                  color: selectedPhase ? '#e2e8f0' : '#64748b',
                  backgroundColor: selectedPhase ? 'rgba(148,163,184,0.1)' : 'transparent',
                  border: selectedPhase ? '1px solid rgba(148,163,184,0.2)' : '1px solid transparent',
                }}
              >
                {selectedPhase
                  ? PHASES.find(p => p.key === selectedPhase)?.label
                  : 'Auto'}
                <ChevronDown size={11} style={{ opacity: 0.5 }} />
              </button>

              {phaseDropdownOpen && (
                <div
                  className="absolute bottom-full right-0 mb-2 rounded-xl border py-1 min-w-[150px] z-50"
                  style={{
                    backgroundColor: '#1a1f2e',
                    borderColor: 'rgba(148,163,184,0.1)',
                    backdropFilter: 'blur(20px)',
                  }}
                >
                  <button
                    onClick={() => { onPhaseChange(null); setPhaseDropdownOpen(false); }}
                    className={`w-full px-3 py-2 text-left text-xs transition-colors ${
                      selectedPhase === null
                        ? 'text-slate-200 bg-white/5'
                        : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'
                    }`}
                  >
                    <span>Auto-detect</span>
                    <span className="block text-[10px] opacity-50 mt-0.5">Choose based on prompt</span>
                  </button>
                  <div className="h-px bg-white/5 my-1" />
                  {PHASES.map((phase) => (
                    <button
                      key={phase.key}
                      onClick={() => { onPhaseChange(phase.key); setPhaseDropdownOpen(false); }}
                      className={`w-full px-3 py-2 text-left text-xs transition-colors ${
                        selectedPhase === phase.key
                          ? 'text-slate-200 bg-white/5'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
                      }`}
                    >
                      {phase.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Attachment */}
            <button
              onClick={onAttach}
              className="p-1.5 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-white/5 transition-colors"
              title="Attach an image"
            >
              <Paperclip size={15} />
            </button>

            {/* Send button */}
            <button
              onClick={onSend}
              disabled={isGenerating || !prompt.trim()}
              className="p-1.5 rounded-lg transition-all disabled:cursor-not-allowed"
              style={{
                backgroundColor: (!prompt.trim() || isGenerating) ? 'rgba(148,163,184,0.15)' : '#e2e8f0',
                color: (!prompt.trim() || isGenerating) ? '#64748b' : '#0f172a',
              }}
            >
              <ArrowUp size={15} strokeWidth={2.5} />
            </button>
          </div>
        </div>
      </div>

    </div>
  );
}
