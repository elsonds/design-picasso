import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "./auth-context";
import { IndusLogo } from "./IndusLogo";

export function LoginScreen() {
  const { signInWithGoogle, authError } = useAuth();
  const [signingIn, setSigningIn] = useState(false);

  const handleGoogleSignIn = async () => {
    setSigningIn(true);
    await signInWithGoogle();
    // The redirect will happen, so no need to reset state
  };

  return (
    <>
      <style>{`
        @keyframes login-fade-in {
          from { opacity: 0; transform: translateY(16px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes login-glow {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 0.7; }
        }
      `}</style>
      <div
        className="w-full h-screen flex items-center justify-center font-['Inter',sans-serif]"
        style={{ background: "#0d0d12" }}
      >
        {/* Subtle radial glow behind card */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "radial-gradient(600px circle at 50% 40%, rgba(124, 58, 237, 0.06), transparent 70%)",
          }}
        />

        <div
          className="relative flex flex-col items-center text-center px-10 py-12 rounded-2xl border border-white/6 max-w-sm w-full mx-4"
          style={{
            background: "rgba(16, 16, 24, 0.85)",
            backdropFilter: "blur(24px)",
            animation: "login-fade-in 0.6s cubic-bezier(0.22,1,0.36,1) both",
          }}
        >
          {/* Logo */}
          <div className="mb-6">
            <IndusLogo width={56} height={56} />
          </div>

          <h1 className="text-[#e5e5ea] text-[22px] font-semibold tracking-tight mb-1">
            Picasso
          </h1>
          <p className="text-[#5a5a64] text-[13px] mb-8 leading-relaxed max-w-[260px]">
            AI-powered illustration generation with custom styles. Sign in with your PhonePe account to get started.
          </p>

          {/* Auth error message */}
          {authError && (
            <div
              className="w-full mb-4 px-4 py-3 rounded-lg text-[13px] text-red-300 leading-relaxed"
              style={{
                background: "rgba(239, 68, 68, 0.1)",
                border: "1px solid rgba(239, 68, 68, 0.2)",
              }}
            >
              {authError}
            </div>
          )}

          {/* Divider */}
          <div className="w-12 h-px bg-white/6 mb-8" />

          {/* Google Sign In Button */}
          <button
            onClick={handleGoogleSignIn}
            disabled={signingIn}
            className="w-full flex items-center justify-center gap-3 px-5 py-3 rounded-xl text-[14px] font-medium transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              background: signingIn
                ? "rgba(255, 255, 255, 0.04)"
                : "rgba(255, 255, 255, 0.06)",
              color: "#e5e5ea",
              border: "1px solid rgba(255, 255, 255, 0.08)",
            }}
            onMouseEnter={(e) => {
              if (!signingIn) {
                e.currentTarget.style.background = "rgba(255, 255, 255, 0.1)";
                e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.15)";
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "rgba(255, 255, 255, 0.06)";
              e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.08)";
            }}
          >
            {signingIn ? (
              <Loader2 size={18} className="animate-spin" />
            ) : (
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path
                  d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
                  fill="#4285F4"
                />
                <path
                  d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z"
                  fill="#34A853"
                />
                <path
                  d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.997 8.997 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
                  fill="#FBBC05"
                />
                <path
                  d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
                  fill="#EA4335"
                />
              </svg>
            )}
            {signingIn ? "Redirecting..." : "Continue with Google"}
          </button>

          {/* Footer note */}
          <p className="text-[#3a3a44] text-[11px] mt-6 leading-relaxed">
            Restricted to @phonepe.com accounts
          </p>
        </div>
      </div>
    </>
  );
}
