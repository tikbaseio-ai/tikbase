import { useState } from 'react';
import { Check, X } from 'lucide-react';

const STRIPE_LINKS = {
  monthly: 'https://buy.stripe.com/6oUeVc7iQ2qrc5f3WHfIs00',
  annual: 'https://buy.stripe.com/cNi3cufPm9ST5GR9h1fIs02',
};

const FEATURES = [
  { name: 'Niche browsing', free: true, pro: true },
  { name: 'Top 10 videos per niche', free: true, pro: true },
  { name: 'Top 50+ videos per niche', free: false, pro: true },
  { name: 'Product analytics', free: false, pro: true },
  { name: 'Revenue estimates', free: false, pro: true },
  { name: 'Unlimited bookmarks', free: false, pro: true },
  { name: 'Product stock tracking', free: false, pro: true },
  { name: 'Advanced timeframe filters', free: false, pro: true },
  { name: 'Export data (CSV)', free: false, pro: true },
  { name: 'Priority support', free: false, pro: true },
];

export default function PlansPage() {
  const [annual, setAnnual] = useState(false);
  const monthlyPrice = 44.99;
  const annualPrice = 31.49;
  const currentPrice = annual ? annualPrice : monthlyPrice;
  const savingsPercent = 30;

  function handleUpgrade() {
    const link = annual ? STRIPE_LINKS.annual : STRIPE_LINKS.monthly;
    window.open(link, '_blank', 'noopener,noreferrer');
  }

  return (
    <div className="p-6 max-w-4xl mx-auto" data-testid="plans-page">
      <div className="mb-8 text-center">
        <h1 className="text-xl font-semibold text-foreground mb-1">Plans</h1>
        <p className="text-sm text-muted-foreground">
          Choose the plan that fits your needs
        </p>
      </div>

      {/* Billing toggle */}
      <div className="flex items-center justify-center gap-3 mb-8">
        <span
          className={`text-sm font-medium ${!annual ? 'text-foreground' : 'text-muted-foreground'}`}
        >
          Monthly
        </span>
        <button
          onClick={() => setAnnual(!annual)}
          className={`relative w-11 h-6 rounded-full transition-colors ${
            annual ? 'bg-[#a3ff00]' : 'bg-muted'
          }`}
          data-testid="billing-toggle"
        >
          <div
            className={`absolute top-0.5 w-5 h-5 rounded-full transition-transform ${
              annual ? 'translate-x-[22px] bg-[#0a0a0c]' : 'translate-x-0.5 bg-foreground'
            }`}
          />
        </button>
        <span
          className={`text-sm font-medium ${annual ? 'text-foreground' : 'text-muted-foreground'}`}
        >
          Annual
        </span>
        {annual && (
          <span className="text-xs font-mono font-bold text-[#a3ff00] bg-[#a3ff00]/10 px-2 py-0.5 rounded">
            Save {savingsPercent}%
          </span>
        )}
      </div>

      {/* Plan cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Free */}
        <div className="rounded-lg border border-border bg-card p-6" data-testid="plan-free">
          <h2 className="text-lg font-semibold text-foreground mb-1">Free</h2>
          <p className="text-sm text-muted-foreground mb-4">Basic access to TikBase</p>
          <div className="mb-6">
            <span className="text-3xl font-bold font-mono text-foreground">$0</span>
            <span className="text-sm text-muted-foreground ml-1">/mo</span>
          </div>
          <button
            className="w-full h-10 rounded-md border border-border text-sm font-medium text-foreground hover:bg-secondary transition-colors mb-6"
            data-testid="btn-current-plan"
          >
            Current Plan
          </button>
          <ul className="space-y-3">
            {FEATURES.map(f => (
              <li key={f.name} className="flex items-center gap-2.5">
                {f.free ? (
                  <Check size={14} className="text-[#a3ff00] flex-shrink-0" />
                ) : (
                  <X size={14} className="text-muted-foreground/40 flex-shrink-0" />
                )}
                <span
                  className={`text-sm ${
                    f.free ? 'text-foreground' : 'text-muted-foreground/60'
                  }`}
                >
                  {f.name}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* Pro */}
        <div
          className="rounded-lg border-2 border-[#a3ff00]/50 bg-card p-6 relative"
          data-testid="plan-pro"
        >
          <div
            className="absolute -top-3 left-6 px-3 py-0.5 rounded text-[10px] font-mono font-bold tracking-wider uppercase"
            style={{ backgroundColor: '#a3ff00', color: '#0a0a0c' }}
          >
            Recommended
          </div>
          <h2 className="text-lg font-semibold text-foreground mb-1">Pro</h2>
          <p className="text-sm text-muted-foreground mb-4">Full access to all features</p>
          <div className="mb-1">
            <span className="text-3xl font-bold font-mono text-[#a3ff00]">
              ${currentPrice.toFixed(2)}
            </span>
            <span className="text-sm text-muted-foreground ml-1">/mo</span>
          </div>
          {annual && (
            <p className="text-xs text-muted-foreground mb-4">
              Billed monthly at ${annualPrice.toFixed(2)}/mo
            </p>
          )}
          {!annual && <div className="mb-4" />}
          <button
            onClick={handleUpgrade}
            className="w-full h-10 rounded-md text-sm font-bold transition-colors mb-6"
            style={{ backgroundColor: '#a3ff00', color: '#0a0a0c' }}
            data-testid="btn-upgrade"
          >
            Upgrade to Pro
          </button>
          <ul className="space-y-3">
            {FEATURES.map(f => (
              <li key={f.name} className="flex items-center gap-2.5">
                <Check size={14} className="text-[#a3ff00] flex-shrink-0" />
                <span className="text-sm text-foreground">{f.name}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
