import type { RuleInput } from './rules';

/** Client-safe text for alert rules (no server imports). */

/** The name a rule gets from its parameters. The editor keeps it in step until the user writes their own. */
export function autoRuleName(rule: RuleInput): string {
  switch (rule.kind) {
    case 'price_move':
      return rule.params.direction === 'up' ? `Daily rise of ${rule.params.thresholdPct}% or more` : rule.params.direction === 'down' ? `Daily fall of ${rule.params.thresholdPct}% or more` : `Daily move beyond ±${rule.params.thresholdPct}%`;
    case 'volume_spike':
      return `Volume above ${rule.params.multiple}× its ${rule.params.lookbackSessions}-session average`;
    case 'announcement':
      return 'Material filings';
  }
}

/** What the rule actually tests, independent of its (editable) name. */
export function describeRule(rule: RuleInput): string {
  switch (rule.kind) {
    case 'price_move':
      return `Fires when the end-of-day change in adjusted close is ${rule.params.direction === 'up' ? 'up' : rule.params.direction === 'down' ? 'down' : 'up or down'} by ${rule.params.thresholdPct}% or more${rule.params.minVolumeShares ? ` on at least ${rule.params.minVolumeShares.toLocaleString('en-IN')} shares` : ''}.`;
    case 'volume_spike':
      return `Fires when session volume is at least ${rule.params.multiple}× the average of the previous ${rule.params.lookbackSessions} sessions (needs ${rule.params.minHistorySessions} sessions of history).`;
    case 'announcement':
      return `Fires on filings in ${rule.params.categories.length} categor${rule.params.categories.length === 1 ? 'y' : 'ies'} ranked ${rule.params.minTier} priority or higher.`;
  }
}
