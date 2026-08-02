// "Study the script" — the spoken transcript of one video.
//
// Pro-only, fetched ON CLICK, cached permanently. Never in the nightly
// pipeline: blanket-fetching the 163,311 videos we already hold would cost
// 163k credits, roughly 27x the entire daily snapshot budget (probe fb8c4ed).
//
// VENDOR CONTRACT (probe fb8c4ed, 2026-07-28):
//   GET /v1/tiktok/video/transcript?url=<full tiktok video url>
//   header x-api-key
//   1 credit per request, 5.6-6.8s latency
//   200 -> { success, credits_remaining, credits_charged, id, url, transcript }
//          `transcript` is WebVTT; there is no language field in the response.
//   NO CAPTIONS IS NOT AN ERROR STATUS (Step 0, 2026-08-02): the vendor answers
//   200 with `transcript: null` and charges a credit anyway, for both a
//   caption-less video and an unresolvable one. Only the presence of `id`
//   separates the two.
//   The `use_ai_as_fallback=true` option costs 10 CREDITS and is never sent.
//
// The parameter is a URL, not an id, so the video_url is looked up from
// product_videos rather than reconstructed.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { resolveTier } from '../shared/resolve-tier';

const API_BASE = 'https://api.scrapecreators.com';
const FETCH_TIMEOUT_MS = 20_000; // vendor measured at 5.6-6.8s; leave headroom
const DEFAULT_DAILY_CAP = 200;

// Per-user, not per-IP: this endpoint spends money, and the tier is already
// resolved from the token, so the identity is better than an IP.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const hits = new Map<string, { count: number; resetAt: number }>();

function getAdminClient() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function dailyCap(): number {
  const raw = Number(process.env.TRANSCRIPT_DAILY_CAP);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DAILY_CAP;
}

function rateLimited(key: string, now: number): boolean {
  const entry = hits.get(key);
  if (!entry || now >= entry.resetAt) {
    hits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    if (hits.size > 5000) for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k);
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

/**
 * WebVTT -> readable lines.
 *
 * Drops the WEBVTT header, cue numbers and `00:00:00.020 --> 00:00:02.220`
 * timing rows, keeping the spoken lines in order. Consecutive duplicates are
 * collapsed because VTT repeats a line across cues when a sentence spans them.
 */
export function vttToPlainText(vtt: string): string {
  const out: string[] = [];
  for (const raw of String(vtt).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^WEBVTT/i.test(line)) continue;
    if (line.includes('-->')) continue;
    if (/^\d+$/.test(line)) continue; // cue index
    if (/^(NOTE|STYLE|REGION)\b/i.test(line)) continue;
    if (out[out.length - 1] === line) continue;
    out.push(line);
  }
  return out.join('\n');
}

interface CachedRow {
  video_id: string;
  webvtt: string | null;
  plain_text: string | null;
  status: 'ok' | 'unavailable';
  fetched_at: string;
}

function serveCached(res: VercelResponse, row: CachedRow, source: string) {
  res.setHeader('X-Transcript-Source', source);
  // A transcript never changes, so the browser may keep it. Private because the
  // endpoint is Pro-only and the CDN ignores auth.
  res.setHeader('Cache-Control', 'private, max-age=86400');
  if (row.status === 'unavailable') {
    return res.json({
      video_id: row.video_id,
      status: 'unavailable',
      reason: 'no_captions',
      message: 'This video has no captions to pull a script from.',
      fetched_at: row.fetched_at,
    });
  }
  return res.json({
    video_id: row.video_id,
    status: 'ok',
    plain_text: row.plain_text ?? '',
    webvtt: row.webvtt ?? '',
    fetched_at: row.fetched_at,
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const videoId = String(req.query.video_id ?? '').trim();
    if (!/^\d{5,}$/.test(videoId)) {
      return res.status(400).json({ error: 'Missing or invalid video_id' });
    }

    const supabase = getAdminClient();
    const tier = await resolveTier(req, supabase);

    // Pro-only. This is the flagship Pro feature AND the only endpoint that
    // spends money per click, so the gate is here, not in the UI.
    if (tier !== 'paid') {
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.status(402).json({
        error: 'upgrade_required',
        feature: 'transcript',
        message: 'Reading a video’s script is a Pro feature.',
      });
    }

    // 1. Cache first — a hit costs nothing and is the common case.
    const { data: cached } = await supabase
      .from('video_transcripts')
      .select('video_id,webvtt,plain_text,status,fetched_at')
      .eq('video_id', videoId)
      .maybeSingle();
    if (cached) return serveCached(res, cached as CachedRow, 'cache');

    // Rate limit only the paths that can spend.
    const rlKey = (req.headers.authorization || '').slice(-32) || 'anon';
    if (rateLimited(rlKey, Date.now())) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({
        error: 'rate_limited',
        message: 'Too many scripts at once — try again in a minute.',
      });
    }

    // 2. The URL is what the vendor takes, and product_videos already holds it.
    const { data: vid } = await supabase
      .from('product_videos')
      .select('video_url')
      .eq('video_id', videoId)
      .not('video_url', 'is', null)
      .limit(1)
      .maybeSingle();
    const videoUrl = (vid as any)?.video_url as string | undefined;
    if (!videoUrl) {
      return res.status(404).json({ error: 'not_found', message: 'Unknown video.' });
    }

    const apiKey = process.env.SCRAPECREATORS_API_KEY;
    if (!apiKey) {
      console.error('transcript: SCRAPECREATORS_API_KEY missing');
      return res.status(503).json({
        error: 'unavailable',
        message: 'Scripts are temporarily unavailable.',
      });
    }

    // 3. Reserve a credit BEFORE spending. Reserve-then-refund, because two
    //    concurrent requests reading "199 of 200 used" would both proceed.
    const cap = dailyCap();
    const { data: allowed, error: capErr } = await supabase.rpc('transcript_try_spend', {
      p_cap: cap,
    });
    if (capErr) {
      console.error('transcript: cap check failed:', capErr.message);
      return res.status(503).json({ error: 'unavailable', message: 'Scripts are temporarily unavailable.' });
    }
    if (allowed !== true) {
      console.warn(`transcript: daily cap reached (${cap}) — refusing new fetch for ${videoId}`);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(429).json({
        error: 'daily_limit',
        message: 'We’ve hit today’s script limit. Already-loaded scripts still work, and this one will be available tomorrow.',
      });
    }

    const refund = async () => {
      const { error } = await supabase.rpc('transcript_refund');
      if (error) console.warn('transcript: refund failed:', error.message);
    };

    // 4. One plain call. use_ai_as_fallback is NEVER sent — it costs 10 credits.
    const started = Date.now();
    const path = `/v1/tiktok/video/transcript?url=${encodeURIComponent(videoUrl)}`;
    let httpStatus = 0;
    let body: any = null;
    try {
      const r = await fetch(`${API_BASE}${path}`, {
        headers: { 'x-api-key': apiKey },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      httpStatus = r.status;
      body = await r.json().catch(() => null);
    } catch (e: any) {
      await refund();
      console.warn(`transcript spend: video=${videoId} status=network_error charged=0 refunded=1 (${e?.name})`);
      return res.status(503).json({
        error: 'unavailable',
        message: 'Couldn’t reach the transcript service. Try again shortly.',
      });
    }

    const charged = Number(body?.credits_charged) || 0;
    const elapsed = Date.now() - started;

    // Every spend is logged, charged or not.
    console.log(
      `transcript spend: video=${videoId} http=${httpStatus} charged=${charged} ` +
      `remaining=${body?.credits_remaining ?? 'n/a'} ms=${elapsed} cap=${cap}`,
    );

    const transcript = typeof body?.transcript === 'string' ? body.transcript : '';

    // 5a. SUCCESS.
    if (httpStatus === 200 && body?.success === true && transcript.trim()) {
      const plain = vttToPlainText(transcript);
      const { error: insErr } = await supabase.from('video_transcripts').upsert(
        {
          video_id: videoId,
          webvtt: transcript,
          plain_text: plain,
          status: 'ok',
          credits_spent: charged,
          fetched_at: new Date().toISOString(),
        },
        { onConflict: 'video_id' },
      );
      if (insErr) console.warn('transcript: cache write failed:', insErr.message);
      res.setHeader('X-Transcript-Source', 'origin');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      return res.json({
        video_id: videoId,
        status: 'ok',
        plain_text: plain,
        webvtt: transcript,
        fetched_at: new Date().toISOString(),
      });
    }

    // 5b. A SUCCESSFUL ANSWER WITH NO TRANSCRIPT — cache as permanently
    //     unavailable, so the same video is never paid for twice.
    //
    //     OBSERVED, Step 0 re-run on 2026-08-02 (3 credits). The vendor does not
    //     use an error status for "no captions". It answers 200 with
    //     `transcript: null` — note null, not an empty string — and still
    //     charges 1 credit:
    //
    //       no-speech video   200 success:true transcript:null  charged 1  (id present)
    //       invalid video id  200 success:true transcript:null  charged 1  (id ABSENT)
    //       known-good        200 success:true transcript:<vtt> charged 1  (id present)
    //
    //     So the narrow condition written before the probe was correct, and the
    //     `typeof transcript === 'string'` guard above is what makes null fall
    //     through to here rather than being stored as an empty 'ok'.
    //
    //     The `id` field is the only thing separating "the vendor found the
    //     video and it has no speech" from "the vendor could not resolve the
    //     video at all". Both are permanently unavailable to us and both are
    //     cached, so the distinction only changes the reason recorded — but it
    //     costs nothing to record it accurately.
    if (httpStatus === 200 && body?.success === true) {
      const resolvedByVendor = body?.id !== undefined && body?.id !== null;
      await supabase.from('video_transcripts').upsert(
        {
          video_id: videoId,
          webvtt: null,
          plain_text: null,
          status: 'unavailable',
          credits_spent: charged,
          fetched_at: new Date().toISOString(),
        },
        { onConflict: 'video_id' },
      );
      res.setHeader('X-Transcript-Source', 'origin');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      return res.json({
        video_id: videoId,
        status: 'unavailable',
        reason: resolvedByVendor ? 'no_captions' : 'video_not_found',
        message: resolvedByVendor
          ? 'This video has no captions to pull a script from.'
          : 'TikTok no longer serves this video, so there is no script to pull.',
      });
    }

    // 5c. EVERYTHING ELSE IS TRANSIENT AND MUST NOT BE CACHED.
    //
    //     402 (out of credits), 5xx, malformed body. Writing 'unavailable' here
    //     would permanently mark a video as captionless because of an outage —
    //     and on 2026-08-01 every single endpoint returned
    //     402 "Looks like you're out of credits", so this is the live case, not
    //     a hypothetical one.
    if (charged === 0) await refund();

    const outOfCredits =
      httpStatus === 402 || /out of credits/i.test(String(body?.message ?? ''));
    if (outOfCredits) {
      console.error('transcript: VENDOR OUT OF CREDITS — top up ScrapeCreators');
      return res.status(503).json({
        error: 'vendor_out_of_credits',
        message: 'Scripts are temporarily unavailable. Already-loaded scripts still work.',
      });
    }

    return res.status(503).json({
      error: 'unavailable',
      message: 'Couldn’t load this script. Try again shortly.',
      vendor_status: httpStatus,
    });
  } catch (err: any) {
    console.error('video-transcript error:', err?.message);
    return res.status(500).json({ error: 'Failed to load transcript' });
  }
}
