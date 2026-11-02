import type { Segment } from '@/db/repositories';

/**
 * Splits extracted document segments into retrieval chunks.
 * - Chunks never cross a page (PDF) or section (HTML), so every citation
 *   resolves to one exact location.
 * - Boundaries follow structure first: headings start a chunk; runs of
 *   numeric table rows are kept together and apart from prose.
 * - Size limits apply only after structure: small neighbours merge, long
 *   prose splits at sentence boundaries.
 */

export const CHUNKER_VERSION = 'structural.v2';

const TARGET_CHARS = 1_400;
const MAX_CHARS = 2_600;
const CAPTION_CHARS = 80;

export type ChunkKind = 'prose' | 'table' | 'mixed';

export type ChunkDraft = {
  pageStart: number | null;
  pageEnd: number | null;
  sectionHeading: string | null;
  locationLabel: string;
  kind: ChunkKind;
  text: string;
};

type LineKind = 'heading' | 'table' | 'prose';

const NUMBER_TOKEN = /\(?-?\d[\d,]*(?:\.\d+)?\)?/g;

export function classifyLine(line: string): LineKind {
  const t = line.trim();
  const numbers = t.match(NUMBER_TOKEN) ?? [];
  const digits = (t.match(/\d/g) ?? []).length;
  if (numbers.length >= 2 && digits / Math.max(t.length, 1) > 0.25) return 'table';
  if (t.length > 0 && t.length <= 90 && !/[.:;,]$/.test(t)) {
    const letters = t.replace(/[^A-Za-z]/g, '');
    const upper = t.replace(/[^A-Z]/g, '');
    const numbered = /^((\d+(\.\d+)*)|[IVX]+|[A-Z])[.)]\s+[A-Z]/.test(t);
    if ((letters.length >= 4 && upper.length / letters.length > 0.7) || numbered) return 'heading';
  }
  return 'prose';
}

type Block = { kind: 'table' | 'prose'; heading: string | null; lines: string[] };

function blocksOf(text: string, initialHeading: string | null): Block[] {
  const blocks: Block[] = [];
  let heading = initialHeading;
  let current: Block | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const kind = classifyLine(line);
    if (kind === 'heading') {
      heading = line.slice(0, 160);
      current = null;
      continue;
    }
    if (!current || current.kind !== kind) {
      current = { kind, heading, lines: [] };
      blocks.push(current);
    }
    current.lines.push(line);
  }
  return blocks;
}

function splitLongProse(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];
  const sentences = text.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) ?? [text];
  const out: string[] = [];
  let buf = '';
  for (const s of sentences) {
    if (buf.length + s.length > TARGET_CHARS && buf.length > 0) {
      out.push(buf.trim());
      buf = '';
    }
    // A single sentence longer than MAX is hard-wrapped; rare in filings.
    if (s.length > MAX_CHARS) {
      for (let i = 0; i < s.length; i += MAX_CHARS) out.push(s.slice(i, i + MAX_CHARS).trim());
      continue;
    }
    buf += s;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

export function chunkSegments(segments: Segment[]): ChunkDraft[] {
  const chunks: ChunkDraft[] = [];
  for (const seg of segments) {
    const location = seg.pageNumber !== null ? `p. ${seg.pageNumber}` : seg.locationLabel;
    const pending: { kind: ChunkKind; heading: string | null; text: string }[] = [];

    for (const block of blocksOf(seg.text, seg.sectionHeading)) {
      // Tables keep line structure (rows); prose is reflowed.
      const text = block.kind === 'table' ? block.lines.join('\n') : block.lines.join(' ').replace(/\s+/g, ' ');
      const parts = block.kind === 'prose' ? splitLongProse(text) : [text];
      for (const part of parts) {
        const last = pending[pending.length - 1];
        const sameHeading = last && last.heading === block.heading;
        // Tables never merge into prose (figures stay retrievable on their own); only a short
        // caption-like prose fragment may join a neighbouring block.
        const tinyCaption = (last && last.kind === 'prose' && last.text.length < CAPTION_CHARS) || (block.kind === 'prose' && part.length < CAPTION_CHARS);
        const canMerge = last && sameHeading && last.text.length + part.length <= TARGET_CHARS && (last.kind === block.kind || tinyCaption);
        if (last && canMerge) {
          last.text = `${last.text}\n${part}`;
          if (last.kind !== block.kind) last.kind = 'mixed';
        } else {
          pending.push({ kind: block.kind, heading: block.heading, text: part });
        }
      }
    }
    for (const p of pending) {
      if (p.text.trim().length === 0) continue;
      chunks.push({ pageStart: seg.pageNumber, pageEnd: seg.pageNumber, sectionHeading: p.heading, locationLabel: location, kind: p.kind, text: p.text });
    }
  }
  return chunks;
}
