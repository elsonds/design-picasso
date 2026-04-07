import { useEffect, useRef, useMemo } from "react";
import { ASPECT_RATIOS } from "./types";

interface GenerationVisualProps {
  phase: string;
  progress: number; // 0–100
  onCancel?: () => void;
  selectedRatio?: string;
}

/** Compute display frame size — longest side capped at MAX_PX */
export function frameDims(ratio: string, maxPx = 380): { w: number; h: number } {
  const ar = ASPECT_RATIOS[ratio];
  if (!ar) return { w: maxPx, h: maxPx };
  const scale = maxPx / Math.max(ar.width, ar.height);
  return {
    w: Math.round(ar.width * scale),
    h: Math.round(ar.height * scale),
  };
}

// ─── Constants (pixel-perfect match to ruyi-engine HTML) ─────────────────────
const GRID = 20;
const TOTAL = GRID * GRID; // 400

// Ball physics — 280-unit SVG viewBox coordinate system
const VB = 280;
const BALL_CX = 140;
const BALL_CY_FLOOR = 140;
const BALL_RX = 6;
const BALL_RY = 6;
const BOUNCE_AMP = 75; // cy 140 → 65

// Bounce timing
const MAX_BOUNCE_T = 45_000;
const BOUNCE_START = 2200;
const BOUNCE_DECAY = 0.92;
const BOUNCE_MIN = 800;

// Float / slam
const FLOAT_T = 4000;
const SLAM_T = 1000;
const FLOAT_D = 110; // cy 140 → 30

// Ripple
const RIP_SPEED = 45;
const RIP_SPEED_M = 70;
const RIP_DUR = 1200;
const RIP_DUR_M = 1600;

// Canvas settled colours (dark-mode)
const SETTLED = ["#1a1e2e", "#141825", "#171b28", "#12161f"];

// Progress thresholds
const BALL_TRANS = 28;
const FILL_S = 30;
const FILL_E = 75;
const SHIMMER_S = 76;
const FINAL_S = 90;

// Fill pacing
const FILL_PPS = 25; // pixels per second when catching up to target
const DRIP_MS = 280; // ms between "drip" pixels to prevent static pauses

type BallPhase = "bouncing" | "floating" | "slamming" | "impacted";

export function GenerationVisual({ phase, progress, onCancel, selectedRatio }: GenerationVisualProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ballRef = useRef<SVGEllipseElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const solidRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef(progress);
  const frame = useMemo(() => frameDims(selectedRatio || "1:1"), [selectedRatio]);

  // Sync progress ref for the animation loop
  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  // ─── Grid build + animation loop ──────────────────────────────────────────
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;

    const t0 = Date.now();
    let raf = 0;
    let bPhase: BallPhase = "bouncing";
    let bTransT = 0;
    let floatFromCy = BALL_CY_FLOOR;
    let lastBI = -1;
    let filled = 0;
    let fillTarget = 0;
    let fillAccum = 0; // fractional pixel accumulator
    let lastFillT = 0; // timestamp of last fill step
    let shimmered = false;
    let artReady = false;

    // ── Bounce map ───────────────────────────────────────────────────────────
    const bMap: { s: number; d: number }[] = [];
    let ct = 0,
      bd = BOUNCE_START;
    while (ct < MAX_BOUNCE_T) {
      if (ct + bd >= MAX_BOUNCE_T) {
        const r = MAX_BOUNCE_T - ct;
        if (r < 400 && bMap.length > 0) bMap[bMap.length - 1].d += r;
        else bMap.push({ s: ct, d: r });
        break;
      }
      bMap.push({ s: ct, d: bd });
      ct += bd;
      bd = Math.max(BOUNCE_MIN, bd * BOUNCE_DECAY);
    }

    // ── Pixel grid ───────────────────────────────────────────────────────────
    grid.innerHTML = "";
    const px: HTMLDivElement[] = [];
    const fOrder: { i: number; sc: number }[] = [];
    const mid = (GRID - 1) / 2;

    for (let i = 0; i < TOTAL; i++) {
      const el = document.createElement("div");
      el.style.cssText =
        "background:transparent;opacity:0;border:1px solid transparent;box-sizing:border-box;filter:brightness(1);";

      const x = i % GRID,
        y = Math.floor(i / GRID);
      const ratio = x / (GRID - 1);
      let r: number, g: number, b: number;
      if (ratio < 0.5) {
        const t = ratio * 2;
        r = Math.round(255 + (225 - 255) * t);
        g = Math.round(174 + (17 - 174) * t);
        b = Math.round(1 + (111 - 1) * t);
      } else {
        const t = (ratio - 0.5) * 2;
        r = Math.round(225 + (130 - 225) * t);
        g = Math.round(17 + (57 - 17) * t);
        b = Math.round(111 + (223 - 111) * t);
      }
      el.dataset.gi = `rgba(${r},${g},${b},0.5)`;
      el.dataset.gf = `rgba(${r},${g},${b},0.15)`;

      grid.appendChild(el);
      px.push(el);

      const dist = Math.sqrt((x - mid) ** 2 + (y - mid) ** 2);
      fOrder.push({ i, sc: dist + Math.random() * 6 });
    }
    fOrder.sort((a, b) => a.sc - b.sc);

    // ── Ripple — borderColor-based (matches HTML reference) ──────────────────
    function ripple(massive = false, intensity = 0.5) {
      const speed = massive ? RIP_SPEED_M : RIP_SPEED;
      const dur = massive ? RIP_DUR_M : RIP_DUR;
      px.forEach((p, i) => {
        if (p.dataset.a === "1") return;
        const x = i % GRID,
          y = Math.floor(i / GRID);
        const d = Math.sqrt((x - mid) ** 2 + (y - mid) ** 2);
        const delay = Math.max(0, d - 0.707) * speed;
        setTimeout(() => {
          if (p.dataset.a === "1") return;
          if (massive) {
            p.animate(
              [
                {
                  opacity: 1,
                  borderColor: p.dataset.gi,
                  backgroundColor: "transparent",
                },
                {
                  opacity: 0.6,
                  borderColor: p.dataset.gf,
                  backgroundColor: "transparent",
                  offset: 0.25,
                },
                {
                  opacity: 0,
                  borderColor: "transparent",
                  backgroundColor: "transparent",
                },
              ],
              { duration: dur, easing: "ease-out" },
            );
          } else {
            p.animate(
              [
                {
                  opacity: 0,
                  borderColor: "transparent",
                  backgroundColor: "transparent",
                },
                {
                  opacity: intensity,
                  borderColor: "rgba(148,163,184,0.3)",
                  backgroundColor: "transparent",
                  offset: 0.5,
                },
                {
                  opacity: 0,
                  borderColor: "transparent",
                  backgroundColor: "transparent",
                },
              ],
              { duration: dur, easing: "ease-in-out" },
            );
          }
        }, delay);
      });
    }

    // ── Activate pixel ───────────────────────────────────────────────────────
    function activate(idx: number) {
      const p = px[idx];
      if (!p || p.dataset.a === "1") return;
      p.dataset.a = "1";
      const col = SETTLED[Math.floor(Math.random() * SETTLED.length)];
      p.animate(
        [
          {
            opacity: 0,
            backgroundColor: "transparent",
            borderColor: "rgba(148,163,184,0.3)",
            filter: "brightness(1)",
          },
          {
            opacity: 1,
            backgroundColor: "#475569",
            borderColor: "transparent",
            filter: "brightness(1.2)",
            offset: 0.3,
          },
          {
            opacity: 1,
            backgroundColor: col,
            borderColor: "transparent",
            filter: "brightness(1)",
          },
        ],
        { duration: 600, easing: "ease-out", fill: "forwards" },
      );
    }

    // ── Find bounce cycle ────────────────────────────────────────────────────
    function findBounce(t: number) {
      let cb = bMap[0];
      for (let j = bMap.length - 1; j >= 0; j--) {
        if (t >= bMap[j].s) {
          cb = bMap[j];
          break;
        }
      }
      return { cb, idx: bMap.indexOf(cb) };
    }

    // ── Impact helper — centralises ball hide + ripple + fill timer init ─────
    function doImpact(now: number) {
      const ball = ballRef.current;
      if (ball) ball.style.opacity = "0";
      bPhase = "impacted";
      lastFillT = now; // start fill timer from NOW — prevents initial burst
      fillAccum = 0;
      ripple(true);
    }

    // ── Main tick ────────────────────────────────────────────────────────────
    function tick() {
      const ball = ballRef.current;
      const now = Date.now();
      const elapsed = now - t0;
      const prog = progressRef.current;

      // ─── BALL STATE MACHINE ────────────────────────────────────────────────
      if (ball) {
        if (bPhase === "bouncing") {
          // Force-impact if progress jumped way ahead
          if (prog >= 40) {
            doImpact(now);
          } else if (prog >= BALL_TRANS) {
            const t = elapsed % MAX_BOUNCE_T;
            const { cb } = findBounce(t);
            const p = (t - cb.s) / cb.d;
            if (p < 0.5 || p > 0.93) {
              floatFromCy = parseFloat(
                ball.getAttribute("cy") || String(BALL_CY_FLOOR),
              );
              bPhase = "floating";
              bTransT = now;
            }
          }

          // Still bouncing? Animate.
          if (bPhase === "bouncing") {
            const t = elapsed % MAX_BOUNCE_T;
            const { cb, idx: ci } = findBounce(t);
            const p = (t - cb.s) / cb.d;
            const arc = 4 * p * (1 - p);
            ball.setAttribute(
              "cy",
              String(BALL_CY_FLOOR - arc * BOUNCE_AMP),
            );

            let rx = BALL_RX,
              ry = BALL_RY;
            if (p < 0.08) {
              const s = p / 0.08;
              rx = BALL_RX + (1 - s) * 1.5;
              ry = BALL_RY - (1 - s) * 1.0;
            } else if (p > 0.92) {
              const s = (1 - p) / 0.08;
              rx = BALL_RX + (1 - s) * 1.5;
              ry = BALL_RY - (1 - s) * 1.0;
            } else {
              const stretch = Math.abs(0.5 - p) * 2;
              rx = BALL_RX - stretch * 0.5;
              ry = BALL_RY + stretch * 1.0;
            }
            ball.setAttribute("rx", String(rx));
            ball.setAttribute("ry", String(ry));

            if (ci > lastBI) {
              if (ci > 0) {
                const pp = Math.min(elapsed / MAX_BOUNCE_T, 1);
                ripple(false, 0.1 + pp * 0.5);
              }
              lastBI = ci;
            }
            if (ci < lastBI) lastBI = ci;
          }
        }

        // FLOATING
        if (bPhase === "floating") {
          const dt = now - bTransT;
          if (dt < FLOAT_T) {
            const p = dt / FLOAT_T;
            const ease = 1 - Math.pow(1 - p, 3);
            const target = BALL_CY_FLOOR - FLOAT_D;
            ball.setAttribute(
              "cy",
              String(floatFromCy + ease * (target - floatFromCy)),
            );
            ball.setAttribute("rx", String(BALL_RX));
            ball.setAttribute("ry", String(BALL_RY));
          } else {
            bPhase = "slamming";
            bTransT = now;
          }
        }

        // SLAMMING
        if (bPhase === "slamming") {
          const dt = now - bTransT;
          if (dt < SLAM_T) {
            const p = dt / SLAM_T;
            const ease = Math.pow(p, 4);
            const top = BALL_CY_FLOOR - FLOAT_D;
            ball.setAttribute("cy", String(top + ease * FLOAT_D));
            ball.setAttribute(
              "rx",
              String(Math.max(BALL_RX - ease * 1.5, BALL_RX - 1.5)),
            );
            ball.setAttribute("ry", String(BALL_RY + ease * 2.5));
          } else {
            doImpact(now);
          }
        }
      }

      // ─── PIXEL FILL — only after ball impact (smooth + drip, never pauses) ─
      if (prog >= FILL_S && bPhase === "impacted" && filled < TOTAL && !shimmered) {
        const fp = Math.min(
          Math.max((prog - FILL_S) / (FILL_E - FILL_S), 0),
          1,
        );
        const hardTarget = Math.floor(fp * TOTAL);

        // Ramp fillTarget toward hardTarget using time-based pacing
        if (fillTarget < hardTarget) {
          const dt = now - lastFillT;
          fillAccum += (dt / 1000) * FILL_PPS;
          const step = Math.floor(fillAccum);
          if (step > 0) {
            fillAccum -= step;
            fillTarget = Math.min(fillTarget + step, hardTarget);
          }
          lastFillT = now;
        }

        // Activate pixels up to fillTarget
        while (filled < fillTarget && filled < fOrder.length) {
          activate(fOrder[filled].i);
          filled++;
        }

        // Drip: when caught up, keep activating 1 pixel every DRIP_MS
        if (
          filled >= fillTarget &&
          filled < TOTAL &&
          now - lastFillT > DRIP_MS
        ) {
          activate(fOrder[filled].i);
          filled++;
          fillTarget = filled;
          lastFillT = now;
        }

        // Scatter: occasional random ahead-fill for organic feel
        if (Math.random() > 0.93 && filled + 5 < TOTAL) {
          const ahead = filled + Math.floor(Math.random() * 15) + 1;
          if (ahead < TOTAL) activate(fOrder[ahead].i);
        }
      }

      // ─── SHIMMER — fires the INSTANT grid is full OR progress passes threshold ─
      if (
        (filled >= TOTAL || prog >= SHIMMER_S) &&
        bPhase === "impacted" &&
        solidRef.current &&
        !shimmered
      ) {
        solidRef.current.style.opacity = "1";
        // Bulk-activate any stragglers so grid is guaranteed 100% filled
        for (let i = filled; i < fOrder.length; i++) activate(fOrder[i].i);
        filled = TOTAL;
        fillTarget = TOTAL;

        shimmered = true;
        px.forEach((p, i) => {
          const x = i % GRID,
            y = Math.floor(i / GRID);
          setTimeout(() => {
            p.animate(
              [
                {
                  opacity: 1,
                  filter: "brightness(1.6)",
                  boxShadow: "inset 0 0 4px rgba(200,210,230,0.12)",
                },
                {
                  opacity: 0.25,
                  filter: "brightness(0.5)",
                  boxShadow: "none",
                  offset: 0.2,
                },
                {
                  opacity: 0.25,
                  filter: "brightness(0.5)",
                  boxShadow: "none",
                },
              ],
              {
                duration: 3000,
                easing: "ease-in-out",
                iterations: Infinity,
              },
            );
          }, x * 80 + y * 20);
        });
      }

      // ─── FINAL — border trace + shimmer clearing wave (matches HTML ref) ────
      if (prog >= FINAL_S && !artReady) {
        artReady = true;
        containerRef.current?.classList.add("artwork-ready");

        // Gracefully terminate the shimmer loop with a left-to-right clearing wave
        // exactly like the HTML reference: cancel infinite animations, settle to full opacity
        px.forEach((p, i) => {
          const x = i % GRID;
          setTimeout(() => {
            // Cancel all Web Animations (the infinite shimmer + any prior fill animations)
            p.getAnimations().forEach((a) => a.cancel());
            // Commit final inline styles so pixel stays visible after animation cancel
            const col = SETTLED[Math.floor(Math.random() * SETTLED.length)];
            p.style.transition =
              "opacity 0.8s ease, filter 0.8s ease, background-color 0.8s ease";
            p.style.opacity = "1";
            p.style.filter = "brightness(1)";
            p.style.backgroundColor = col;
            p.style.borderColor = "transparent";
          }, x * 40); // 20 columns × 40ms = 800ms left-to-right sweep
        });
      }

      raf = requestAnimationFrame(tick);
    }

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const done = progress >= 100;
  const DASH = VB + VB; // 560

  return (
    <>
      <style>{`
        @keyframes gv-gradient-shift {
          0%   { background-position: 100% 0; }
          100% { background-position: -100% 0; }
        }
        @keyframes gv-trace-split {
          0%   { stroke-dashoffset: ${DASH}; opacity: 0; }
          10%  { opacity: 1; }
          80%  { stroke-dashoffset: 0; opacity: 1; }
          100% { stroke-dashoffset: 0; opacity: 0; }
        }
        @keyframes gv-star-burst {
          0%, 75% { transform: scale(0) rotate(-45deg); opacity: 0; }
          85%     { transform: scale(0.35) rotate(0deg); opacity: 1;
                    filter: drop-shadow(0 0 15px rgba(255,255,255,1)); }
          100%    { transform: scale(0) rotate(45deg); opacity: 0; }
        }
        .artwork-ready .gv-stroke {
          animation: gv-trace-split 2.5s cubic-bezier(.4,0,.2,1) forwards !important;
        }
        .artwork-ready .gv-star {
          animation: gv-star-burst 2.5s cubic-bezier(.4,0,.2,1) forwards !important;
        }
      `}</style>

      {/* ── Container — matches the image output container exactly ────────────── */}
      <div
        className="rounded-xl border border-white/5"
        style={{ background: "rgba(22, 22, 32, 0.9)", overflow: "visible" }}
      >
        {/* Frame size matches selected aspect ratio */}
        <div
          ref={containerRef}
          className="relative bg-black/40 mx-auto"
          style={{ width: frame.w, height: frame.h }}
        >
          {/* SVG defs */}
          <svg width="0" height="0" className="absolute">
            <defs>
              <linearGradient
                id="gv-grad"
                x1="0%"
                y1="0%"
                x2="0%"
                y2="100%"
              >
                <stop offset="0%" stopColor="#FFAE01" />
                <stop offset="50%" stopColor="#E1116F" />
                <stop offset="100%" stopColor="#8239DF" />
              </linearGradient>
              <linearGradient
                id="gv-trace"
                x1="0%"
                y1="100%"
                x2="100%"
                y2="0%"
              >
                <stop offset="0%" stopColor="rgba(255,255,255,0)" />
                <stop
                  offset="60%"
                  stopColor="rgba(255,255,255,0.35)"
                />
                <stop offset="100%" stopColor="#ffffff" />
              </linearGradient>
              <g id="gv-star">
                <path
                  d="M800.281 86.9852C801.514 88.3596 802.713 102.078 803.415 105.415C811.659 144.611 829.207 147.679 864.238 155.929C852.443 156.603 835.608 160.195 825.576 166.832C806.402 179.518 804.325 203.446 800.046 223.756C799.263 222.145 799.025 220.207 798.839 218.427C794.186 174.106 778.19 161.062 735.844 155.839C748.133 153.267 764.406 150.722 775.062 144.228C789.062 135.696 794.855 118.936 797.93 103.688C798.953 98.6156 798.906 93.0121 800.138 87.596L800.281 86.9852Z"
                  fill="#FEFEFE"
                  transform="translate(-800, -155.3)"
                />
              </g>
            </defs>
          </svg>

          {/* Solid canvas bg */}
          <div
            ref={solidRef}
            className="absolute inset-0 z-[1]"
            style={{
              background: "linear-gradient(135deg, #181c2a, #0e1018)",
              opacity: 0,
              transition: "opacity 1.5s ease",
            }}
          />

          {/* Pixel grid — fills entire container */}
          <div
            ref={gridRef}
            className="absolute inset-0 z-[2] overflow-hidden"
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${GRID}, 1fr)`,
              gridTemplateRows: `repeat(${GRID}, 1fr)`,
            }}
          />

          {/* Bouncing ball — viewBox scales proportionally */}
          <svg
            className="absolute inset-0 w-full h-full z-[4] pointer-events-none"
            viewBox={`0 0 ${VB} ${VB}`}
          >
            <ellipse
              ref={ballRef}
              cx={BALL_CX}
              cy={BALL_CY_FLOOR}
              rx={BALL_RX}
              ry={BALL_RY}
              fill="url(#gv-grad)"
              style={{
                filter:
                  "drop-shadow(0 0 10px rgba(225,17,111,0.6))",
                transition: "opacity 0.15s ease",
              }}
            />
          </svg>

          {/* Border trace + sparkle */}
          <svg
            className="absolute inset-0 w-full h-full z-[5] pointer-events-none overflow-visible"
            viewBox={`0 0 ${VB} ${VB}`}
          >
            <path
              d={`M 0,${VB} L 0,0 L ${VB},0`}
              className="gv-stroke"
              fill="none"
              stroke="url(#gv-trace)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={DASH}
              strokeDashoffset={DASH}
              style={{ opacity: 0 }}
            />
            <path
              d={`M 0,${VB} L ${VB},${VB} L ${VB},0`}
              className="gv-stroke"
              fill="none"
              stroke="url(#gv-trace)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={DASH}
              strokeDashoffset={DASH}
              style={{ opacity: 0 }}
            />
            <use
              href="#gv-star"
              className="gv-star"
              x={VB}
              y="0"
              style={{ transformOrigin: `${VB}px 0px`, opacity: 0 }}
            />
          </svg>
        </div>
      </div>

      {/* ── Status ─────────────────────────────────────────────────────────────── */}
      <div className="text-[13px] font-normal tracking-wide text-[#c8cdd8] font-['Inter',sans-serif] px-0.5">
        {done ? "Artwork Ready!" : phase || "Initializing..."}
      </div>

      {/* ── Progress bar ───────────────────────────────────────────────────────── */}
      <div
        className="rounded overflow-hidden"
        style={{
          width: "100%",
          height: 3,
          backgroundColor: "rgba(255,255,255,0.04)",
        }}
      >
        <div
          className="h-full rounded"
          style={{
            width: `${Math.min(progress, 100)}%`,
            background:
              "linear-gradient(90deg, #E1116F, #FFAE01, #E1116F)",
            backgroundSize: "200% 100%",
            animation: "gv-gradient-shift 2s linear infinite",
            transition: "width 0.3s ease",
          }}
        />
      </div>

      {/* Cancel button */}
      {onCancel && !done && (
        <button
          onClick={onCancel}
          className="mt-1 px-3 py-1 rounded-lg text-[12px] font-medium font-['Inter',sans-serif] text-[#b0b0b8] border border-white/8 hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/20 transition-colors"
          style={{ background: "rgba(22, 22, 32, 0.6)" }}
        >
          Stop Generation
        </button>
      )}
    </>
  );
}