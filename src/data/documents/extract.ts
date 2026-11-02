import * as cheerio from 'cheerio';
import { extractText, getDocumentProxy } from 'unpdf';

import type { ExtractionOutcome, Segment } from '@/db/repositories';

export const PDF_EXTRACTOR_VERSION = 'unpdf-pages.v2';
export const HTML_EXTRACTOR_VERSION = 'cheerio-sections.v1';

/** Below this many characters per page on average, the PDF is treated as scanned (no text layer). */
const MIN_AVG_CHARS_PER_PAGE = 40;
/** A page with fewer characters than this counts as empty (cover image, chart). */
const MIN_PAGE_CHARS = 20;

const normalize = (s: string) =>
  s
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

/**
 * Text per page, preserving page numbers. A scanned or image-only PDF is
 * reported as `no_text_layer`; FINN does not OCR and never treats it as an
 * empty document.
 */
export async function extractPdf(bytes: Uint8Array): Promise<ExtractionOutcome> {
  let pages: string[];
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const result = await extractText(pdf, { mergePages: false });
    pages = Array.isArray(result.text) ? result.text : [result.text];
  } catch (e) {
    const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    const encrypted = /password/i.test(message);
    return { status: 'failed', error: encrypted ? `PDF is password-protected (${message})` : `PDF could not be parsed (${message})`, pageCount: null, extractorVersion: PDF_EXTRACTOR_VERSION };
  }

  const cleaned = pages.map(normalize);
  const pageCount = cleaned.length;
  const totalChars = cleaned.reduce((n, p) => n + p.length, 0);
  if (pageCount === 0 || totalChars / pageCount < MIN_AVG_CHARS_PER_PAGE) {
    return {
      status: 'no_text_layer',
      error: `No extractable text layer (${totalChars} characters over ${pageCount} pages). The document is likely scanned; OCR is not supported.`,
      pageCount,
      extractorVersion: PDF_EXTRACTOR_VERSION,
    };
  }

  const segments: Segment[] = [];
  const emptyPages: number[] = [];
  cleaned.forEach((text, i) => {
    if (text.length < MIN_PAGE_CHARS) emptyPages.push(i + 1);
    else segments.push({ pageNumber: i + 1, sectionHeading: null, locationLabel: `p. ${i + 1}`, text });
  });

  const emptyShare = emptyPages.length / pageCount;
  const note = emptyPages.length ? `${emptyPages.length} of ${pageCount} pages had no extractable text (pages ${summarizePages(emptyPages)}).` : undefined;
  return { status: emptyShare > 0.25 ? 'partial' : 'extracted', segments, pageCount, extractorVersion: PDF_EXTRACTOR_VERSION, note };
}

function summarizePages(pages: number[]): string {
  const shown = pages.slice(0, 12).join(', ');
  return pages.length > 12 ? `${shown}, …` : shown;
}

/**
 * HTML transcripts: text grouped under the nearest preceding heading, so a
 * citation can say "§ Q&A session" when there are no page numbers.
 * Scripts, styles and navigation are dropped; nothing is rendered as HTML.
 */
export function extractHtml(html: string): ExtractionOutcome {
  const $ = cheerio.load(html);
  $('script, style, noscript, nav, header, footer, form, iframe, svg').remove();

  const segments: Segment[] = [];
  let heading = 'Document body';
  let buffer: string[] = [];
  const flush = () => {
    const text = normalize(buffer.join('\n'));
    if (text.length > 0) segments.push({ pageNumber: null, sectionHeading: heading, locationLabel: `§ ${heading}`, text });
    buffer = [];
  };

  $('body')
    .find('h1, h2, h3, h4, p, li, td, th, pre, blockquote')
    .each((_, el) => {
      const node = $(el);
      const tag = el.tagName.toLowerCase();
      if (/^h[1-4]$/.test(tag)) {
        flush();
        heading = normalize(node.text()).slice(0, 200) || heading;
        return;
      }
      // Skip containers whose text is captured by a nested block element.
      if (node.find('p, li, td, th, pre, blockquote').length > 0) return;
      const text = normalize(node.text());
      if (text) buffer.push(text);
    });
  flush();

  if (segments.length === 0) {
    return { status: 'failed', error: 'HTML contained no readable text', pageCount: null, extractorVersion: HTML_EXTRACTOR_VERSION };
  }
  return { status: 'extracted', segments, pageCount: null, extractorVersion: HTML_EXTRACTOR_VERSION };
}
