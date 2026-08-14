import { useState, useCallback } from 'react';
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/drawer';
import { authHeader } from '@/lib/supabase';
import { useSubscription } from '@/hooks/use-subscription';
import {
  FileText, Lock, Loader2, Copy, Check, ExternalLink, X, AlertCircle,
} from 'lucide-react';

type Status = 'idle' | 'loading' | 'ok' | 'unavailable' | 'locked' | 'error';

interface TranscriptState {
  status: Status;
  lines: string[];
  message?: string;
}

/** Below this the drawer is used; above it the panel expands inline. */
const MOBILE_BREAKPOINT = 768;

/**
 * "Study the script" — pull a winning video's spoken transcript so the format
 * can be copied: keep the hook, rewrite the rest.
 *
 * The fetch costs a credit the first time and nothing afterwards, so it is
 * strictly on click. Vendor latency was measured at 5.6-6.8s, which is why the
 * loading state is a designed state rather than an afterthought.
 */
export function ScriptButton({
  videoId,
  videoUrl,
  disabled,
}: {
  videoId: string | null;
  videoUrl: string | null;
  disabled?: boolean;
}) {
  const { isPaid, showPaywall } = useSubscription();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<TranscriptState>({ status: 'idle', lines: [] });
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!videoId) return;
    setState({ status: 'loading', lines: [] });
    try {
      const res = await fetch(`/api/video-transcript?video_id=${encodeURIComponent(videoId)}`, {
        headers: await authHeader(),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 402) {
        // Server-enforced Pro gate. The UI mirrors it; it does not create it.
        setState({ status: 'locked', lines: [], message: data?.message });
        return;
      }
      if (!res.ok) {
        setState({
          status: 'error',
          lines: [],
          message: data?.message || 'Couldn’t load this script.',
        });
        return;
      }
      if (data?.status === 'unavailable') {
        setState({
          status: 'unavailable',
          lines: [],
          message: data?.message || 'This video has no captions.',
        });
        return;
      }
      const lines = String(data?.plain_text || '').split('\n').filter(Boolean);
      setState({ status: 'ok', lines });
    } catch {
      setState({ status: 'error', lines: [], message: 'Couldn’t load this script.' });
    }
  }, [videoId]);

  const onClick = useCallback(() => {
    if (!isPaid) {
      showPaywall('video_transcript');
      return;
    }
    setOpen(true);
    if (state.status === 'idle' || state.status === 'error') void load();
  }, [isPaid, showPaywall, load, state.status]);

  const copyAll = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(state.lines.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — the text is on screen and selectable anyway */
    }
  }, [state.lines]);

  const unavailable = disabled || !videoId;
  const isMobile = typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT;

  const body = (
    <div className="text-left">
      {state.status === 'loading' && (
        <div className="flex items-center gap-2 py-6 justify-center text-xs text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          {/* Named honestly: the vendor call takes 5-7s and pretending
              otherwise just makes it feel broken. */}
          pulling script...
        </div>
      )}

      {state.status === 'unavailable' && (
        <div className="flex items-start gap-2 py-4 text-xs text-muted-foreground">
          <AlertCircle size={13} className="flex-shrink-0 mt-0.5" />
          <span>{state.message}</span>
        </div>
      )}

      {state.status === 'error' && (
        <div className="flex items-start gap-2 py-4 text-xs text-muted-foreground">
          <AlertCircle size={13} className="flex-shrink-0 mt-0.5" />
          <span>{state.message}</span>
        </div>
      )}

      {state.status === 'ok' && (
        <>
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {state.lines.length} line{state.lines.length === 1 ? '' : 's'}
            </span>
            <div className="flex items-center gap-2">
              {videoUrl && (
                <a
                  href={videoUrl}
                  target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary transition-colors"
                >
                  <ExternalLink size={10} /> Watch
                </a>
              )}
              <button
                onClick={copyAll}
                className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors bg-transparent cursor-pointer"
                data-testid="script-copy"
              >
                {copied ? <Check size={10} className="text-primary" /> : <Copy size={10} />}
                {copied ? 'Copied' : 'Copy all'}
              </button>
            </div>
          </div>

          <div className="max-h-[50vh] md:max-h-[320px] overflow-y-auto pr-1">
            {state.lines.map((line, i) => (
              <p
                key={i}
                className={
                  i === 0
                    // The first line is the hook — the thing worth stealing —
                    // so it is emphasised rather than buried in the paragraph.
                    ? 'text-sm font-semibold text-foreground leading-snug mb-2 pb-2 border-b border-border'
                    : 'text-xs text-muted-foreground leading-relaxed mb-1'
                }
              >
                {line}
              </p>
            ))}
          </div>
        </>
      )}
    </div>
  );

  return (
    <>
      <button
        onClick={unavailable ? undefined : onClick}
        disabled={unavailable}
        title={
          unavailable
            ? 'No captions available for this video'
            : isPaid ? 'Read this video’s script' : 'Reading the script is a Pro feature'
        }
        className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border transition-colors bg-transparent ${
          unavailable
            ? 'border-border text-zinc-600 cursor-not-allowed'
            : 'border-border text-muted-foreground hover:text-primary hover:border-primary/40 cursor-pointer'
        }`}
        data-testid={`script-button-${videoId ?? 'none'}`}
      >
        {isPaid ? <FileText size={9} /> : <Lock size={9} />}
        Script
      </button>

      {/* Mobile gets a vaul drawer; desktop expands inline under the card. */}
      {open && isMobile && (
        <Drawer open={open} onOpenChange={setOpen}>
          <DrawerContent className="px-4 pb-6">
            <DrawerTitle className="text-sm font-semibold text-foreground py-3">
              Script
            </DrawerTitle>
            {body}
          </DrawerContent>
        </Drawer>
      )}

      {open && !isMobile && (
        <div
          className="absolute left-0 right-0 top-full mt-1 z-20 rounded-lg border border-border bg-card p-3 shadow-lg"
          data-testid="script-panel"
        >
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-semibold text-foreground">Script</span>
            <button
              onClick={() => setOpen(false)}
              className="h-6 w-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary border-none bg-transparent cursor-pointer"
              aria-label="Close script"
            >
              <X size={12} />
            </button>
          </div>
          {body}
        </div>
      )}
    </>
  );
}
