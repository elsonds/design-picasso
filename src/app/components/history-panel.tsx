'use client';

import React, { useEffect, useState } from 'react';
import { X, Zap, Cpu, CheckCircle2, XCircle, Clock } from 'lucide-react';
import { fetchUserHistory, type ActivityEntry } from './api-service';

interface HistoryPanelProps {
  email: string | undefined;
  isOpen: boolean;
  onClose: () => void;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const now = Date.now();
  const diff = (now - ts) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function groupByJob(entries: ActivityEntry[]): Map<string, ActivityEntry[]> {
  const groups = new Map<string, ActivityEntry[]>();
  for (const e of entries) {
    const key = e.job_id || `req_${e.timestamp}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }
  return groups;
}

export function HistoryPanel({ email, isOpen, onClose }: HistoryPanelProps) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen || !email) return;
    setLoading(true);
    fetchUserHistory(email).then((data) => {
      setEntries(data);
      setLoading(false);
    });
  }, [isOpen, email]);

  if (!isOpen) return null;

  const grouped = groupByJob(entries);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40"
        style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
        onClick={onClose}
      />
      {/* Panel */}
      <div
        className="fixed top-0 right-0 h-full w-[420px] z-50 flex flex-col border-l"
        style={{
          backgroundColor: '#0c0f16',
          borderLeftColor: 'rgba(148,163,184,0.08)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3 border-b"
          style={{ borderBottomColor: 'rgba(148,163,184,0.08)' }}
        >
          <div>
            <h2 className="text-sm font-semibold text-slate-200">Activity Log</h2>
            <p className="text-[11px] text-slate-500 mt-0.5">{email}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/5 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="p-8 text-center text-slate-500 text-sm">Loading...</div>
          )}
          {!loading && entries.length === 0 && (
            <div className="p-8 text-center text-slate-500 text-sm">
              No activity yet. Generate something to see it here.
            </div>
          )}
          {!loading && entries.length > 0 && (
            <div className="divide-y" style={{ borderColor: 'rgba(148,163,184,0.05)' }}>
              {Array.from(grouped.values()).map((group) => {
                // Find the most informative entry (completed > failed > requested)
                const completed = group.find((e) => e.event === 'generation.completed');
                const failed = group.find((e) => e.event === 'generation.failed');
                const requested = group.find((e) => e.event === 'generation.requested');
                const primary = completed || failed || requested!;

                const isCompleted = !!completed;
                const isFailed = !!failed;
                const isPending = !isCompleted && !isFailed;

                return (
                  <div
                    key={(primary.job_id || primary.timestamp).toString()}
                    className="px-4 py-3 hover:bg-white/[0.02] transition-colors"
                  >
                    <div className="flex items-start gap-2.5">
                      <div className="mt-0.5 flex-shrink-0">
                        {isCompleted && <CheckCircle2 size={14} className="text-green-400" />}
                        {isFailed && <XCircle size={14} className="text-red-400" />}
                        {isPending && <Clock size={14} className="text-amber-400" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] text-slate-200 line-clamp-2 leading-snug">
                          {primary.prompt || <span className="text-slate-500 italic">No prompt</span>}
                        </div>
                        <div className="flex items-center flex-wrap gap-1.5 mt-1.5 text-[10px]">
                          <span className="text-slate-500">{formatTimestamp(primary.timestamp)}</span>
                          {primary.execution_mode && (
                            <span
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded"
                              style={{
                                backgroundColor: primary.execution_mode === 'pod'
                                  ? 'rgba(34,211,238,0.08)'
                                  : 'rgba(148,163,184,0.08)',
                                color: primary.execution_mode === 'pod' ? '#67e8f9' : '#94a3b8',
                              }}
                            >
                              {primary.execution_mode === 'pod' ? <Cpu size={9} /> : <Zap size={9} />}
                              {primary.execution_mode}
                            </span>
                          )}
                          {primary.style && (
                            <span className="px-1.5 py-0.5 rounded bg-white/5 text-slate-400">
                              {primary.style}
                            </span>
                          )}
                          {primary.flow && (
                            <span className="px-1.5 py-0.5 rounded bg-white/5 text-slate-400">
                              {primary.flow}
                            </span>
                          )}
                          {primary.mode === 'ControlNet' && (
                            <span className="px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-300">
                              ControlNet
                            </span>
                          )}
                          {isCompleted && primary.execution_time !== undefined && (
                            <span className="text-slate-500">
                              {primary.execution_time}s
                            </span>
                          )}
                        </div>
                        {isFailed && primary.error && (
                          <div className="mt-1.5 text-[11px] text-red-400/80 bg-red-500/5 px-2 py-1 rounded border border-red-500/10">
                            {primary.error}
                          </div>
                        )}
                        {(primary.seed || primary.width) && (
                          <div className="mt-1 text-[10px] text-slate-600 font-mono">
                            {primary.seed && `seed: ${primary.seed} · `}
                            {primary.width && `${primary.width}×${primary.height}`}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        {!loading && entries.length > 0 && (
          <div
            className="px-4 py-2 border-t text-[11px] text-slate-500"
            style={{ borderTopColor: 'rgba(148,163,184,0.08)' }}
          >
            {grouped.size} generation{grouped.size === 1 ? '' : 's'} shown
          </div>
        )}
      </div>
    </>
  );
}
