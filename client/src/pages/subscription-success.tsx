import { useEffect, useState } from 'react';
import { Redirect } from 'wouter';
import { CheckCircle2, Loader2, AlertCircle } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useSubscription } from '@/hooks/use-subscription';

type Stage = 'verifying' | 'confirmed' | 'error';

// Stripe Payment Link redirects to `https://tikbase.io/#/subscription-success?session_id={CHECKOUT_SESSION_ID}`
// With wouter's hash routing, the query string sits in window.location.search.
function getSessionIdFromUrl(): string | null {
  const search = window.location.search;
  if (search) {
    const p = new URLSearchParams(search);
    const id = p.get('session_id');
    if (id) return id;
  }
  // Fallback: session_id could also be after the hash on some configurations.
  const hash = window.location.hash;
  const qIndex = hash.indexOf('?');
  if (qIndex >= 0) {
    const p = new URLSearchParams(hash.slice(qIndex + 1));
    return p.get('session_id');
  }
  return null;
}

export default function SubscriptionSuccessPage() {
  const { user, loading: authLoading } = useAuth();
  const { refreshSubscription } = useSubscription();
  const [stage, setStage] = useState<Stage>('verifying');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [autoRedirectIn, setAutoRedirectIn] = useState<number>(4);

  useEffect(() => {
    if (authLoading) return;
    if (!user?.id) {
      setStage('error');
      setErrorMsg('You must be signed in to confirm your subscription.');
      return;
    }

    let cancelled = false;

    async function verify() {
      const sessionId = getSessionIdFromUrl();

      // Path A: we have a session_id — hit verify-session for instant confirmation.
      if (sessionId) {
        try {
          const res = await fetch('/api/verify-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: sessionId, user_id: user!.id }),
          });
          const data = await res.json();
          if (!cancelled && res.ok && data.isPaid) {
            await refreshSubscription();
            setStage('confirmed');
            return;
          }
        } catch {
          // fall through to polling
        }
      }

      // Path B: no session_id or verify-session didn't confirm — poll check-subscription
      // while the webhook lands. Up to ~20s.
      for (let i = 0; i < 20; i++) {
        if (cancelled) return;
        try {
          const res = await fetch(
            `/api/check-subscription?user_id=${encodeURIComponent(user!.id)}`,
          );
          const data = await res.json();
          if (data.isPaid) {
            if (cancelled) return;
            await refreshSubscription();
            setStage('confirmed');
            return;
          }
        } catch {
          /* keep polling */
        }
        await new Promise(r => setTimeout(r, 1000));
      }

      if (cancelled) return;
      setStage('error');
      setErrorMsg(
        "We couldn't confirm your subscription automatically. If you just paid, give it a moment and refresh — or contact support if the problem persists.",
      );
    }

    verify();
    return () => {
      cancelled = true;
    };
  }, [authLoading, user?.id, refreshSubscription]);

  // Auto-redirect after confirmation
  useEffect(() => {
    if (stage !== 'confirmed') return;
    if (autoRedirectIn <= 0) {
      window.location.hash = '#/dashboard';
      return;
    }
    const t = setTimeout(() => setAutoRedirectIn(n => n - 1), 1000);
    return () => clearTimeout(t);
  }, [stage, autoRedirectIn]);

  if (!authLoading && !user) {
    return <Redirect to="/login" />;
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-6"
      style={{ backgroundColor: '#0a0a0c' }}
    >
      <div className="max-w-md w-full text-center">
        {stage === 'verifying' && (
          <>
            <div className="w-16 h-16 rounded-full bg-[#a3ff00]/10 flex items-center justify-center mx-auto mb-6">
              <Loader2 size={28} className="text-[#a3ff00] animate-spin" />
            </div>
            <h1 className="text-2xl font-bold text-foreground mb-2">
              Confirming your subscription…
            </h1>
            <p className="text-sm text-zinc-400">
              Hang tight, this only takes a second.
            </p>
          </>
        )}

        {stage === 'confirmed' && (
          <>
            <div className="w-16 h-16 rounded-full bg-[#a3ff00]/10 flex items-center justify-center mx-auto mb-6">
              <CheckCircle2 size={32} className="text-[#a3ff00]" />
            </div>
            <h1 className="text-2xl font-bold text-foreground mb-2">
              You're in. Welcome to TikBase Pro.
            </h1>
            <p className="text-sm text-zinc-400 mb-8">
              Full access is now unlocked on this account.
            </p>
            <a
              href="#/dashboard"
              className="inline-block w-full py-3 rounded-lg text-center font-semibold text-sm transition-colors"
              style={{ backgroundColor: '#a3ff00', color: '#0a0a0c' }}
              onClick={(e) => {
                e.preventDefault();
                window.location.hash = '#/dashboard';
              }}
            >
              Go to dashboard {autoRedirectIn > 0 && `(${autoRedirectIn})`}
            </a>
          </>
        )}

        {stage === 'error' && (
          <>
            <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-6">
              <AlertCircle size={28} className="text-red-400" />
            </div>
            <h1 className="text-2xl font-bold text-foreground mb-2">
              Something went wrong
            </h1>
            <p className="text-sm text-zinc-400 mb-8">{errorMsg}</p>
            <a
              href="#/dashboard"
              className="inline-block w-full py-3 rounded-lg border border-zinc-700 text-center font-semibold text-sm text-foreground hover:bg-zinc-900 transition-colors"
              onClick={(e) => {
                e.preventDefault();
                window.location.hash = '#/dashboard';
              }}
            >
              Back to dashboard
            </a>
          </>
        )}
      </div>
    </div>
  );
}
