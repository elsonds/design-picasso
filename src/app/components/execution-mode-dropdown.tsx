'use client';

import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Cpu, Zap, Square } from 'lucide-react';
import type { ExecutionMode } from './types';

interface ExecutionModeDropdownProps {
  executionMode: ExecutionMode;
  onExecutionModeChange: (mode: ExecutionMode) => void;
  podStatus?: string;
  onPodStop?: () => void;
}

export function ExecutionModeDropdown({
  executionMode,
  onExecutionModeChange,
  podStatus,
  onPodStop,
}: ExecutionModeDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const isPod = executionMode === 'pod';
  const podReady = podStatus === 'ready';

  // Status dot color
  const dotColor = isPod
    ? podReady ? '#22c55e' : podStatus === 'stopped' || podStatus === 'none' ? '#64748b' : '#f59e0b'
    : '#22c55e';

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[13px] font-medium transition-all hover:bg-white/5"
        style={{
          color: isPod ? '#22d3ee' : '#94a3b8',
          backgroundColor: isPod ? 'rgba(34,211,238,0.06)' : 'transparent',
          border: '1px solid',
          borderColor: isPod ? 'rgba(34,211,238,0.15)' : 'rgba(148,163,184,0.08)',
        }}
      >
        <div
          className="w-1.5 h-1.5 rounded-full"
          style={{ backgroundColor: dotColor }}
        />
        {isPod ? <Cpu size={13} /> : <Zap size={13} />}
        {isPod ? 'Pod' : 'Serverless'}
        <ChevronDown size={10} style={{ opacity: 0.4 }} />
      </button>

      {open && (
        <div
          className="absolute top-full right-0 mt-2 rounded-xl border py-1 min-w-[200px] z-50"
          style={{
            backgroundColor: '#1a1f2e',
            borderColor: 'rgba(148,163,184,0.1)',
            backdropFilter: 'blur(20px)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          }}
        >
          <button
            onClick={() => { onExecutionModeChange('serverless'); setOpen(false); }}
            className={`w-full px-3 py-2.5 text-left text-xs transition-colors flex items-center gap-2.5 ${
              !isPod
                ? 'text-slate-200 bg-white/5'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
            }`}
          >
            <Zap size={13} />
            <div>
              <span className="font-medium">Serverless</span>
              <span className="block text-[10px] opacity-50 mt-0.5">Auto-scale, pay per request</span>
            </div>
          </button>

          <div className="h-px bg-white/5 my-0.5" />

          <button
            onClick={() => { onExecutionModeChange('pod'); setOpen(false); }}
            className={`w-full px-3 py-2.5 text-left text-xs transition-colors flex items-center gap-2.5 ${
              isPod
                ? 'text-cyan-300 bg-cyan-500/5'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
            }`}
          >
            <Cpu size={13} />
            <div>
              <span className="font-medium">Pod</span>
              <span className="block text-[10px] opacity-50 mt-0.5">Persistent GPU, auto-detects running pods</span>
            </div>
          </button>

          {isPod && podReady && onPodStop && (
            <>
              <div className="h-px bg-white/5 my-0.5" />
              <button
                onClick={() => { onPodStop(); setOpen(false); }}
                className="w-full px-3 py-2.5 text-left text-xs text-red-400 hover:text-red-300 hover:bg-red-500/5 transition-colors flex items-center gap-2.5"
              >
                <Square size={11} />
                <span className="font-medium">Stop Pod</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
