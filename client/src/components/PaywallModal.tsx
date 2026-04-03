import { useState } from 'react';
import { useSubscription } from '@/hooks/use-subscription';
import { X, Lock, TrendingUp, BarChart3, Zap, Tag } from 'lucide-react';

const STRIPE_LINKS = {
  monthly: 'https://buy.stripe.com/6oUeVc7iQ2qrc5f3WHfIs00',
  annual: 'https://buy.stripe.com/cNi3cufPm9ST5GR9h1fIs02',
};

const FEATURE_MESSAGES: Record<string, string> = {
  top_videos: 'Unlock the top 100 trending TikTok Shop videos — see what\'s going viral right now',
  category_filter: 'Unlock category filtering to find trending products in specific niches',
  videos_101: 'Unlock access to all trending videos beyond the top 100',
  timeframe: "Unlock all timeframes to see what's trending this week, month, and year",
  product_detail: 'Unlock detailed product analytics and insights',
  video_detail: 'Unlock full video analytics and creator data',
  default: 'Unlock full access to TikBase analytics',
};

export function PaywallModal() {
  const { paywallVisible, paywallFeature, closePaywall, markStripeOpened } = useSubscription();
  const [promoCode, setPromoCode] = useState('');

  function handleCheckout(plan: 'monthly' | 'annual') {
    let link = STRIPE_LINKS[plan];
    if (promoCode.trim()) {
      link += `?prefilled_promo_code=${encodeURIComponent(promoCode.trim())}`;
    }
    markStripeOpened();
    window.open(link, '_blank', 'noopener,noreferrer');
  }

  if (!paywallVisible) return null;

  const message = FEATURE_MESSAGES[paywallFeature || 'default'] || FEATURE_MESSAGES.default;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={closePaywall}
    >
      <div
        className="relative bg-[#0a0a0c] border border-zinc-800 rounded-xl max-w-md w-full mx-4 p-8"
        onClick={e => e.stopPropagation()}
      >
        <button
          onClick={closePaywall}
          className="absolute top-4 right-4 text-zinc-500 hover:text-foreground transition-colors"
        >
          <X size={18} />
        </button>

        <div className="text-center mb-6">
          <div className="w-14 h-14 rounded-full bg-[#a3ff00]/10 flex items-center justify-center mx-auto mb-4">
            <Lock size={24} className="text-[#a3ff00]" />
          </div>
          <h2 className="text-xl font-bold text-foreground mb-2">Upgrade to TikBase Pro</h2>
          <p className="text-sm text-zinc-400">{message}</p>
        </div>

        <div className="space-y-3 mb-6">
          <div className="flex items-center gap-3 text-sm text-foreground">
            <TrendingUp size={16} className="text-[#a3ff00] flex-shrink-0" />
            <span>Unlimited trending videos &amp; products</span>
          </div>
          <div className="flex items-center gap-3 text-sm text-foreground">
            <BarChart3 size={16} className="text-[#a3ff00] flex-shrink-0" />
            <span>All timeframes — 1 Week to 1 Year</span>
          </div>
          <div className="flex items-center gap-3 text-sm text-foreground">
            <Zap size={16} className="text-[#a3ff00] flex-shrink-0" />
            <span>Full product &amp; video analytics</span>
          </div>
        </div>

        {/* Discount code */}
        <div className="mb-4">
          <div className="relative">
            <Tag size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              value={promoCode}
              onChange={e => setPromoCode(e.target.value)}
              placeholder="Discount code"
              className="w-full h-10 pl-9 pr-3 rounded-lg text-sm border border-zinc-800 bg-zinc-900/50 text-foreground placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-[#a3ff00]/50 focus:border-[#a3ff00]/50"
            />
          </div>
        </div>

        <div className="space-y-3">
          <button
            onClick={() => handleCheckout('monthly')}
            className="block w-full py-3 rounded-lg text-center font-semibold text-sm transition-colors"
            style={{ backgroundColor: '#a3ff00', color: '#0a0a0c' }}
          >
            $44.99/month
          </button>
          <button
            onClick={() => handleCheckout('annual')}
            className="block w-full py-3 rounded-lg border border-[#a3ff00] text-[#a3ff00] text-center font-semibold text-sm hover:bg-[#a3ff00]/10 transition-colors"
          >
            $31.49/month (billed yearly) — Save 30%
          </button>
        </div>

        <p className="text-[10px] text-zinc-600 text-center mt-4">
          Cancel anytime. Instant access after payment.
        </p>
      </div>
    </div>
  );
}
