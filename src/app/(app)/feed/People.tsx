import { isIncoming, type PersonChange } from '@/push/types';
import { safeDocumentUrl } from '@/ui/evidence';
import { Icon } from '@/ui/Icon';

import styles from './SignalDetailContent.module.css';

const CHANGE_LABEL: Record<PersonChange['change'], string> = {
  appointed: 'Appointed',
  reappointed: 'Re-appointed',
  redesignated: 'Re-designated',
  resigned: 'Resigned',
  retired: 'Retiring',
  ceased: 'Ceased',
};

/** Incoming people first: who is arriving is usually the news. */
const ordered = (people: PersonChange[]) => [...people].sort((a, b) => Number(isIncoming(b)) - Number(isIncoming(a)));

function PageLink({ url, page }: { url: string | null; page: number | null }) {
  const href = url && page ? safeDocumentUrl(url, page) : null;
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={styles.pageLink}>
      p. {page}
      <span className="visually-hidden"> of the filing (opens in a new tab)</span>
    </a>
  );
}

/**
 * Who changes, and who they are, from the filing itself. Background comes from
 * the filing's own profile; LinkedIn is a search link FINN never fetches.
 */
export function PeopleList({ people, filingUrl, companyName }: { people: PersonChange[]; filingUrl: string | null; companyName: string }) {
  return (
    <ul className={styles.people}>
      {ordered(people).map((p) => (
        <li key={`${p.name}:${p.change}`} className={styles.person}>
          <p className={styles.personHead}>
            <span className={isIncoming(p) ? styles.changeIn : styles.changeOut}>{CHANGE_LABEL[p.change]}</span> <strong>{p.name}</strong>
          </p>
          <p className={styles.personRole}>
            {p.role}
            {p.effective ? <span className={styles.meta}> · effective {p.effective}</span> : null}
          </p>
          {p.background.length ? (
            <ul className={styles.background}>
              {p.background.map((b) => (
                <li key={b.quote}>
                  {b.text} <PageLink url={filingUrl} page={b.page} />
                </li>
              ))}
            </ul>
          ) : isIncoming(p) ? (
            <p className={styles.muted}>The filing gives no background for this appointment.</p>
          ) : null}
          <details className={styles.asFiled}>
            <summary>As filed</summary>
            <q>{p.quote}</q> <PageLink url={filingUrl} page={p.page} />
          </details>
          {isIncoming(p) ? (
            <a
              href={`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${p.name} ${companyName}`)}`}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.source}
            >
              Search LinkedIn <Icon name="external" size={14} />
              <span className="visually-hidden"> (opens in a new tab; FINN does not fetch LinkedIn)</span>
            </a>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** One line for the feed row, e.g. "Appointed: Bahram Vakil, Chairman · Retiring: Noel N. Tata, Chairman +2 more". */
export function peopleSummary(people: PersonChange[]): string | null {
  if (!people.length) return null;
  const list = ordered(people);
  const shown = list.slice(0, 2).map((p) => `${CHANGE_LABEL[p.change]}: ${p.name}, ${p.role}`);
  return `${shown.join(' · ')}${list.length > 2 ? ` +${list.length - 2} more` : ''}`;
}
