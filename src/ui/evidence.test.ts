import { describe, expect, it } from 'vitest';

import { highlightQuote, safeDocumentUrl } from './evidence';

describe('highlightQuote', () => {
  const passage = 'For the full year we continue to\n  expect EBITDA margins in the range of 19 to 20 percent.';

  it('finds a quote across line breaks and case differences', () => {
    const result = highlightQuote(passage, 'Expect EBITDA margins in the range');
    expect(result).toEqual({
      found: true,
      before: 'For the full year we continue to ',
      match: 'expect EBITDA margins in the range',
      after: ' of 19 to 20 percent.',
    });
  });

  it('reports a fabricated quote as not found', () => {
    const result = highlightQuote(passage, 'margins will expand by 300 basis points');
    expect(result.found).toBe(false);
  });

  it('returns the collapsed passage when there is no quote', () => {
    expect(highlightQuote(passage, undefined)).toEqual({
      found: false,
      text: 'For the full year we continue to expect EBITDA margins in the range of 19 to 20 percent.',
    });
    expect(highlightQuote(passage, '   ').found).toBe(false);
  });
});

describe('safeDocumentUrl', () => {
  it('accepts https and adds a page fragment', () => {
    expect(safeDocumentUrl('https://www.bseindia.com/xml-data/corpfiling/AttachLive/a.pdf', 3)).toBe(
      'https://www.bseindia.com/xml-data/corpfiling/AttachLive/a.pdf#page=3',
    );
  });

  it.each(['javascript:alert(1)', 'data:text/html,hi', 'http://example.com/a.pdf', '/relative.pdf', 'not a url', ''])(
    'refuses %s',
    (raw) => {
      expect(safeDocumentUrl(raw)).toBeNull();
    },
  );

  it('ignores invalid page numbers', () => {
    expect(safeDocumentUrl('https://example.com/a.pdf', 0)).toBe('https://example.com/a.pdf');
    expect(safeDocumentUrl('https://example.com/a.pdf', 1.5)).toBe('https://example.com/a.pdf');
  });
});
