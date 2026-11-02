// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { Db } from '@/db/connection';
import { insertAnnouncement, recordVersion, registerDocument, saveClassification, saveExtraction, setDocumentAvailability, startFetch } from '@/db/repositories';
import { classifyAnnouncement } from '@/domain/taxonomy';
import { ingestPeopleChanges } from '@/ingest/people';
import { UnconfiguredLlmClient, type LlmClient, type LlmRequest, type LlmResult } from '@/llm/client';
import { seededDb, T0 } from '@/test/helpers';

import { namedAt, quoteNames, readPeople, relevantPages, verifyPeople, type PageText } from './people';
import { getDigest } from './service';

const LETTER: PageText = {
  pageNumber: 1,
  text: `Sub: Change in Directors - Outcome of the Board Meeting
1. Retirement of Mr. Noel N. Tata as the Chairman
Mr. Noel N. Tata (DIN: 00024713) will retire from the office of Chairman and Director of the Company with effect from the close of business hours on 11th November 2026.
2. Appointment of Ms. Kalpana Merchant as an Independent Director
The Board has approved the appointment of Ms. Kalpana Merchant (DIN: 00827907) as an Additional Director. Further, the Board has also approved her appointment as an Independent Director of the Company for a term of three years.
3. Appointment of Mr. Rajiv Dube as an Additional Director (Non-
Executive, Non- Independent)`,
};
const PROFILE: PageText = {
  pageNumber: 2,
  text: `Brief profile
Ms. Kalpana Merchant has over 45 years of experience in the legal profession. She has been a partner at Kanga & Co. and AZB & Partners.`,
};
const RESULTS_ONLY: PageText = { pageNumber: 3, text: 'Revenue from Operations 1,240 1,180 1,050' };

type Draft = Parameters<typeof verifyPeople>[0][number];
const draft = (over: Partial<Draft>): Draft => ({ name: 'Kalpana Merchant', role: 'Independent Director', change: 'appointed', effective: null, page: 1, quote: 'The Board has approved the appointment of Ms. Kalpana Merchant (DIN: 00827907) as an Additional Director.', background: [], ...over });

/** Scripted model: returns a fixed output and counts calls. */
class ScriptedLlm implements LlmClient {
  readonly configured = true;
  calls = 0;
  constructor(private readonly output: unknown) {}
  describe() {
    return 'scripted';
  }
  async run<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    this.calls += 1;
    const parsed = req.schema.safeParse(this.output);
    return parsed.success ? { status: 'ok', output: parsed.data, model: 'scripted', cached: false } : { status: 'failed', reason: 'invalid_output', message: 'bad', model: 'scripted' };
  }
}

describe('reading who changes from a filing', () => {
  it('keeps a person only when the quote is in the filing and names them', () => {
    const pages = [LETTER, PROFILE];
    expect(verifyPeople([draft({})], pages).people).toHaveLength(1);
    // A quote the filing does not contain, or one that names someone else, is dropped.
    expect(verifyPeople([draft({ quote: 'The Board appointed Ms. Kalpana Merchant as Managing Director of the Company.' })], pages)).toMatchObject({ people: [], rejected: 1 });
    expect(verifyPeople([draft({ name: 'Anita Rao' })], pages)).toMatchObject({ people: [], rejected: 1 });
  });

  it('accepts "her appointment" when the name is just before the quote, and finds the right page', () => {
    const quote = 'Further, the Board has also approved her appointment as an Independent Director of the Company for a term of three years.';
    expect(quoteNames(quote, 'Kalpana Merchant')).toBe(false);
    expect(namedAt(quote, 'Kalpana Merchant', LETTER.text)).toBe(true);
    const { people } = verifyPeople([draft({ quote, page: 2 })], [LETTER, PROFILE]);
    expect(people[0]?.page).toBe(1);
  });

  it('tolerates typographic quotes and a line break after a hyphen, not changed wording', () => {
    const quote = 'appointment of Mr. Rajiv Dube as an Additional Director (Non-Executive, Non-Independent)';
    expect(verifyPeople([draft({ name: 'Rajiv Dube', quote })], [LETTER]).people).toHaveLength(1);
    expect(verifyPeople([draft({ name: 'Rajiv Dube', quote: quote.replace('Additional', 'Independent') })], [LETTER]).people).toHaveLength(0);
  });

  it('keeps background only when quoted verbatim and every figure appears in the quote', () => {
    const background = [
      { text: 'Over 45 years in the legal profession.', page: 2, quote: 'Ms. Kalpana Merchant has over 45 years of experience in the legal profession.' },
      { text: 'Over 50 years in the legal profession.', page: 2, quote: 'Ms. Kalpana Merchant has over 45 years of experience in the legal profession.' },
      { text: 'Former judge of the High Court.', page: 2, quote: 'She served as a judge of the High Court for a decade.' },
    ];
    const { people, rejected } = verifyPeople([draft({ background })], [LETTER, PROFILE]);
    expect(people[0]?.background.map((b) => b.text)).toEqual(['Over 45 years in the legal profession.']);
    expect(rejected).toBe(2);
  });

  it('merges the same person announced twice, and skips pages that cannot name anyone', () => {
    const twice = [draft({}), draft({ quote: 'Further, the Board has also approved her appointment as an Independent Director of the Company for a term of three years.' })];
    expect(verifyPeople(twice, [LETTER]).people).toHaveLength(1);
    expect(relevantPages([RESULTS_ONLY, LETTER]).map((p) => p.pageNumber)).toEqual([1]);
  });

  it('never invents people: no model, a failed model, or nothing relevant gives none', async () => {
    expect(await readPeople(new UnconfiguredLlmClient(), [LETTER])).toMatchObject({ status: 'model_unavailable', people: [] });
    expect(await readPeople(new ScriptedLlm({ wrong: true }), [LETTER])).toMatchObject({ status: 'model_failed', people: [] });
    const llm = new ScriptedLlm({ people: [] });
    expect(await readPeople(llm, [RESULTS_ONLY])).toMatchObject({ status: 'none', people: [] });
    expect(llm.calls).toBe(0);
  });
});

function seedFiling(db: Db, pages: PageText[]) {
  const url = 'https://www.bseindia.com/mc1.pdf';
  const fetchId = startFetch(db, { provider: 'test', dataMode: 'live', requestKey: 'k', now: T0 });
  const title = 'Announcement under Regulation 30 (LODR)-Change in Directorate';
  const ann = insertAnnouncement(
    db,
    { companyId: 'nse:specimen', exchange: 'BSE', exchangeRef: null, title, publishedAt: '2026-10-30T12:00:00.000Z', publishedAtRaw: '30 Oct', sourceUrl: 'https://www.screener.in/company/SPECIMEN/', documentUrl: url },
    { provider: 'test', fetchId, now: T0 },
  );
  saveClassification(db, ann.id, classifyAnnouncement(title), T0);
  const doc = registerDocument(db, { companyId: 'nse:specimen', kind: 'announcement_attachment', title, periodLabel: null, publishedAt: '2026-10-30T12:00:00.000Z', sourceUrl: url, discoveredVia: 'screener:announcement', origin: 'exchange_filed' }, T0);
  const v = recordVersion(db, { documentId: doc.id, sha256: doc.id.padEnd(64, '0').slice(0, 64), byteSize: 100, mimeType: 'application/pdf', finalUrl: url, blobPath: 'x', fetchedAt: T0 });
  saveExtraction(db, v.versionId, { status: 'extracted', segments: pages.map((p) => ({ pageNumber: p.pageNumber, sectionHeading: null, locationLabel: `p. ${p.pageNumber}`, text: p.text })), pageCount: pages.length, extractorVersion: 'test' });
  setDocumentAvailability(db, doc.id, 'fetched', null, T0);
}

describe('management-change signals', () => {
  const run = (db: Db, llm: LlmClient) =>
    ingestPeopleChanges(db, { since: '2026-09-01T00:00:00.000Z', companyIds: new Set(['nse:specimen']), blobDir: '.', now: () => new Date(T0), llm, limit: 10, pauseMs: 0, sleep: async () => undefined });

  it('puts verified people on the signal, reads each filing once, and retries when the model was unavailable', async () => {
    const db = seededDb();
    seedFiling(db, [LETTER, PROFILE]);

    expect((await run(db, new UnconfiguredLlmClient()))[0]?.outcome).toBe('model_unavailable');

    const llm = new ScriptedLlm({
      people: [
        draft({ background: [{ text: 'Over 45 years in the legal profession.', page: 2, quote: 'Ms. Kalpana Merchant has over 45 years of experience in the legal profession.' }] }),
        draft({ name: 'Imaginary Person', quote: 'The Board appointed Mr. Imaginary Person as Chief Executive Officer.' }),
      ],
    });
    expect((await run(db, llm))[0]).toMatchObject({ outcome: 'ok', people: 1 });
    expect((await run(db, llm))[0]?.outcome).toBe('already_read');
    expect(llm.calls).toBe(1);

    const digest = getDigest(db, { window: '7d', now: new Date('2026-11-01T10:00:00.000Z'), dataMode: 'live' });
    if (!digest.ok) throw new Error('digest failed');
    const signal = digest.value.groups.flatMap((g) => g.items).map((i) => i.signal).find((s) => s.category === 'management_change');
    expect(signal?.people?.map((p) => p.name)).toEqual(['Kalpana Merchant']);
    expect(signal?.people?.[0]?.background[0]?.page).toBe(2);
  });
});
