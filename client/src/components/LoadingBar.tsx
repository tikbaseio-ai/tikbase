import { useEffect, useState, useRef } from 'react';

export function LoadingBar({ loading }: { loading: boolean }) {
  const [percent, setPercent] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (loading) {
      setPercent(0);
      const start = Date.now();
      intervalRef.current = setInterval(() => {
        const elapsed = (Date.now() - start) / 1000;
        // Fast ramp to ~30% in first second, slow crawl toward 95%
        // Typical cold load: ~10s. Cached load: <1s.
        let p: number;
        if (elapsed < 0.5) p = elapsed * 60;           // 0-30% in 0.5s
        else if (elapsed < 2) p = 30 + (elapsed - 0.5) * 20;  // 30-60% by 2s
        else if (elapsed < 5) p = 60 + (elapsed - 2) * 8;     // 60-84% by 5s
        else if (elapsed < 10) p = 84 + (elapsed - 5) * 2;    // 84-94% by 10s
        else p = Math.min(98, 94 + (elapsed - 10) * 0.3);     // crawl to 98%
        setPercent(Math.round(p));
      }, 50);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
      setPercent(100);
      // Reset after brief flash of 100%
      const t = setTimeout(() => setPercent(0), 400);
      return () => clearTimeout(t);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [loading]);

  if (!loading && percent === 0) return null;

  return (
    <div className="flex items-center justify-center py-32">
      <div className="flex flex-col items-center gap-4">
        <div className="relative w-14 h-14">
          {/* Background circle */}
          <svg className="w-14 h-14 -rotate-90" viewBox="0 0 56 56">
            <circle cx="28" cy="28" r="24" fill="none" stroke="#27272a" strokeWidth="3" />
            <circle
              cx="28" cy="28" r="24" fill="none"
              stroke="#a3ff00"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={2 * Math.PI * 24}
              strokeDashoffset={2 * Math.PI * 24 * (1 - percent / 100)}
              className="transition-all duration-100"
            />
          </svg>
          {/* Percent text in center */}
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-xs font-mono font-bold text-foreground">
              {percent}%
            </span>
          </div>
        </div>
        <span className="text-xs text-zinc-500 font-mono">
          {percent < 100 ? 'Loading...' : 'Done'}
        </span>
      </div>
    </div>
  );
}
