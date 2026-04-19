'use client';

import React, { useEffect, useState } from 'react';
import { Activity, ChevronDown, ChevronUp, Loader2, Clock } from 'lucide-react';
import { fetchRecentActivity, type ActivityEntry } from './api-service';
import type { StatusInfo } from './types';

const HIDE_KEY = 'picasso_activity_feed_hidden';

interface ActivityFeedProps {
  statusInfo?: StatusInfo;
}

function userPart(entry: ActivityEntry): string {
  if (entry.email) return entry.email.split('@')[0];
  if (entry.user_id) return entry.user_id.slice(0, 8);
  return 'someone';
}

function formatEta(seconds: number): string {
  if (seconds <= 0) return 'now';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 5 && s > 0) return `${m}m ${s}s`;
  return `${m}m`;
}

// Longest a single generation is expected to take. Anything older than
// this with no resolution event is treated as stale (dropped from the feed).
const STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * Collapse entries by job_id and return only the ones that haven't resolved
 * (not completed / failed / cancelled) and aren't stale. Sorted oldest first.
 */
function buildInFlight(entries: ActivityEntry[]): ActivityEntry[] {
  const byJob = new Map<string, ActivityEntry[]>();
  for (const e of entries) {
    if (!e.job_id) continue;
    const arr = byJob.get(e.job_id) || [];
    arr.push(e);
    byJob.set(e.job_id, arr);
  }

  const now = Date.now();
  const active: ActivityEntry[] = [];
  for (const group of byJob.values()) {
    const hasDone = group.some(
      (e) =>
        e.event === 'generation.completed' ||
        e.event === 'generation.failed' ||
        e.event === 'generation.cancelled'
    );
    if (hasDone) continue;
    const req = group.find((e) => e.event === 'generation.requested');
    if (!req) continue;
    // Drop stale entries — likely a cancel/fail that never made it to the log.
    if (now - req.timestamp > STALE_AFTER_MS) continue;
    active.push(req);
  }

  return active.sort((a, b) => a.timestamp - b.timestamp);
}

export function ActivityFeed({ statusInfo }: ActivityFeedProps) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(HIDE_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    let mounted = true;
    const poll = async () => {
      // Fetch more entries so we can accurately detect completed jobs
      const data = await fetchRecentActivity(50);
      if (mounted) setEntries(data);
    };
    poll();
    const interval = setInterval(poll, hidden ? 15000 : 5000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [hidden]);

  const inFlight = buildInFlight(entries);
  const activeCount = inFlight.length;

  // Average generation time — use what the server tracks, per execution mode.
  // Falls back per-mode default if no data yet.
  const avgSeconds = statusInfo?.avg_exec_seconds
    ?? (statusInfo?.execution_mode === 'pod' ? 30 : 45);

  // Effective worker count for ETA math. Pod = 1 GPU sequential.
  // Serverless = max(1, active workers).
  const workers =
    statusInfo?.execution_mode === 'serverless'
      ? Math.max(1, (statusInfo.workers?.idle || 0) + (statusInfo.workers?.running || 0))
      : 1;

  // Total remaining time if nothing else is added (position-based).
  const totalEta =
    activeCount > 0 ? Math.round((activeCount * avgSeconds) / workers) : 0;

  const toggle = () => {
    const next = !hidden;
    setHidden(next);
    try {
      localStorage.setItem(HIDE_KEY, next ? '1' : '0');
    } catch { /* ignore */ }
  };

  return (
    <div
      className="fixed bottom-3 left-3 z-30 select-none"
      style={{ fontFamily: 'Inter, system-ui, sans-serif' }}
    >
      {!hidden && activeCount > 0 && (
        <div
          className="mb-2 flex flex-col items-start gap-0.5"
          style={{ maxWidth: '90vw' }}
        >
          {/* Per-item active list — each row hugs its content */}
          {inFlight.slice(0, 6).map((e, i) => {
            const who = userPart(e);
            const posEta = Math.round(((i + 1) * avgSeconds) / workers);
            const isRunning = i === 0;
            const Icon = isRunning ? Loader2 : Clock;
            const label = isRunning ? 'generating' : `queued (#${i})`;
            return (
              <div
                key={e.job_id || e.timestamp}
                className="flex items-center gap-1.5 text-[11px] leading-tight"
                style={{
                  color: isRunning ? '#86efac' : '#94a3b8',
                  opacity: Math.max(0.55, 1 - i * 0.08),
                }}
              >
                {/* State icon (hover title reveals the state in words) */}
                <Icon
                  size={11}
                  className={isRunning ? 'animate-spin' : ''}
                  style={{ flexShrink: 0 }}
                >
                  <title>{label}</title>
                </Icon>
                <span style={{ flexShrink: 0 }}>{who}</span>
                {e.prompt && (
                  <>
                    <span style={{ color: '#475569', flexShrink: 0 }}>·</span>
                    <span
                      className="overflow-hidden text-ellipsis whitespace-nowrap"
                      style={{ maxWidth: 220 }}
                      title={`${label} — ${e.prompt}`}
                    >
                      {e.prompt}
                    </span>
                  </>
                )}
                <span style={{ color: '#475569', flexShrink: 0, marginLeft: 6 }}>
                  ~{formatEta(posEta)}
                </span>
              </div>
            );
          })}
          {activeCount > 6 && (
            <div className="text-[10px] text-slate-600 flex items-center gap-1.5">
              <Clock size={9} />
              +{activeCount - 6} more
            </div>
          )}
        </div>
      )}

      {/* Toggle button with badge + total ETA */}
      <button
        onClick={toggle}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[13px] font-medium transition-all hover:bg-white/5"
        style={{
          color: '#94a3b8',
          backgroundColor: hidden ? 'transparent' : 'rgba(148,163,184,0.06)',
          border: '1px solid',
          borderColor: hidden
            ? 'rgba(148,163,184,0.08)'
            : 'rgba(148,163,184,0.15)',
        }}
        title={hidden ? 'Show activity' : 'Hide activity'}
      >
        <Activity size={13} />
        <span>Activity</span>
        {activeCount > 0 && (
          <>
            <span
              className="inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full text-[10px] font-semibold"
              style={{
                backgroundColor: 'rgba(34,197,94,0.15)',
                color: '#86efac',
              }}
            >
              {activeCount}
            </span>
            {totalEta > 0 && (
              <span className="text-[11px] opacity-70">
                · ~{formatEta(totalEta)}
              </span>
            )}
          </>
        )}
        {hidden ? (
          <ChevronUp size={10} style={{ opacity: 0.5 }} />
        ) : (
          <ChevronDown size={10} style={{ opacity: 0.5 }} />
        )}
      </button>
    </div>
  );
}
