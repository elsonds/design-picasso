'use client';

import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Cpu, Zap, Square, AlertTriangle } from 'lucide-react';
import type { ExecutionMode, StatusInfo } from './types';
import { DropdownPopover } from './dropdown-popover';

interface ExecutionModeDropdownProps {
  executionMode: ExecutionMode;
  onExecutionModeChange: (mode: ExecutionMode) => void;
  statusInfo?: StatusInfo;
  onPodStop?: () => void;
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 5) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${m}m`;
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function ExecutionModeDropdown({
  executionMode,
  onExecutionModeChange,
  statusInfo,
  onPodStop,
}: ExecutionModeDropdownProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Live countdown for pod idle auto-stop. Resets whenever the server tells
  // us a new remaining value (e.g. after a fresh generation resets the timer).
  const [idleRemaining, setIdleRemaining] = useState<number | null>(null);

  useEffect(() => {
    const s = statusInfo?.idle_remaining_seconds;
    if (s === undefined || s === null) {
      setIdleRemaining(null);
      return;
    }
    setIdleRemaining(s);
  }, [statusInfo?.idle_remaining_seconds]);

  useEffect(() => {
    if (idleRemaining === null || idleRemaining <= 0) return;
    const tick = setInterval(() => {
      setIdleRemaining((prev) => {
        if (prev === null) return null;
        if (prev <= 1) return 0;
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, [idleRemaining]);

  // click-outside + Escape handled inside DropdownPopover

  const isPod = executionMode === 'pod';
  const podStatus = statusInfo?.pod_status;
  const podReady = podStatus === 'ready';
  const isDegraded = podStatus === 'degraded';
  const isStarting = podStatus === 'starting' || podStatus === 'comfyui_loading' || podStatus === 'creating';
  const isStopped = podStatus === 'stopped' || podStatus === 'none';
  const isUnknown = podStatus === 'unknown' || podStatus === 'error';

  // Status dot color — default gray until status is known
  const dotColor = !statusInfo ? '#64748b'         // gray - unknown/loading
    : isDegraded ? '#ef4444'                       // red - degraded
    : isUnknown ? '#ef4444'                        // red - unreachable
    : podReady ? '#22c55e'                         // green - ready
    : isStarting ? '#f59e0b'                       // amber - starting
    : isStopped ? '#64748b'                        // gray - stopped
    : '#64748b';

  // Short label for the button (shown during generation)
  const shortStatus = isDegraded ? 'No GPU'
    : isUnknown ? 'Offline'
    : podReady ? null
    : isStarting ? 'Starting'
    : isStopped && isPod ? 'Stopped'
    : null;

  // Total queue depth (both modes)
  const queueCount = executionMode === 'pod'
    ? (statusInfo?.queue_running || 0) + (statusInfo?.queue_pending || 0)
    : (statusInfo?.jobs?.inQueue || 0) + (statusInfo?.jobs?.inProgress || 0);
  const etaSeconds = statusInfo?.eta_seconds || 0;

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[13px] font-medium transition-all hover:bg-white/5"
        style={{
          color: isDegraded ? '#fca5a5' : isPod ? '#22d3ee' : '#94a3b8',
          backgroundColor: isDegraded ? 'rgba(239,68,68,0.08)' : isPod ? 'rgba(34,211,238,0.06)' : 'transparent',
          border: '1px solid',
          borderColor: isDegraded ? 'rgba(239,68,68,0.25)' : isPod ? 'rgba(34,211,238,0.15)' : 'rgba(148,163,184,0.08)',
        }}
        title={statusInfo?.message || ''}
      >
        <div
          className="w-1.5 h-1.5 rounded-full"
          style={{
            backgroundColor: dotColor,
            animation: isStarting ? 'pulse 1.5s ease-in-out infinite' : undefined,
          }}
        />
        {isDegraded ? <AlertTriangle size={13} /> : isPod ? <Cpu size={13} /> : <Zap size={13} />}
        {isPod ? 'Pod' : 'Serverless'}
        {shortStatus && (
          <span className="text-[11px] opacity-70">· {shortStatus}</span>
        )}
        {!shortStatus && queueCount > 0 && (
          <span className="text-[11px] opacity-70">
            · {queueCount} in queue{etaSeconds > 0 ? ` · ~${formatEta(etaSeconds)}` : ''}
          </span>
        )}
        {/* Pod idle auto-stop countdown */}
        {!shortStatus && isPod && podReady && queueCount === 0 && idleRemaining !== null && (
          <span
            className="text-[11px]"
            style={{ color: idleRemaining < 30 ? '#fca5a5' : idleRemaining < 60 ? '#fbbf24' : '#94a3b8' }}
          >
            · stops in {formatCountdown(idleRemaining)}
          </span>
        )}
        <ChevronDown size={10} style={{ opacity: 0.4 }} />
      </button>

      <DropdownPopover
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        align="start"
        direction="down"
      >
        <div
          className="rounded-xl border py-1 min-w-[260px]"
          style={{
            backgroundColor: '#1a1f2e',
            borderColor: 'rgba(148,163,184,0.1)',
            backdropFilter: 'blur(20px)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          }}
        >
          {/* Status summary */}
          {statusInfo && (
            <div className="px-3 py-2 border-b" style={{ borderBottomColor: 'rgba(148,163,184,0.08)' }}>
              <div className="flex items-center gap-2 mb-1">
                <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: dotColor }} />
                <span className="text-[11px] font-semibold uppercase tracking-wider" style={{
                  color: isDegraded || isUnknown ? '#fca5a5' : podReady ? '#86efac' : '#fbbf24',
                }}>
                  {isDegraded ? 'Degraded' : isUnknown ? 'Unreachable' : podReady ? 'Healthy' : isStarting ? 'Starting' : isStopped ? 'Stopped' : 'Unknown'}
                </span>
              </div>
              <div className="text-[11px] text-slate-400 leading-tight">
                {statusInfo.message}
              </div>
              {/* Serverless worker/queue details */}
              {executionMode === 'serverless' && statusInfo.workers && (
                <div className="mt-1.5 flex items-center gap-3 text-[10px] text-slate-500">
                  <span>Workers: <span className="text-slate-300">{statusInfo.workers.idle}i / {statusInfo.workers.running}r / {statusInfo.workers.initializing}s</span></span>
                  {statusInfo.jobs && (
                    <span>Queue: <span className={statusInfo.jobs.inQueue > 0 && statusInfo.workers.total === 0 ? 'text-red-400' : 'text-slate-300'}>{statusInfo.jobs.inQueue}</span></span>
                  )}
                </div>
              )}
              {/* Pod details */}
              {executionMode === 'pod' && (
                <>
                  {statusInfo.gpu && (
                    <div className="mt-1.5 text-[10px] text-slate-500">
                      GPU: <span className="text-slate-300">{statusInfo.gpu}</span>
                      {statusInfo.cost_per_hr && <span> · ${statusInfo.cost_per_hr}/hr</span>}
                    </div>
                  )}
                  {(statusInfo.queue_running !== undefined || statusInfo.queue_pending !== undefined) && (
                    <div className="mt-1 text-[10px] text-slate-500">
                      Queue: <span className="text-slate-300">
                        {(statusInfo.queue_running || 0)} running, {(statusInfo.queue_pending || 0)} pending
                      </span>
                    </div>
                  )}
                  {podReady && idleRemaining !== null && (
                    <div className="mt-1 text-[10px] text-slate-500">
                      Auto-stops in{' '}
                      <span
                        className="font-mono"
                        style={{
                          color:
                            idleRemaining < 30
                              ? '#fca5a5'
                              : idleRemaining < 60
                                ? '#fbbf24'
                                : '#cbd5e1',
                        }}
                      >
                        {formatCountdown(idleRemaining)}
                      </span>
                      {statusInfo.idle_timeout_seconds && (
                        <span className="opacity-60">
                          {' '}({Math.round(statusInfo.idle_timeout_seconds / 60)}m idle)
                        </span>
                      )}
                    </div>
                  )}
                </>
              )}
              {/* ETA */}
              {statusInfo.eta_seconds !== undefined && statusInfo.eta_seconds > 0 && (
                <div className="mt-1 text-[10px] text-slate-500">
                  Est. wait: <span className="text-slate-300">~{formatEta(statusInfo.eta_seconds)}</span>
                  {statusInfo.avg_exec_seconds && <span className="opacity-60"> (avg {statusInfo.avg_exec_seconds}s/gen)</span>}
                </div>
              )}
            </div>
          )}

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
      </DropdownPopover>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </>
  );
}
