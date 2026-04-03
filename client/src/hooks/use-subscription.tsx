import { useState, useEffect, createContext, useContext, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';

interface SubscriptionState {
  isPaid: boolean;
  showPaywall: (feature?: string) => void;
  paywallVisible: boolean;
  paywallFeature: string | null;
  closePaywall: () => void;
}

const SubscriptionContext = createContext<SubscriptionState>({
  isPaid: false,
  showPaywall: () => {},
  paywallVisible: false,
  paywallFeature: null,
  closePaywall: () => {},
});

export function SubscriptionProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [isPaid, setIsPaid] = useState(false);
  const [checkingSubscription, setCheckingSubscription] = useState(true);
  const [paywallVisible, setPaywallVisible] = useState(false);

  useEffect(() => {
    if (!user?.email) {
      setIsPaid(false);
      setCheckingSubscription(false);
      return;
    }

    fetch(`/api/check-subscription?email=${encodeURIComponent(user.email)}`)
      .then(r => r.json())
      .then(data => {
        setIsPaid(data.isPaid === true);
        setCheckingSubscription(false);
      })
      .catch(() => {
        setIsPaid(false);
        setCheckingSubscription(false);
      });
  }, [user?.email]);
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
      isPaid, showPaywall, paywallVisible, paywallFeature, closePaywall,
    }}>
      {children}
    </SubscriptionContext.Provider>
  );
}

export function useSubscription() {
  return useContext(SubscriptionContext);
}
