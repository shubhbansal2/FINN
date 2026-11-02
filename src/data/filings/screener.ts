import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { bseAttachmentRef } from '@/domain/announcements';

import { defaultHttpDeps, describeHttpError, httpGet, type HttpDeps } from '../http';
import type { DiscoveredDocument, FilingsAdapter, FilingsResult, FilingsTarget, ListedAnnouncement } from './types';

/**
 * screener.in company page, used for DISCOVERY ONLY.
 *
 * What FINN takes: the filed announcement subject, its timestamp, and the
 * link to the exchange-hosted filing; links to annual reports, concall
 * transcripts and presentations.
 * What FINN ignores: screener's own one-line announcement summaries and "AI
 * Summary" content. Those are secondary commentary, and on 2026-11-01 one of
 * them contradicted its own filing (Q2 FY27 described as "Q2 FY26").
 *
 * Verified 2026-11-01 with a truthful User-Agent; robots.txt allows
 * /company/<symbol>/ pages. Limitation: the page lists only the most recent
 * handful of announcements, so a long gap between polls can miss filings.
 */

const EXCHANGE_HOSTS: Record<string, 'BSE' | 'NSE'> = {
  'www.bseindia.com': 'BSE',
  'bseindia.com': 'BSE',
  'www.nseindia.com': 'NSE',
  'nseindia.com': 'NSE',
  'archives.nseindia.com': 'NSE',
  'nsearchives.nseindia.com': 'NSE',
};

function exchangeOf(url: string): 'BSE' | 'NSE' | null {
  try {
    return EXCHANGE_HOSTS[new URL(url).hostname] ?? null;
  } catch {
    // Unparseable URL: not an exchange link.
    return null;
  }
}

function absolute(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    // Malformed href in the page: skip it.
    return null;
  }
}

/** NSE archive filenames identify a filing; BSE uses a GUID. */
function exchangeRefFor(url: string, exchange: 'BSE' | 'NSE'): string | null {
  if (exchange === 'BSE') return bseAttachmentRef(url);
  const m = /\/([^/?#]+\.(pdf|zip|xml))(?:$|[?#])/i.exec(url);
  return m?.[1] ?? null;
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Pure parser over the page HTML. Exported for tests. */
export function parseScreenerCompanyPage(html: string, pageUrl: string): { announcements: ListedAnnouncement[]; documents: DiscoveredDocument[]; warnings: string[] } {
  const $ = cheerio.load(html);
  const warnings: string[] = [];
  const docsRoot = $('#documents');
  if (docsRoot.length === 0) {
    return { announcements: [], documents: [], warnings: ['documents section not found; page layout may have changed'] };
  }

  const announcements: ListedAnnouncement[] = [];
  docsRoot.find('#company-announcements-tab ul.list-links > li > a').each((_, el) => {
    const a = $(el);
    const href = absolute(a.attr('href') ?? '', pageUrl);
    const datetime = a.find('time').attr('datetime');
    // The anchor's own text, without the nested summary block (screener's commentary).
    const title = clean(a.clone().children('div').remove().end().text());
    if (!href || !title || !datetime) {
      warnings.push(`skipped announcement with missing ${!href ? 'link' : !title ? 'title' : 'timestamp'}`);
      return;
    }
    const published = new Date(datetime);
    if (Number.isNaN(published.getTime())) {
      warnings.push(`skipped announcement with unparseable time "${datetime}"`);
      return;
    }
    const exchange = exchangeOf(href);
    if (!exchange) {
      warnings.push(`skipped non-exchange announcement link ${new URL(href).hostname}`);
      return;
    }
    announcements.push({ exchange, exchangeRef: exchangeRefFor(href, exchange), title, publishedAt: published.toISOString(), publishedAtRaw: datetime, url: href });
  });

  const documents: DiscoveredDocument[] = [];
  docsRoot.find('.annual-reports ul.list-links > li > a').each((_, el) => {
    const a = $(el);
    const href = absolute(a.attr('href') ?? '', pageUrl);
    const title = clean(a.text());
    if (!href || !title) return;
    const year = /\b(19|20)\d{2}\b/.exec(title)?.[0] ?? null;
    documents.push({ kind: 'annual_report', title, periodLabel: year ? `FY${year.slice(2)}` : null, publishedAt: null, url: href });
  });

  docsRoot.find('.concalls ul.list-links > li').each((_, el) => {
    const li = $(el);
    const month = clean(li.children('div').first().text());
    li.find('a').each((__, link) => {
      const a = $(link);
      const label = clean(a.text()).toLowerCase();
      const href = absolute(a.attr('href') ?? '', pageUrl);
      if (!href) return;
      if (label === 'transcript') {
        documents.push({ kind: 'earnings_call_transcript', title: `Earnings call transcript, ${month}`, periodLabel: month || null, publishedAt: null, url: href });
      } else if (label === 'ppt') {
        documents.push({ kind: 'investor_presentation', title: `Investor presentation, ${month}`, periodLabel: month || null, publishedAt: null, url: href });
      }
      // 'rec' (audio) and AI summaries are not text evidence.
    });
  });

  // Credit-rating rationales are third-party documents: recorded so the UI can
  // link them, never used as evidence for analysis.
  docsRoot.find('h3').each((_, h) => {
    if (clean($(h).text()).toLowerCase() !== 'credit ratings') return;
    $(h)
      .parent()
      .find('ul.list-links > li > a')
      .each((__, el) => {
        const href = absolute($(el).attr('href') ?? '', pageUrl);
        if (href) documents.push({ kind: 'other', title: `Credit rating rationale (${clean($(el).find('div').text())})`, periodLabel: null, publishedAt: null, url: href });
      });
  });

  if (announcements.length === 0) warnings.push('no announcements listed on page');
  return { announcements, documents, warnings };
}

export function screenerUrls(target: FilingsTarget): string[] {
  const id = target.nseSymbol ?? target.bseCode;
  if (!id) return [];
  const slug = encodeURIComponent(id);
  return [`https://www.screener.in/company/${slug}/consolidated/`, `https://www.screener.in/company/${slug}/`];
}

export class ScreenerFilingsAdapter implements FilingsAdapter {
  readonly provider = 'screener';
  readonly dataMode = 'live' as const;

  constructor(private readonly deps: HttpDeps = defaultHttpDeps) {}

  async fetchCompany(target: FilingsTarget, now: Date): Promise<FilingsResult> {
    const fetchedAt = now.toISOString();
    for (const url of screenerUrls(target)) {
      const res = await httpGet(url, { accept: 'text/html', passStatuses: [404], maxBytes: 4 * 1024 * 1024 }, this.deps);
      if (!res.ok) return { status: 'unavailable', reason: 'http_error', message: describeHttpError(res.error), httpStatus: res.error.kind === 'status' ? res.error.status : null, fetchedAt };
      if (res.value.status === 404) continue;
      if (!res.value.contentType.includes('text/html')) {
        return { status: 'invalid_payload', message: `expected HTML, got ${res.value.contentType}`, httpStatus: res.value.status, fetchedAt };
      }
      const parsed = parseScreenerCompanyPage(res.value.body.toString('utf8'), res.value.finalUrl);
      if (parsed.warnings.some((w) => w.startsWith('documents section not found'))) {
        return { status: 'invalid_payload', message: parsed.warnings.join('; '), httpStatus: res.value.status, fetchedAt };
      }
      return { status: parsed.warnings.length ? 'partial' : 'ok', pageUrl: res.value.finalUrl, fetchedAt, ...parsed };
    }
    return { status: 'unavailable', reason: 'not_found', message: 'company page not found', httpStatus: 404, fetchedAt };
  }
}

/** Recorded filings for offline demos. File: <dir>/<companyId>.json; labelled demo data. */
const RecordedFilingsSchema = z.object({
  capturedAt: z.string().datetime(),
  source: z.literal('screener'),
  pageUrl: z.string().url(),
  announcements: z.array(
    z.object({
      exchange: z.enum(['BSE', 'NSE']),
      exchangeRef: z.string().nullable(),
      title: z.string().min(1),
      publishedAt: z.string().datetime(),
      publishedAtRaw: z.string(),
      url: z.string().url(),
    }),
  ),
  documents: z.array(
    z.object({
      kind: z.enum(['annual_report', 'quarterly_results', 'investor_presentation', 'earnings_call_transcript', 'announcement_attachment', 'other']),
      title: z.string(),
      periodLabel: z.string().nullable(),
      publishedAt: z.string().nullable(),
      url: z.string().url(),
    }),
  ),
});

export type RecordedFilings = z.infer<typeof RecordedFilingsSchema>;

export function fixtureFileName(companyId: string): string {
  return `${companyId.replace(/[^a-z0-9]+/gi, '_')}.json`;
}

export class FixtureFilingsAdapter implements FilingsAdapter {
  readonly provider = 'fixture:screener';
  readonly dataMode = 'fixture' as const;

  constructor(private readonly dir: string) {}

  async fetchCompany(target: FilingsTarget): Promise<FilingsResult> {
    const file = path.join(this.dir, fixtureFileName(target.companyId));
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      // No recording: the feed stays empty for this company rather than being invented.
      return { status: 'unavailable', reason: 'no_fixture', message: `no recorded filings at ${path.basename(file)}`, httpStatus: null, fetchedAt: new Date(0).toISOString() };
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return { status: 'invalid_payload', message: 'fixture file is not JSON', httpStatus: null, fetchedAt: new Date(0).toISOString() };
    }
    const rec = RecordedFilingsSchema.safeParse(json);
    if (!rec.success) return { status: 'invalid_payload', message: 'fixture file is malformed', httpStatus: null, fetchedAt: new Date(0).toISOString() };
    return { status: 'ok', pageUrl: rec.data.pageUrl, fetchedAt: rec.data.capturedAt, announcements: rec.data.announcements, documents: rec.data.documents, warnings: [] };
  }
}
