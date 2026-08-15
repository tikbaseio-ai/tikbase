import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabaseAuth } from './supabaseAuth';
import { getReferral, clearReferral } from './referral';

interface AuthState {
  session: Session | null;
  user: User | null;
  loading: boolean;
  signInWithEmail: (email: string, password: string) => Promise<{ error: Error | null }>;
  signUpWithEmail: (email: string, password: string) => Promise<{ error: Error | null }>;
  signInWithGoogle: () => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  session: null,
  user: null,
  loading: true,
  signInWithEmail: async () => ({ error: null }),
  signUpWithEmail: async () => ({ error: null }),
  signInWithGoogle: async () => ({ error: null }),
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabaseAuth.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    const { data: { subscription } } = supabaseAuth.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  async function signInWithEmail(email: string, password: string) {
    const { error } = await supabaseAuth.auth.signInWithPassword({ email, password });
    return { error: error as Error | null };
  }

  async function signUpWithEmail(email: string, password: string) {
    // Attribution rides along in user_metadata, which the user's own token can
    // write. app_metadata is service-role only and is where the webhook keeps
    // the subscription — a referral code is a claim about where someone came
    // from, not an entitlement, so it belongs on the user side.
    const referral = getReferral();
    const { error } = await supabaseAuth.auth.signUp({
      email,
      password,
      options: referral ? { data: { referral } } : undefined,
    });
    if (!error && referral) clearReferral();
    return { error: error as Error | null };
  }

  async function signInWithGoogle() {
    // The OAuth round trip loses localStorage on some browsers, so the code
    // goes out on the redirect URL and captureReferral() picks it back up.
    const referral = getReferral();
    const redirectTo = referral
      ? `${window.location.origin}/?via=${encodeURIComponent(referral.code)}`
      : window.location.origin;
    const { error } = await supabaseAuth.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo },
    });
    return { error: error as Error | null };
  }

  async function signOut() {
    await supabaseAuth.auth.signOut();
    setSession(null);
  }

  return (
    <AuthContext.Provider value={{
      session,
      user: session?.user ?? null,
      loading,
      signInWithEmail,
      signUpWithEmail,
      signInWithGoogle,
      signOut,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
