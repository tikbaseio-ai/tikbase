import { TrendingUp, TrendingDown } from 'lucide-react';
import { formatGrowth, trendReason, type ProductTrend, type TrendRange } from '@/lib/trends';

/** Growth % with its direction. An unmeasurable growth is an em dash with the
 *  reason in the tooltip, never 0%. */
export function GrowthCell({ trend, range }: { trend: ProductTrend | undefined; range: TrendRange }) {
  if (!trend || trend.growth == null) {
    return (
      <span className="text-zinc-600 text-xs font-mono" title={trendReason(trend, range)}>—</span>
    );
  }
  const up = trend.growth >= 0;
  return (
    <span
      className={`inline-flex items-center gap-1 font-mono text-xs font-semibold ${up ? 'text-primary-bright' : 'text-destructive'}`}
      title={trendReason(trend, range)}
    >
      {up ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
      {formatGrowth(trend.growth)}
    </span>
  );
}
