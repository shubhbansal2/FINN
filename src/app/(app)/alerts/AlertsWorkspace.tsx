'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { CATEGORIES, CATEGORY_LABEL } from '@/domain/taxonomy';
import type { AlertRule, RuleInput } from '@/push/rules';
import { autoRuleName, describeRule } from '@/push/rule-text';
import type { StoredAlert } from '@/push/store';
import { Banner } from '@/ui/Banner';
import { Button } from '@/ui/Button';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { EmptyState } from '@/ui/EmptyState';
import { SectionHeading } from '@/ui/SectionHeading';
import { Timestamp } from '@/ui/Timestamp';

import { SignalItem } from '../SignalDetail';
import styles from './Alerts.module.css';

type Company = { id: string; name: string; symbol: string };

/** Sends a JSON request; returns an error message, or null on success. */
async function send(url: string, method: string, body?: unknown): Promise<string | null> {
  try {
    const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.ok) return null;
    const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    return json?.error?.message ?? `Request failed (HTTP ${res.status}).`;
  } catch (e) {
    return `Could not reach the server (${e instanceof Error ? e.message : 'network error'}).`;
  }
}

const TEMPLATES: Record<RuleInput['kind'], RuleInput> = {
  price_move: { kind: 'price_move', name: 'Daily move beyond ±5%', enabled: true, scope: { type: 'watchlist' }, params: { thresholdPct: 5, direction: 'both', minVolumeShares: 0 } },
  volume_spike: { kind: 'volume_spike', name: 'Volume above 2× its 20-session average', enabled: true, scope: { type: 'watchlist' }, params: { multiple: 2, lookbackSessions: 20, minHistorySessions: 15, minVolumeShares: 0 } },
  announcement: { kind: 'announcement', name: 'Material filings', enabled: true, scope: { type: 'watchlist' }, params: { categories: ['results'], minTier: 'medium' } },
};

const KIND_LABEL: Record<RuleInput['kind'], string> = { price_move: 'Price move', volume_spike: 'Volume', announcement: 'Filings' };

function NumberField(props: { label: string; value: number; onChange: (v: number) => void; step?: number; min: number; max: number; hint?: string }) {
  return (
    <label className={styles.field}>
      <span className={styles.label}>{props.label}</span>
      <input
        className={styles.input}
        type="number"
        inputMode="decimal"
        value={Number.isFinite(props.value) ? props.value : ''}
        step={props.step ?? 1}
        min={props.min}
        max={props.max}
        onChange={(e) => props.onChange(e.target.valueAsNumber)}
        required
      />
      {props.hint ? <span className={styles.hint}>{props.hint}</span> : null}
    </label>
  );
}

function RuleForm({ initial, ruleId, version, companies, onDone }: { initial: RuleInput; ruleId: string | null; version: number | null; companies: Company[]; onDone: (message: string) => void }) {
  const [rule, setRule] = useState<RuleInput>(initial);
  // Parameter edits carry the generated name along, unless the user has written their own.
  const update = (next: RuleInput) => setRule((prev) => ({ ...next, name: prev.name === autoRuleName(prev) ? autoRuleName(next) : next.name }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const message = await send(ruleId ? `/api/alerts/rules/${ruleId}` : '/api/alerts/rules', ruleId ? 'PUT' : 'POST', rule);
    setSaving(false);
    if (message) setError(message);
    else onDone(ruleId ? `Saved "${rule.name}". Already-alerted events are not re-sent.` : `Created "${rule.name}".`);
  };

  const remove = async () => {
    if (!ruleId) return;
    setDeleting(true);
    const message = await send(`/api/alerts/rules/${ruleId}`, 'DELETE');
    setDeleting(false);
    if (message) {
      setError(message);
      return;
    }
    setConfirm(false);
    onDone(`Deleted "${rule.name}". Its past alerts are kept.`);
  };

  const selected = rule.scope.type === 'companies' ? rule.scope.companyIds : [];
  const setScope = (ids: string[]) => setRule({ ...rule, scope: ids.length ? { type: 'companies', companyIds: ids } : { type: 'watchlist' } });

  return (
    <form className={styles.rule} onSubmit={submit} aria-label={ruleId ? `Edit rule ${rule.name}` : 'New rule'}>
      <div className={styles.ruleHead}>
        <span className={styles.kind}>{KIND_LABEL[rule.kind]}</span>
        {version ? <span className={styles.hint}>v{version}</span> : null}
        <label className={styles.toggle}>
          <input type="checkbox" checked={rule.enabled} onChange={(e) => setRule({ ...rule, enabled: e.target.checked })} />
          Enabled
        </label>
      </div>
      <div className={styles.grid}>
        <label className={`${styles.field} ${styles.wide}`}>
          <span className={styles.label}>Name</span>
          <input className={styles.input} value={rule.name} maxLength={80} onChange={(e) => setRule({ ...rule, name: e.target.value })} required />
          <span className={styles.hint}>{describeRule(rule)}</span>
        </label>
        {rule.kind === 'price_move' ? (
          <>
            <NumberField label="Threshold (%)" value={rule.params.thresholdPct} step={0.5} min={0.5} max={50} onChange={(v) => update({ ...rule, params: { ...rule.params, thresholdPct: v } })} hint="Absolute daily change on the adjusted close" />
            <label className={styles.field}>
              <span className={styles.label}>Direction</span>
              <select className={styles.input} value={rule.params.direction} onChange={(e) => update({ ...rule, params: { ...rule.params, direction: e.target.value as 'both' | 'up' | 'down' } })}>
                <option value="both">Up or down</option>
                <option value="up">Up only</option>
                <option value="down">Down only</option>
              </select>
            </label>
            <NumberField label="Min volume (shares)" value={rule.params.minVolumeShares} min={0} max={1e10} onChange={(v) => update({ ...rule, params: { ...rule.params, minVolumeShares: v } })} hint="0 = no minimum" />
          </>
        ) : null}
        {rule.kind === 'volume_spike' ? (
          <>
            <NumberField label="Multiple of average" value={rule.params.multiple} step={0.1} min={1.2} max={50} onChange={(v) => update({ ...rule, params: { ...rule.params, multiple: v } })} />
            <NumberField label="Lookback (sessions)" value={rule.params.lookbackSessions} min={5} max={120} onChange={(v) => update({ ...rule, params: { ...rule.params, lookbackSessions: v } })} hint="Excludes the session itself" />
            <NumberField label="Min history (sessions)" value={rule.params.minHistorySessions} min={3} max={120} onChange={(v) => update({ ...rule, params: { ...rule.params, minHistorySessions: v } })} />
            <NumberField label="Min volume (shares)" value={rule.params.minVolumeShares} min={0} max={1e10} onChange={(v) => update({ ...rule, params: { ...rule.params, minVolumeShares: v } })} hint="0 = no minimum" />
          </>
        ) : null}
        {rule.kind === 'announcement' ? (
          <>
            <label className={styles.field}>
              <span className={styles.label}>Minimum priority</span>
              <select className={styles.input} value={rule.params.minTier} onChange={(e) => update({ ...rule, params: { ...rule.params, minTier: e.target.value as 'high' | 'medium' | 'low' | 'routine' } })}>
                <option value="high">High only</option>
                <option value="medium">Medium and above</option>
                <option value="low">Low and above</option>
              </select>
            </label>
            <fieldset className={`${styles.fieldset} ${styles.wide}`}>
              <legend className={styles.label}>Categories</legend>
              <div className={styles.checks}>
                {CATEGORIES.filter((c) => c !== 'unclassified').map((c) => (
                  <label key={c} className={styles.check}>
                    <input
                      type="checkbox"
                      checked={rule.params.categories.includes(c)}
                      onChange={(e) =>
                        update({ ...rule, params: { ...rule.params, categories: e.target.checked ? [...rule.params.categories, c] : rule.params.categories.filter((x) => x !== c) } })
                      }
                    />
                    {CATEGORY_LABEL[c]}
                  </label>
                ))}
              </div>
            </fieldset>
          </>
        ) : null}
        <details className={`${styles.wide} ${styles.scope}`}>
          <summary>Applies to: {selected.length ? `${selected.length} selected compan${selected.length === 1 ? 'y' : 'ies'}` : 'the whole watchlist'}</summary>
          <div className={styles.checks}>
            {companies.map((c) => (
              <label key={c.id} className={styles.check}>
                <input type="checkbox" checked={selected.includes(c.id)} onChange={(e) => setScope(e.target.checked ? [...selected, c.id] : selected.filter((x) => x !== c.id))} />
                {c.symbol}
              </label>
            ))}
          </div>
          <p className={styles.hint}>Leave all unticked to watch the whole watchlist.</p>
        </details>
      </div>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button type="submit" variant="primary" size="sm" loading={saving} loadingLabel="Saving rule">
          {ruleId ? 'Save' : 'Create rule'}
        </Button>
        {ruleId ? (
          <Button variant="quiet" size="sm" onClick={() => setConfirm(true)}>
            Delete…
          </Button>
        ) : null}
      </div>
      {ruleId ? (
        <ConfirmDialog
          open={confirm}
          title={`Delete "${rule.name}"?`}
          consequence="FINN will stop evaluating this rule. Alerts it has already produced stay in the inbox. This cannot be undone."
          confirmLabel="Delete rule"
          tone="danger"
          busy={deleting}
          busyLabel="Deleting rule"
          error={error}
          onConfirm={() => void remove()}
          onCancel={() => setConfirm(false)}
        />
      ) : null}
    </form>
  );
}

export function AlertsWorkspace({ alerts, rules, companies, evaluatedAt }: { alerts: StoredAlert[]; rules: AlertRule[]; companies: Company[]; evaluatedAt: string }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'evaluate' | 'ack' | null>(null);
  const [newKind, setNewKind] = useState<RuleInput['kind'] | null>(null);
  const pending = alerts.filter((a) => a.delivery.status === 'pending');
  const seen = alerts.filter((a) => a.delivery.status === 'seen');

  const done = (msg: string) => {
    setMessage(msg);
    setError(null);
    setNewKind(null);
    router.refresh();
  };

  const evaluate = async () => {
    setBusy('evaluate');
    const res = await fetch('/api/alerts/evaluate', { method: 'POST' }).catch(() => null);
    setBusy(null);
    if (!res?.ok) {
      setError('Evaluation failed; nothing was changed.');
      return;
    }
    const r = (await res.json()) as { created: number; skippedDuplicates: number; rules: number };
    done(`Evaluated ${r.rules} rule(s): ${r.created} new alert(s), ${r.skippedDuplicates} already alerted.`);
  };

  const ackAll = async () => {
    setBusy('ack');
    const err = await send('/api/alerts/ack', 'POST', { ids: pending.map((a) => a.id) });
    setBusy(null);
    if (err) setError(err);
    else done(`Marked ${pending.length} alert(s) as seen.`);
  };

  return (
    <div className={styles.workspace}>
      <div className={styles.toolbar}>
        <p className={styles.hint}>
          <Timestamp iso={evaluatedAt} prefix="Evaluated" /> · on page load and on demand only. FINN does not watch markets continuously or send push notifications.
        </p>
        <Button size="sm" icon="clock" onClick={() => void evaluate()} loading={busy === 'evaluate'} loadingLabel="Evaluating">
          Evaluate now
        </Button>
      </div>
      {message ? <Banner tone="info" title={message} /> : null}
      {error ? <Banner tone="error" title={error} /> : null}

      <section aria-labelledby="inbox">
        <SectionHeading id="inbox" aside={pending.length ? <Button size="sm" variant="quiet" onClick={() => void ackAll()} loading={busy === 'ack'} loadingLabel="Marking as seen">Mark all seen</Button> : undefined}>
          New alerts ({pending.length})
        </SectionHeading>
        {pending.length === 0 ? (
          <EmptyState title="No new alerts.">Alerts appear here when an enabled rule fires on a filing or an end-of-day session in the last 10 days. Each event alerts once per rule.</EmptyState>
        ) : (
          pending.map((a) => (
            <div key={a.id}>
              <p className={styles.ruleTag}>
                {a.ruleName} · v{a.ruleVersion}
              </p>
              <SignalItem signal={a.signal} />
            </div>
          ))
        )}
        {seen.length ? (
          <details className={styles.seen}>
            <summary>{seen.length} seen alert(s)</summary>
            {seen.map((a) => (
              <div key={a.id}>
                <p className={styles.ruleTag}>
                  {a.ruleName} · v{a.ruleVersion} · <Timestamp iso={a.delivery.seenAt ?? a.evaluatedAt} prefix="seen" />
                </p>
                <SignalItem signal={a.signal} />
              </div>
            ))}
          </details>
        ) : null}
      </section>

      <section aria-labelledby="rules">
        <SectionHeading id="rules" aside={`${rules.length} rule(s)`}>
          Rules
        </SectionHeading>
        <div className={styles.rules}>
          {/* The API schema strips the stored metadata fields (id, version, timestamps) from the body. */}
          {rules.map((r) => (
            <RuleForm key={`${r.id}:${r.version}`} initial={r} ruleId={r.id} version={r.version} companies={companies} onDone={done} />
          ))}
          {newKind ? (
            <RuleForm key={`new:${newKind}`} initial={TEMPLATES[newKind]} ruleId={null} version={null} companies={companies} onDone={done} />
          ) : (
            <div className={styles.add}>
              <span className={styles.label}>Add a rule</span>
              {(Object.keys(TEMPLATES) as RuleInput['kind'][]).map((k) => (
                <Button key={k} size="sm" onClick={() => setNewKind(k)}>
                  {KIND_LABEL[k]}
                </Button>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
