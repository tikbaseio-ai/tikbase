import { useState, useEffect, useRef, createContext, useContext, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';

interface SubscriptionState {
  isPaid: boolean;
  showPaywall: (feature?: string) => void;
  paywallVisible: boolean;
  paywallFeature: string | null;
  closePaywall: () => void;
  markStripeOpened: () => void;
}

const SubscriptionContext = createContext<SubscriptionState>({
  isPaid: false,
  showPaywall: () => {},
  paywallVisible: false,
  paywallFeature: null,
  closePaywall: () => {},
  markStripeOpened: () => {},
});

// How long after opening Stripe to keep re-checking on tab focus (5 minutes)
const RECHECK_WINDOW_MS = 5 * 60 * 1000;

export function SubscriptionProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [isPaid, setIsPaid] = useState(false);
  const [checkingSubscription, setCheckingSubscription] = useState(true);
  const [paywallVisible, setPaywallVisible] = useState(false);
  const stripeOpenedAt = useRef<number | null>(null);

  const checkSubscription = (email: string) => {
    return fetch(`/api/check-subscription?email=${encodeURIComponent(email)}`)
      .then(r => r.json())
      .then(data => {
        setIsPaid(data.isPaid === true);
        setCheckingSubscription(false);
      })
      .catch(() => {
        setIsPaid(false);
        setCheckingSubscription(false);
      });
  };

  // Initial check on login
  useEffect(() => {
    if (!user?.email) {
      setIsPaid(false);
      setCheckingSubscription(false);
      return;
    }
    checkSubscription(user.email);
  }, [user?.email]);

  // Re-check when user returns to tab after visiting Stripe
  useEffect(() => {
    if (!user?.email) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (!stripeOpenedAt.current) return;
      const elapsed = Date.now() - stripeOpenedAt.current;
      if (elapsed > RECHECK_WINDOW_MS) {
        stripeOpenedAt.current = null;
        return;
      }
      checkSubscription(user.email!);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [user?.email]);

  // Call this whenever a Stripe payment link is opened
  const markStripeOpened = () => {
    stripeOpenedAt.current = Date.now();
  };

  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);

  function showPaywall(feature?: string) {
    setPaywallFeature(feature || null);
    setPaywallVisible(true);
  }

  function closePaywall() {
    setPaywallVisible(false);
    setPaywallFeature(null);
  }

  return (
    <SubscriptionContext.Provider value={{
      isPaid, showPaywall, paywallVisible, paywallFeature, closePaywall, markStripeOpened,
    }}>
      {children}
    </SubscriptionContext.Provider>
  );
}

export function useSubscription() {
  return useContext(SubscriptionContext);
}
