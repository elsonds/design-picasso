import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "./supabase-client";

const ALLOWED_DOMAIN = "phonepe.com";

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  accessToken: string | null;
  authError: string | null;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  session: null,
  loading: true,
  signInWithGoogle: async () => {},
  signOut: async () => {},
  accessToken: null,
  authError: null,
});

export function useAuth() {
  return useContext(AuthContext);
}

/** Check if a user's email belongs to the allowed domain */
function isAllowedDomain(user: User | undefined | null): boolean {
  const email = user?.email;
  if (!email) return false;
  return email.endsWith(`@${ALLOWED_DOMAIN}`);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    // Rely solely on onAuthStateChange to manage loading and session state.
    // It fires INITIAL_SESSION after any in-progress PKCE code exchange completes,
    // which avoids the race condition where getSession() returns null while the
    // code exchange is still in flight, causing the login screen to flash.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, s) => {
      console.log("[Auth] event:", event, "| session:", s ? "✓" : "null");

      // Domain restriction: sign out users not on the allowed domain
      if (s?.user && !isAllowedDomain(s.user)) {
        console.warn(`[Auth] Unauthorized domain: ${s.user.email}`);
        setAuthError(`Access restricted to @${ALLOWED_DOMAIN} accounts only.`);
        await supabase.auth.signOut();
        setSession(null);
        setLoading(false);
        return;
      }

      setAuthError(null);
      setSession(s);
      setLoading(false);
    });

    // Safety net: if onAuthStateChange never fires (shouldn't happen),
    // fall back to getSession so the app doesn't spin forever.
    const fallback = setTimeout(() => {
      supabase.auth.getSession().then(({ data: { session: s }, error }) => {
        if (error) console.error("[Auth] getSession fallback error:", error.message);
        console.log("[Auth] fallback getSession:", s ? "✓" : "null");
        setSession(s);
        setLoading(false);
      });
    }, 5000);

    return () => {
      subscription.unsubscribe();
      clearTimeout(fallback);
    };
  }, []);

  const signInWithGoogle = useCallback(async () => {
    setAuthError(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.origin,
        queryParams: {
          hd: ALLOWED_DOMAIN, // Hint Google to show only phonepe.com accounts
        },
      },
    });
    if (error) {
      console.error("[Auth] Google sign-in error:", error.message);
      setAuthError(error.message);
    }
  }, []);

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut();
    if (error) {
      console.error("[Auth] Sign-out error:", error.message);
    }
  }, []);

  const value: AuthContextType = {
    user: session?.user ?? null,
    session,
    loading,
    signInWithGoogle,
    signOut,
    accessToken: session?.access_token ?? null,
    authError,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}