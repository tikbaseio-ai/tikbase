import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * Small hover-info affordance. Uses the Radix Tooltip primitive (not native
 * `title=`) so explanations are styled, keyboard-focusable, and readable.
 * stopPropagation on the trigger keeps clicks from bubbling into sortable
 * table headers.
 */
export function InfoTip({
  children,
  size = 12,
  className = '',
}: {
  children: ReactNode;
  size?: number;
  className?: string;
}) {
  return (
    <Tooltip delayDuration={100}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={e => e.stopPropagation()}
          className={`inline-flex items-center justify-center text-muted-foreground/50 hover:text-foreground transition-colors cursor-help align-middle ${className}`}
          aria-label="More information"
        >
          <Info size={size} strokeWidth={2} />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="max-w-[250px] text-xs font-normal leading-relaxed text-left"
      >
        {children}
      </TooltipContent>
    </Tooltip>
  );
}
