// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { fakeHttp, yahooChart } from '@/test/helpers';

import { parseScreenerCompanyPage } from './filings/screener';
import { httpGet, USER_AGENT } from './http';
import { parseYahooChart, YahooChartAdapter } from './prices/yahoo';

const AFTER_CLOSE = new Date('2026-10-30T12:00:00Z'); // 17:30 IST Friday

describe('httpGet', () => {
  it('identifies itself truthfully', async () => {
    const http = fakeHttp({ 'example.test': { body: '{}' } });
    await httpGet('https://example.test/x', {}, http);
    expect(http.calls[0]?.headers['User-Agent']).toBe(USER_AGENT);
  });

  it('retries transient failures, then succeeds', async () => {
    const http = fakeHttp({ 'example.test': [{ status: 503, body: '' }, new Error('ECONNRESET'), { body: 'ok' }] });
    const r = await httpGet('https://example.test/x', { retries: 2 }, http);
    expect(r.ok && r.value.body.toString()).toBe('ok');
    expect(http.calls).toHaveLength(3);
  });

  it('does not retry a client error', async () => {
    const http = fakeHttp({ 'example.test': { status: 403, body: '' } });
    const r = await httpGet('https://example.test/x', { retries: 2 }, http);
    expect(r).toEqual({ ok: false, error: { kind: 'status', status: 403 } });
    expect(http.calls).toHaveLength(1);
  });

  it('enforces the size cap', async () => {
    const http = fakeHttp({ 'example.test': { body: Buffer.alloc(2048) } });
    const r = await httpGet('https://example.test/x', { maxBytes: 1024 }, http);
    expect(r).toEqual({ ok: false, error: { kind: 'too_large', limit: 1024 } });
  });
});

describe('parseYahooChart', () => {
  const good = { o: 100, h: 105, l: 99, c: 104, v: 1000 };

  it('parses completed sessions into dated bars', () => {
    const r = parseYahooChart(yahooChart('X.NS', [{ date: '2026-10-29', ...good }, { date: '2026-10-30', ...good }]), 'X.NS', AFTER_CLOSE, 200);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.bars.map((b) => b.tradeDate)).toEqual(['2026-10-29', '2026-10-30']);
  });

  it('rejects rows with missing values instead of zero-filling them', () => {
    const r = parseYahooChart(yahooChart('X.NS', [{ date: '2026-10-29', ...good, c: null }, { date: '2026-10-30', ...good }]), 'X.NS', AFTER_CLOSE, 200);
    expect(r.status).toBe('partial');
    if (r.status === 'partial') {
      expect(r.bars).toHaveLength(1);
      expect(r.rejected[0]).toMatchObject({ tradeDate: '2026-10-29', reason: 'missing_field' });
    }
  });

  it('drops the in-progress bar during market hours', () => {
    const duringSession = new Date('2026-10-30T06:00:00Z'); // 11:30 IST
    const r = parseYahooChart(yahooChart('X.NS', [{ date: '2026-10-29', ...good }, { date: '2026-10-30', ...good }]), 'X.NS', duringSession, 200);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.bars.map((b) => b.tradeDate)).toEqual(['2026-10-29']);
  });

  it('keeps one bar per date when the provider repeats a day', () => {
    const r = parseYahooChart(yahooChart('X.NS', [{ date: '2026-10-30', ...good }, { date: '2026-10-30', ...good, c: 103 }]), 'X.NS', AFTER_CLOSE, 200);
    expect(r.status === 'partial' && r.bars).toEqual([expect.objectContaining({ tradeDate: '2026-10-30', close: 103 })]);
  });

  it.each([
    ['missing indicators', { chart: { result: [{ meta: { symbol: 'X.NS' } }], error: null } }],
    ['not an object', 'oops'],
    ['mismatched series lengths', (() => {
      const c = yahooChart('X.NS', [{ date: '2026-10-30', ...good }]);
      c.chart.result[0]?.indicators.quote[0]?.close.push(1);
      return c;
    })()],
  ])('rejects a malformed payload (%s)', (_, json) => {
    expect(parseYahooChart(json, 'X.NS', AFTER_CLOSE, 200).status).toBe('invalid_payload');
  });

  it('treats a chart error as an unresolved symbol', () => {
    const r = parseYahooChart({ chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } }, 'NOPE.NS', AFTER_CLOSE, 404);
    expect(r).toMatchObject({ status: 'unavailable', reason: 'unresolved_symbol' });
  });

  it('refuses data for a different symbol or currency (a bad mapping, not data)', () => {
    expect(parseYahooChart(yahooChart('OTHER.NS', [{ date: '2026-10-30', ...good }]), 'X.NS', AFTER_CLOSE, 200).status).toBe('invalid_payload');
    expect(parseYahooChart(yahooChart('X.NS', [{ date: '2026-10-30', ...good }], 'USD'), 'X.NS', AFTER_CLOSE, 200).status).toBe('invalid_payload');
  });
});

describe('YahooChartAdapter', () => {
  it('reports an HTML error page as an invalid payload', async () => {
    const http = fakeHttp({ 'finance.yahoo.com': { body: '<html>blocked</html>', contentType: 'text/html' } });
    const r = await new YahooChartAdapter('1y', http).fetchDaily('X.NS', AFTER_CLOSE);
    expect(r).toMatchObject({ status: 'invalid_payload', message: 'response is not JSON' });
  });

  it('reports network failure as unavailable, with no bars', async () => {
    const http = fakeHttp({ 'finance.yahoo.com': new Error('getaddrinfo ENOTFOUND') });
    const r = await new YahooChartAdapter('1y', http).fetchDaily('X.NS', AFTER_CLOSE);
    expect(r).toMatchObject({ status: 'unavailable', reason: 'http_error' });
  });

  it('URL-encodes symbols containing &', async () => {
    const http = fakeHttp({});
    await new YahooChartAdapter('1y', http).fetchDaily('M&M.NS', AFTER_CLOSE);
    expect(http.calls[0]?.url).toContain('/chart/M%26M.NS?');
  });
});

const SCREENER_PAGE = `<!doctype html><html><body>
<div id="documents">
  <div class="documents"><h3>Announcements</h3>
    <div id="company-announcements-tab"><ul class="list-links">
      <li><a href="https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=880087f6-7ecc-40a9-8cac-de48d4616b25.pdf">
        Unaudited Financial Results For The Quarter Ended September 30, 2026.
        <div class="ink-600 smaller"><time datetime="2026-10-30T19:42:49+05:30">30 Oct</time> - Aggregator summary that must be ignored.</div></a></li>
      <li><a href="https://example.com/news/story">News item <div><time datetime="2026-10-30T10:00:00+05:30">30 Oct</time></div></a></li>
      <li><a href="https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=0dc8ebe7-5e2d-4946-85ee-1e536c461a71.pdf">No time here</a></li>
    </ul></div>
  </div>
  <div class="documents annual-reports"><h3>Annual reports</h3><ul class="list-links">
    <li><a href="https://www.bseindia.com/xml-data/corpfiling/AttachHis/cc08294f-ec68-4f15-aaa4-c14a3c4bdfb2.pdf">Annual Report 2026</a></li>
  </ul></div>
  <div class="documents credit-ratings"><h3>Credit ratings</h3><ul class="list-links">
    <li><a href="https://www.icra.in/Rationale/ShowRationaleReport/?Id=1">Rating update <div>21 Oct from icra</div></a></li>
  </ul></div>
  <div class="documents concalls"><h3>Concalls</h3><ul class="list-links">
    <li><div>Jul 2026</div><a class="button-chip" href="https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=c9d3d96a-8b04-4b41-b454-3f98d1f90702.pdf">Transcript</a>
      <button>AI Summary</button><a href="https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=01d1656c-cf53-4d52-94c3-7ed0edd50271.pdf">PPT</a></li>
    <li><div>Oct 2026</div><div class="button-chip">Transcript</div></li>
  </ul></div>
</div></body></html>`;

describe('parseScreenerCompanyPage', () => {
  const page = parseScreenerCompanyPage(SCREENER_PAGE, 'https://www.screener.in/company/X/consolidated/');

  it('keeps the filed title, exchange link and time; drops the aggregator summary', () => {
    expect(page.announcements).toEqual([
      {
        exchange: 'BSE',
        exchangeRef: '880087f6-7ecc-40a9-8cac-de48d4616b25',
        title: 'Unaudited Financial Results For The Quarter Ended September 30, 2026.',
        publishedAt: '2026-10-30T14:12:49.000Z',
        publishedAtRaw: '2026-10-30T19:42:49+05:30',
        url: 'https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=880087f6-7ecc-40a9-8cac-de48d4616b25.pdf',
      },
    ]);
    expect(JSON.stringify(page)).not.toContain('Aggregator summary');
  });

  it('skips non-exchange links and entries without a timestamp, with warnings', () => {
    expect(page.warnings).toEqual(expect.arrayContaining([expect.stringContaining('non-exchange'), expect.stringContaining('missing timestamp')]));
  });

  it('discovers annual reports, transcripts and presentations; a transcript with no link is not invented', () => {
    expect(page.documents.map((d) => [d.kind, d.periodLabel])).toEqual([
      ['annual_report', 'FY26'],
      ['earnings_call_transcript', 'Jul 2026'],
      ['investor_presentation', 'Jul 2026'],
      ['other', null],
    ]);
  });

  it('warns rather than returning an empty success when the layout changes', () => {
    expect(parseScreenerCompanyPage('<html><body>Nothing</body></html>', 'https://www.screener.in/').warnings[0]).toMatch(/documents section not found/);
  });
});
