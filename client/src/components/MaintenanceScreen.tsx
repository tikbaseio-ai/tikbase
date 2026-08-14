import { useEffect, useState } from 'react';
import { CloudOff } from 'lucide-react';
import { probeService } from '@/lib/service-health';

/**
 * What the whole app becomes while the backend is unreachable.
 *
 * It replaces the router rather than sitting inside it, so there is no route
 * that can still render an empty table or a login form that cannot succeed.
 * Nothing here reads data — the only request it can make is the health probe,
 * and only when the reader asks for it.
 *
 * The copy says what is true and no more. "Upgrading our infrastructure" is
 * the honest half of a quota restriction; it does not promise a time we cannot
 * keep, and it does not blame the reader's connection.
 */
export function MaintenanceScreen() {
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);

  // One automatic check on mount, so a reader who lands here just as the quota
  // resets is not stuck behind a manual button.
  useEffect(() => { void probeService(); }, []);

  async function recheck() {
    setChecking(true);
    await probeService();
    setCheckedAt(new Date().toLocaleTimeString());
    setChecking(false);
  }

  return (
    <div
      className="min-h-screen bg-background flex items-center justify-center p-6"
      data-testid="maintenance-screen"
    >
      <div className="max-w-sm w-full text-center">
        <div className="w-12 h-12 rounded-xl bg-secondary flex items-center justify-center mx-auto mb-5">
          <CloudOff size={22} className="text-muted-foreground" />
        </div>

        <h1 className="text-xl font-semibold text-foreground mb-2">
          We’re upgrading our infrastructure
        </h1>
        <p className="text-sm text-muted-foreground leading-relaxed mb-6">
          TikBase is back shortly. Your account and your saved products are safe —
          there is nothing you need to do.
        </p>

        <button
          onClick={recheck}
          disabled={checking}
          className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50 transition-opacity"
          data-testid="maintenance-retry"
        >
          {checking ? 'Checking…' : 'Try again'}
        </button>

        {checkedAt && (
          <p className="text-[11px] text-muted-foreground font-mono mt-3">
            Still down as of {checkedAt}
          </p>
        )}

        <p className="text-[11px] text-muted-foreground mt-8">
          Checking automatically every minute.
        </p>
      </div>
    </div>
  );
}
