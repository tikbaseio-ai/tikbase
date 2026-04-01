import { useState, createContext, useContext, type ReactNode } from 'react';

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
  // For now, everyone is free. When auth + Stripe webhooks are wired up,
  // this will check the user's subscription status from Supabase.
  const [isPaid] = useState(false);
  const [paywallVisible, setPaywallVisible] = useState(false);
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
