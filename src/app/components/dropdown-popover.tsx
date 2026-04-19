'use client';

/**
 * DropdownPopover — a dropdown panel that ALWAYS stacks above everything.
 *
 * Why this exists: using `z-50` inside a component doesn't help when any
 * ancestor creates a new stacking context (`transform`, `filter`, `overflow:
 * hidden`, `will-change`, `isolation: isolate`, etc.) — the child's z-index
 * is capped by the ancestor. Every dropdown we built hit this problem (the
 * gallery panel, the prompt bar, the image grid, etc.).
 *
 * Solution: render the panel into `#modal-root` via a portal and pin it
 * at a computed fixed-position using the trigger's bounding rect. Also
 * close on outside-click — checking BOTH the trigger ref and the portaled
 * panel ref (since DOM containment across portals doesn't work).
 *
 * ── Usage pattern (copy this for any new dropdown) ────────────────────────
 *
 *   const [open, setOpen] = useState(false);
 *   const triggerRef = useRef<HTMLButtonElement>(null);
 *
 *   return (
 *     <>
 *       <button ref={triggerRef} onClick={() => setOpen(!open)}>…</button>
 *       <DropdownPopover
 *         open={open}
 *         onClose={() => setOpen(false)}
 *         triggerRef={triggerRef}
 *         align="start"      // 'start' | 'end' (left-align or right-align)
 *         direction="down"   // 'down' | 'up'
 *       >
 *         …menu items…
 *       </DropdownPopover>
 *     </>
 *   );
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface DropdownPopoverProps {
  open: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLElement>;
  align?: 'start' | 'end';
  direction?: 'down' | 'up';
  offset?: number;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export function DropdownPopover({
  open,
  onClose,
  triggerRef,
  align = 'start',
  direction = 'down',
  offset = 8,
  children,
  className = '',
  style,
}: DropdownPopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; right: number } | null>(null);

  // Compute position from trigger rect
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const compute = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      let top = 0;
      if (direction === 'down') top = rect.bottom + offset;
      else top = rect.top - offset; // caller handles transform for "up"
      const left = align === 'start' ? rect.left : 0;
      const right = align === 'end' ? window.innerWidth - rect.right : 0;
      setPos({ top, left, right });
    };
    compute();
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [open, triggerRef, align, direction, offset]);

  // Close on outside click (considering BOTH trigger and portaled panel)
  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      onClose();
    };
    // Defer so the click that opened us isn't immediately caught
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handler);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handler);
    };
  }, [open, onClose, triggerRef]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open || !pos) return null;

  const root = document.getElementById('modal-root') || document.body;

  const positionStyle: React.CSSProperties = {
    position: 'fixed',
    zIndex: 10000,
    ...(direction === 'down' ? { top: pos.top } : { bottom: window.innerHeight - pos.top }),
    ...(align === 'start' ? { left: pos.left } : { right: pos.right }),
  };

  return createPortal(
    <div
      ref={panelRef}
      className={className}
      style={{ ...positionStyle, ...style }}
    >
      {children}
    </div>,
    root
  );
}
