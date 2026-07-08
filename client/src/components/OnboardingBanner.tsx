import { useState } from 'react';
import { X, Play, Package, Bookmark } from 'lucide-react';

const DISMISS_KEY = 'tikbase_onboarding_dismissed_v1';

const STEPS = [
  {
    icon: Play,
    title: 'Top Videos',
    body: 'The freshest viral TikTok Shop videos, ranked by views. Start here to spot what’s trending right now.',
  },
  {
    icon: Package,
    title: 'Top Products',
    body: 'The products behind those videos — with estimated revenue, units sold, and price so you can judge the opportunity.',
  },
  {
    icon: Bookmark,
    title: 'Saved',
    body: 'Bookmark any video or product with the ☆ icon to build your own shortlist in the Saved tab.',
  },
];

/**
 * First-run "how it works" strip shown on the dashboard. Dismissible and
 * remembered in localStorage so returning users don't see it again.
 */
export function OnboardingBanner() {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });

  if (dismissed) return null;

  const close = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* ignore */
    }
    setDismissed(true);
  };

  return (
    <div className="relative mb-6 rounded-lg border border-[#a3ff00]/25 bg-[#a3ff00]/[0.04] p-4">
      <button
        onClick={close}
        aria-label="Dismiss"
        className="absolute top-3 right-3 text-muted-foreground hover:text-foreground transition-colors"
      >
        <X size={15} />
      </button>

      <div className="flex items-center gap-2 mb-3">
        <span
          className="w-6 h-6 rounded-md flex items-center justify-center font-mono font-bold text-[11px]"
          style={{ backgroundColor: '#a3ff00', color: '#0a0a0c' }}
        >
          TB
        </span>
        <h2 className="text-sm font-semibold text-foreground">
          Welcome to TikBase
        </h2>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {STEPS.map(step => (
          <div key={step.title} className="flex gap-2.5">
            <step.icon
              size={16}
              className="mt-0.5 flex-shrink-0 text-[#a3ff00]"
              strokeWidth={2}
            />
            <div>
              <p className="text-xs font-semibold text-foreground mb-0.5">
                {step.title}
              </p>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {step.body}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
