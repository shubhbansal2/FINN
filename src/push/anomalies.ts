import { formatSignedPercent } from '@/ui/format';

import { signalId, type SignalPolicy } from './policy';
import type { BarSeries, Signal, Tier } from './types';

/**
 * End-of-day price and volume anomalies. Pure functions over stored,
 * completed sessions. Missing data is reported as not computable, never as zero.
 */

/** EOD events are timestamped at the NSE close, 15:30 IST (10:00 UTC), of their trading date. */
export const sessionCloseUtc = (tradeDate: string) => `${tradeDate}T10:00:00.000Z`;

/** Provider prices are floats; show them to the paisa, as exchanges quote them. */
const rupees = (v: number) => v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export type PriceMoveParams = Pick<SignalPolicy['prices'], 'movePct' | 'highMoveMultiple' | 'series' | 'maxSessionGapDays' | 'corporateActionGapPct'> & {
  direction?: 'both' | 'up' | 'down';
  minVolumeShares?: number;
};

export type AnomalyResult =
  | { status: 'signal'; signal: Signal; value: number }
  | { status: 'below_threshold'; value: number }
  | { status: 'filtered'; reason: string }
  | { status: 'not_computable'; reason: string };

/** Daily return for the session at `index`, on the configured series, with the caveats that apply. */
export function dailyReturn(series: BarSeries, index: number, params: Pick<PriceMoveParams, 'series' | 'maxSessionGapDays' | 'corporateActionGapPct'>) {
  const bar = series.bars[index];
  const prev = series.bars[index - 1];
  if (!bar) return { ok: false as const, reason: 'session not found' };
  if (!prev) return { ok: false as const, reason: 'no earlier session stored to compare with' };
  const gap = dayDiff(prev.tradeDate, bar.tradeDate);
  if (gap > params.maxSessionGapDays) return { ok: false as const, reason: `the previous stored session is ${gap} days earlier (${prev.tradeDate}); missing data would distort the change` };

  const raw = bar.close / prev.close - 1;
  const notes: string[] = [];
  let value = raw;
  let seriesUsed: 'adjusted close' | 'close' = 'close';
  if (params.series === 'adjusted_close') {
    if (bar.adjClose !== null && prev.adjClose !== null) {
      value = bar.adjClose / prev.adjClose - 1;
      seriesUsed = 'adjusted close';
      if (Math.abs(value - raw) * 100 > params.corporateActionGapPct) {
        notes.push(`Raw close changed ${formatSignedPercent(raw)} while the adjusted close changed ${formatSignedPercent(value)}: a split, bonus or dividend adjustment is likely between these sessions. The adjusted figure is used.`);
      }
    } else {
      notes.push('Adjusted close was not available for both sessions; the raw close is used, so a corporate action could distort this change.');
    }
  }
  return { ok: true as const, value, raw, seriesUsed, prev, bar, notes };
}

export function evaluatePriceMove(series: BarSeries, index: number, params: PriceMoveParams): AnomalyResult {
  const r = dailyReturn(series, index, params);
  if (!r.ok) return { status: 'not_computable', reason: r.reason };
  const pct = Math.abs(r.value) * 100;
  // Compare at the precision shown to the user, so the displayed figure and the rule agree at the boundary.
  const shown = Math.round(pct * 100) / 100;
  if (shown < params.movePct) return { status: 'below_threshold', value: r.value };
  const direction = params.direction ?? 'both';
  if ((direction === 'up' && r.value < 0) || (direction === 'down' && r.value > 0)) return { status: 'filtered', reason: `move is ${r.value > 0 ? 'up' : 'down'}; rule watches ${direction} moves only` };
  if (params.minVolumeShares && r.bar.volume < params.minVolumeShares) return { status: 'filtered', reason: `volume ${r.bar.volume} is below the minimum ${params.minVolumeShares}` };

  const high = shown >= params.movePct * params.highMoveMultiple;
  const tier: Tier = high ? 'high' : 'medium';
  const move = formatSignedPercent(r.value);
  return {
    status: 'signal',
    value: r.value,
    signal: {
      id: signalId('px', `${series.listingId}:${r.bar.tradeDate}`),
      kind: 'price_move',
      companyId: series.companyId,
      companyName: series.companyName,
      symbol: series.symbol,
      tier,
      occurredAt: sessionCloseUtc(r.bar.tradeDate),
      ingestedAt: r.bar.lastIngestedAt,
      tradeDate: r.bar.tradeDate,
      headline: `${series.symbol} ${r.value >= 0 ? 'rose' : 'fell'} ${move.replace(/^[+−]/, '')} on the day`,
      category: null,
      explanation: {
        what: `${series.companyName} closed ${move} on ${r.bar.tradeDate} versus the previous session (${r.prev.tradeDate}), on the ${r.seriesUsed}.`,
        why: [
          `The absolute daily change, ${shown.toFixed(2)}%, is at or above the ${params.movePct}% threshold.`,
          ...(high ? [`It is at least ${params.highMoveMultiple}× the threshold, so it ranks high.`] : []),
        ],
        rules: [`price.move>=${params.movePct}%`, ...(high ? [`price.move>=${params.movePct * params.highMoveMultiple}%`] : [])],
        evidence: [{ kind: 'price_series', label: `${series.symbol} end-of-day`, detail: `${r.prev.tradeDate} close ₹${rupees(r.prev.close)} → ${r.bar.tradeDate} close ₹${rupees(r.bar.close)}; adjusted ${r.prev.adjClose === null ? 'n/a' : `₹${rupees(r.prev.adjClose)}`} → ${r.bar.adjClose === null ? 'n/a' : `₹${rupees(r.bar.adjClose)}`}` }],
        unknowns: ['End-of-day data only: the intraday path and timing are unknown.', 'FINN has not established what caused this move.', ...r.notes],
      },
      components: [],
      measure: { kind: 'change', value: r.value },
      duplicates: [],
      stale: false,
      firstCut: null,
      dataMode: series.dataMode,
    },
  };
}

export type VolumeParams = Pick<SignalPolicy['volume'], 'multiple' | 'highMultiple' | 'lookbackSessions' | 'minHistorySessions' | 'minVolumeShares'>;

/** Volume relative to the mean of the preceding sessions. The session itself is never part of its own baseline. */
export function volumeRatio(series: BarSeries, index: number, params: Pick<VolumeParams, 'lookbackSessions' | 'minHistorySessions'>) {
  const bar = series.bars[index];
  if (!bar) return { ok: false as const, reason: 'session not found' };
  if (bar.volume <= 0) return { ok: false as const, reason: `no traded volume reported for ${bar.tradeDate}; treated as unavailable` };
  const window = series.bars.slice(Math.max(0, index - params.lookbackSessions), index);
  // Zero-volume sessions are suspensions or data gaps, not genuine zero trading: excluded, never averaged in.
  const usable = window.filter((b) => b.volume > 0);
  const excluded = window.length - usable.length;
  if (usable.length < params.minHistorySessions) {
    return { ok: false as const, reason: `insufficient history: ${usable.length} usable prior sessions, ${params.minHistorySessions} required` };
  }
  const mean = usable.reduce((s, b) => s + b.volume, 0) / usable.length;
  if (!(mean > 0)) return { ok: false as const, reason: 'baseline average volume is zero; the ratio is undefined' };
  return { ok: true as const, ratio: bar.volume / mean, mean, used: usable.length, excluded, bar, from: usable[0]?.tradeDate ?? '', to: usable[usable.length - 1]?.tradeDate ?? '' };
}

export function evaluateVolumeSpike(series: BarSeries, index: number, params: VolumeParams): AnomalyResult {
  const r = volumeRatio(series, index, params);
  if (!r.ok) return { status: 'not_computable', reason: r.reason };
  const shown = Math.round(r.ratio * 100) / 100;
  if (shown < params.multiple) return { status: 'below_threshold', value: r.ratio };
  if (params.minVolumeShares && r.bar.volume < params.minVolumeShares) return { status: 'filtered', reason: `volume ${r.bar.volume} is below the minimum ${params.minVolumeShares}` };
  const high = shown >= params.highMultiple;
  return {
    status: 'signal',
    value: r.ratio,
    signal: {
      id: signalId('vol', `${series.listingId}:${r.bar.tradeDate}`),
      kind: 'volume_spike',
      companyId: series.companyId,
      companyName: series.companyName,
      symbol: series.symbol,
      tier: high ? 'high' : 'medium',
      occurredAt: sessionCloseUtc(r.bar.tradeDate),
      ingestedAt: r.bar.lastIngestedAt,
      tradeDate: r.bar.tradeDate,
      headline: `${series.symbol} traded ${shown.toFixed(1)}× its average volume`,
      category: null,
      explanation: {
        what: `${series.companyName} traded ${r.bar.volume.toLocaleString('en-IN')} shares on ${r.bar.tradeDate}, ${shown.toFixed(2)}× the average of the previous ${r.used} sessions (${r.from} to ${r.to}).`,
        why: [`Volume is at or above ${params.multiple}× its ${params.lookbackSessions}-session average (the session itself is excluded from the average).`, ...(high ? [`At least ${params.highMultiple}× the average, so it ranks high.`] : [])],
        rules: [`volume.ratio>=${params.multiple}x`, ...(high ? [`volume.ratio>=${params.highMultiple}x`] : [])],
        evidence: [{ kind: 'price_series', label: `${series.symbol} end-of-day volume`, detail: `session ${r.bar.volume.toLocaleString('en-IN')}; baseline mean ${Math.round(r.mean).toLocaleString('en-IN')} over ${r.used} sessions` }],
        unknowns: [
          'FINN has not established why volume was unusual (block deals, index changes and news are not checked).',
          ...(r.excluded ? [`${r.excluded} zero-volume session(s) in the lookback were treated as unavailable and excluded.`] : []),
          ...(r.used < params.lookbackSessions ? [`Only ${r.used} of ${params.lookbackSessions} lookback sessions were available.`] : []),
        ],
      },
      components: [],
      measure: { kind: 'multiple', value: r.ratio },
      duplicates: [],
      stale: false,
      firstCut: null,
      dataMode: series.dataMode,
    },
  };
}

/** All market signals for sessions whose close falls inside [from, to). */
export function marketSignals(series: BarSeries[], policy: SignalPolicy, window: { from: string; to: string }): { signals: Signal[]; notes: string[] } {
  const signals: Signal[] = [];
  const notes: string[] = [];
  for (const s of series) {
    s.bars.forEach((bar, i) => {
      const at = sessionCloseUtc(bar.tradeDate);
      if (at < window.from || at >= window.to) return;
      const px = evaluatePriceMove(s, i, policy.prices);
      if (px.status === 'signal') signals.push(px.signal);
      else if (px.status === 'not_computable') notes.push(`${s.symbol} ${bar.tradeDate} price: ${px.reason}`);
      const vol = evaluateVolumeSpike(s, i, policy.volume);
      if (vol.status === 'signal') signals.push(vol.signal);
      else if (vol.status === 'not_computable') notes.push(`${s.symbol} ${bar.tradeDate} volume: ${vol.reason}`);
    });
  }
  return { signals, notes };
}
