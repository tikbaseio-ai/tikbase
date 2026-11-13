import { useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Lock } from 'lucide-react';
import { fetchTrends, TREND_RANGES, trendReason, formatGrowth, type ProductTrend, type TrendRange } from '@/lib/trends';
import { InfoTip } from '@/components/InfoTip';
import { LoadingBar } from '@/components/LoadingBar';

const fmtMoney = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(1).replace(/\.0$/, '')}K` : `$${Math.round(n)}`);

/**
 * Sales over time for one product, from the daily sold_count snapshots.
 *
 * Honesty rules, all visible on screen:
 *   - bars are units per day between real snapshots; where snapshots are more
 *     than a day apart the bar is an average across the gap and says so;
 *   - "revenue" is units x the listed price on that snapshot, labelled an
 *     estimate, and absent for a snapshot with no price;
 *   - a range we do not have history for says how much history exists instead
 *     of drawing a short chart under a long label.
 */
export function ProductSalesChart({ productId, isPaid, onUpgrade }: {
  productId: string;
  isPaid: boolean;
  onUpgrade: () => void;
}) {
  const [range, setRange] = useState<TrendRange>(30);
  const [metric, setMetric] = useState<'units' | 'revenue'>('units');
  const [trend, setTrend] = useState<ProductTrend | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!isPaid) return;
    let cancelled = false;
    setLoading(true); setFailed(false);
    fetchTrends([productId], range, true)
      .then(r => { if (!cancelled) setTrend(r.trends[productId] ?? null); })
      .catch(() => { if (!cancelled) { setFailed(true); setTrend(null); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [productId, range, isPaid]);

  const hasRevenue = !!trend?.points.some(p => p.r != null);
  const showing = metric === 'revenue' && hasRevenue ? 'revenue' : 'units';
  const data = (trend?.points ?? []).map(p => ({
    d: p.d.slice(5),
    value: showing === 'revenue' ? p.r ?? 0 : p.u,
    gap: p.gap ?? 1,
  }));

  return (
    <div className="mb-8" data-testid="product-sales-chart">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <h2 className="text-sm font-semibold text-foreground">Sales trend</h2>
        <InfoTip size={12}>
          Units sold per day, taken from TikTok Shop's cumulative sold count in our daily
          snapshots. Estimated revenue is those units times the listed price on the day, not
          measured payouts. Where we have no snapshot for a day, the bar averages the gap.
        </InfoTip>
        {isPaid && (
          <div className="ml-auto flex items-center gap-2">
            <div className="flex items-center gap-1 bg-card rounded-lg p-1 border border-border">
              {(['units', 'revenue'] as const).map(m => (
                <button key={m} onClick={() => setMetric(m)} disabled={m === 'revenue' && !hasRevenue}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors disabled:opacity-30 ${showing === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                  {m === 'units' ? 'Units' : 'Est. revenue'}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 bg-card rounded-lg p-1 border border-border">
              {TREND_RANGES.map(r => (
                <button key={r} onClick={() => setRange(r)}
                  className={`px-2.5 py-1 rounded-md text-xs font-mono font-medium transition-colors ${range === r ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                  {r}d
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="rounded-lg border border-border bg-card px-5 py-4">
        {!isPaid ? (
          <button onClick={onUpgrade} className="w-full flex items-center justify-center gap-2 py-8 text-sm font-semibold text-foreground" data-testid="chart-upsell">
            <Lock size={14} className="text-primary" />
            Unlock the daily sales chart and growth for this product
          </button>
        ) : loading ? (
          <LoadingBar loading={loading} />
        ) : failed ? (
          <p className="py-8 text-center text-xs text-muted-foreground">Could not load the sales history. Try reloading.</p>
        ) : !trend || data.length < 2 ? (
          <p className="py-8 text-center text-xs text-muted-foreground" data-testid="chart-empty">
            {trend ? trendReason(trend, range) : 'No sales history for this product.'}
            {trend && trend.status !== 'no-history' && ` We hold ${trend.historyDays} days of history.`}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-x-6 gap-y-1 mb-3 text-[11px] text-muted-foreground">
              <span>Last {range}d <span className="font-mono text-foreground">{trend.units != null ? trend.units.toLocaleString() + ' units' : '—'}</span></span>
              <span>Prior {range}d <span className="font-mono text-foreground">{trend.priorUnits != null ? trend.priorUnits.toLocaleString() + ' units' : '—'}</span></span>
              <span title={trendReason(trend, range)}>Growth <span className="font-mono text-foreground">{trend.growth != null ? formatGrowth(trend.growth) : '—'}</span></span>
              <span>History <span className="font-mono text-foreground">{trend.historyDays}d</span></span>
            </div>
            {trend.status === 'short-history' && (
              <p className="text-[11px] text-muted-foreground mb-2">
                Only {trend.historyDays} days of history, so a {range}-day growth comparison is not available.
              </p>
            )}
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
                  <XAxis dataKey="d" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} minTickGap={24} />
                  <YAxis width={44} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false}
                    tickFormatter={(v: number) => (showing === 'revenue' ? fmtMoney(v) : String(Math.round(v)))} />
                  <Tooltip
                    cursor={{ fill: 'hsl(var(--secondary))' }}
                    contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }}
                    formatter={(v: number, _n, item: any) => [
                      (showing === 'revenue' ? '$' + Math.round(v).toLocaleString() : Math.round(v).toLocaleString() + ' units') +
                        (item?.payload?.gap > 1 ? ` (avg over ${item.payload.gap}d)` : ''),
                      showing === 'revenue' ? 'Est. revenue / day' : 'Units / day',
                    ]}
                  />
                  <Bar dataKey="value" fill="hsl(var(--primary))" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
