import { useState } from 'react';
import { CreditCard, Receipt, Settings, Loader2 } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useSubscription } from '@/hooks/use-subscription';

export default function BillingPage() {
  const { user } = useAuth();
  const { isPaid } = useSubscription();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleManageSubscription() {
    if (!user?.id) {
      setError('You must be signed in');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/create-portal-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: user.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Something went wrong');
        return;
      }
      window.location.href = data.url;
    } catch {
      setError('Failed to connect to server');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-6 max-w-3xl" data-testid="billing-page">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-foreground mb-1">Billing</h1>
        <p className="text-sm text-muted-foreground">
          Manage your subscription and payment methods
        </p>
      </div>

      {/* Current Plan */}
      <div className="rounded-lg border border-border bg-card p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-foreground">Current Plan</h2>
          <span
            className="text-[10px] font-mono font-bold tracking-wider px-2 py-0.5 rounded uppercase"
            style={{ backgroundColor: 'hsl(var(--muted))', color: 'hsl(var(--muted-foreground))' }}
          >
            {isPaid ? 'Pro' : 'Free'}
          </span>
        </div>
        <p className="text-sm text-muted-foreground mb-3">
          {isPaid
            ? 'You are on the TikBase Pro plan.'
            : 'You are on the Free plan. Upgrade to Pro for full access.'}
        </p>
        {!isPaid && (
          <a
            href="#/dashboard/plans"
            className="inline-flex items-center h-8 px-4 rounded-md text-xs font-bold transition-colors no-underline"
            style={{ backgroundColor: '#a3ff00', color: '#0a0a0c' }}
            data-testid="btn-view-plans"
            onClick={(e) => {
              e.preventDefault();
              window.location.hash = '#/dashboard/plans';
            }}
          >
            View Plans
          </a>
        )}
      </div>

      {/* Manage Subscription */}
      {isPaid && (
        <div className="rounded-lg border border-border bg-card p-5 mb-4">
          <div className="flex items-center gap-2 mb-3">
            <Settings size={16} className="text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">Manage Subscription</h2>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            Update payment methods, download invoices, or cancel your subscription.
          </p>
          <button
            onClick={handleManageSubscription}
            disabled={loading}
            className="inline-flex items-center gap-2 h-9 px-4 rounded-md text-xs font-bold transition-colors disabled:opacity-50"
            style={{ backgroundColor: '#a3ff00', color: '#0a0a0c' }}
            data-testid="btn-manage-subscription"
          >
            {loading && <Loader2 size={14} className="animate-spin" />}
            Manage Subscription
          </button>
          {error && (
            <p className="text-sm text-red-400 mt-2" data-testid="portal-error">{error}</p>
          )}
        </div>
      )}

      {/* Payment Method */}
      <div className="rounded-lg border border-border bg-card p-5 mb-4">
        <div className="flex items-center gap-2 mb-3">
          <CreditCard size={16} className="text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Payment Method</h2>
        </div>
        <div className="text-center py-8">
          <CreditCard size={28} className="mx-auto text-muted-foreground/30 mb-2" />
          <p className="text-sm text-muted-foreground">
            {isPaid
              ? 'Manage payment methods via the subscription portal above.'
              : 'No payment method on file.'}
          </p>
          {!isPaid && (
            <p className="text-xs text-muted-foreground/60 mt-1">
              Add a payment method when you upgrade to Pro.
            </p>
          )}
        </div>
      </div>

      {/* Billing History */}
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex items-center gap-2 mb-3">
          <Receipt size={16} className="text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Billing History</h2>
        </div>
        <div className="text-center py-8">
          <Receipt size={28} className="mx-auto text-muted-foreground/30 mb-2" />
          <p className="text-sm text-muted-foreground">
            {isPaid
              ? 'View invoices in the subscription portal.'
              : 'No billing history.'}
          </p>
          {!isPaid && (
            <p className="text-xs text-muted-foreground/60 mt-1">
              Your invoices will appear here once you subscribe.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
