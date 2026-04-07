import { STYLE_CONFIG, type StyleKey } from "./brand-logos";
import { Lock } from "lucide-react";

interface StyleSidebarProps {
  selectedStyle: StyleKey;
  onSelectStyle: (style: StyleKey) => void;
}

const STYLES: StyleKey[] = ["Indus", "PhonePe", "PhonePe Business", "Share.Market"];

export function StyleSidebar({ selectedStyle, onSelectStyle }: StyleSidebarProps) {
  return (
    <div
      className="flex flex-col items-center py-4 gap-1 border-r border-white/5 flex-shrink-0"
      style={{ width: 56, background: "rgba(10, 10, 15, 0.95)" }}
    >
      <span className="text-[9px] tracking-[0.15em] text-[#4a4a52] uppercase mb-3 font-['Inter',sans-serif]">
        Styles
      </span>

      {STYLES.map((style) => {
        const config = STYLE_CONFIG[style];
        const isActive = selectedStyle === style;
        const isDisabled = !!config.disabled;
        const Logo = config.logo;

        return (
          <button
            key={style}
            onClick={() => onSelectStyle(style)}
            className="relative flex items-center justify-center rounded-full transition-all duration-200 group"
            style={{
              width: 40,
              height: 40,
              marginBottom: 4,
              boxShadow: isActive && !isDisabled
                ? `0 0 0 2px ${config.ring}, 0 0 12px ${config.ring}`
                : isActive && isDisabled
                ? `0 0 0 1.5px rgba(255,255,255,0.08)`
                : "none",
              background: isActive ? "rgba(255,255,255,0.03)" : "transparent",
            }}
            title={isDisabled ? `${style} — Coming Soon` : style}
          >
            <div
              className="rounded-full overflow-hidden flex items-center justify-center transition-transform duration-150"
              style={{
                width: 32,
                height: 32,
                transform: isActive ? "scale(1)" : "scale(0.92)",
                opacity: isDisabled ? 0.3 : isActive ? 1 : 0.55,
                filter: isDisabled ? "grayscale(0.6)" : "none",
              }}
            >
              <Logo size={32} />
            </div>

            {/* Disabled lock badge */}
            {isDisabled && (
              <div
                className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full flex items-center justify-center"
                style={{ background: "rgba(10, 10, 15, 0.95)", border: "1px solid rgba(255,255,255,0.06)" }}
              >
                <Lock size={7} className="text-[#4a4a52]" />
              </div>
            )}

            {/* Active star indicator (only for enabled styles) */}
            {isActive && !isDisabled && (
              <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 pointer-events-none">
                <svg
                  width="9"
                  height="9"
                  viewBox="0 0 9 9"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M4.18875 0C4.26891 0.0893438 4.34686 0.981141 4.39247 1.19803C4.92839 3.74602 6.06914 3.94547 8.34637 4.48177C7.57964 4.52555 6.48525 4.75908 5.83313 5.19052C4.58667 6.01519 4.45162 7.57069 4.17347 8.89092C4.12256 8.7862 4.10714 8.66025 4.095 8.54452C3.79256 5.66339 2.75273 4.81547 0 4.47591C0.798844 4.3087 1.85667 4.14328 2.54939 3.72113C3.45947 3.1665 3.83601 2.07698 4.03594 1.08577C4.10245 0.756047 4.09941 0.391781 4.17947 0.0397031L4.18875 0Z"
                    fill="#FEFEFE"
                  />
                </svg>
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}