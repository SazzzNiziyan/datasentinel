import { z } from 'zod';

/** Pipeline documentation DataSentinel can read (D-103). Only plain text and
 * Markdown: both are read as text and never rendered or executed. PDF, Word,
 * and HTML are not supported on purpose: extracting them means running a
 * complex parser on untrusted files. */
export const documentFormats = ['text', 'markdown'] as const;
export type DocumentFormat = (typeof documentFormats)[number];

export const DOCUMENT_LIMITS = {
  /** Characters of text in one document. */
  maxChars: 200_000,
  /** Characters in one stored chunk. */
  maxChunkChars: 1_200,
  maxChunks: 400,
  nameMax: 120,
  sectionTitleMax: 120,
  sectionPathMax: 300,
  queryMax: 200,
  searchResults: 10,
  snippetChars: 300,
} as const;

/** The format a file name implies, or null when it is not supported. */
export function documentFormatFor(name: string): DocumentFormat | null {
  const lower = name.trim().toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.txt')) return 'text';
  return null;
}

/** POST …/documents. The file's text is sent as a string; the browser reads
 * the file, so no binary ever reaches the server. */
export const CreateDocumentRequest = z.strictObject({
  name: z.string().trim().min(1).max(DOCUMENT_LIMITS.nameMax),
  content: z
    .string()
    .min(1)
    .max(DOCUMENT_LIMITS.maxChars * 2),
  /** Optional: the pipeline source this document describes. */
  sourceId: z.uuid().optional(),
});
export type CreateDocumentRequest = z.infer<typeof CreateDocumentRequest>;

export type DocumentSummary = {
  id: string;
  name: string;
  format: DocumentFormat;
  sizeChars: number;
  chunkCount: number;
  sourceId: string | null;
  status: 'active' | 'archived';
  createdAt: string;
};

/** One hit from a document search. The snippet is plain text. */
export type DocumentHit = {
  chunkId: string;
  documentId: string;
  documentName: string;
  sectionPath: string | null;
  startLine: number;
  endLine: number;
  snippet: string;
  rank: number;
};

export type ExtractedText = { ok: true; text: string } | { ok: false; reason: string };

const isStrayControl = (code: number): boolean =>
  (code < 0x20 && code !== 0x0a && code !== 0x09) || (code >= 0x7f && code <= 0x9f);

/** Turns uploaded text into clean text, or says why not (D-103). Refuses
 * anything that looks binary or is too large; removes a byte-order mark;
 * normalises line endings; and never interprets the content, so nothing in
 * a document can do anything but be read. */
export function extractDocumentText(raw: string): ExtractedText {
  let text = raw.startsWith('﻿') ? raw.slice(1) : raw;
  text = text.replace(/\r\n?/g, '\n');
  if (text.trim() === '') return { ok: false, reason: 'The document is empty.' };
  if (text.length > DOCUMENT_LIMITS.maxChars) {
    return {
      ok: false,
      reason: `The document is longer than ${DOCUMENT_LIMITS.maxChars.toLocaleString('en')} characters.`,
    };
  }
  let control = 0;
  for (const c of text) {
    const code = c.codePointAt(0) ?? 0;
    if (code === 0 || code === 0xfffd) {
      return { ok: false, reason: 'This does not look like text.' };
    }
    if (isStrayControl(code)) control += 1;
  }
  if (control > 0 && control / text.length > 0.001) {
    return { ok: false, reason: 'This does not look like text.' };
  }
  // The few stray control characters that remain are dropped.
  text = Array.from(text)
    .filter((c) => !isStrayControl(c.codePointAt(0) ?? 0))
    .join('')
    .replace(/[ \t]+$/gm, '');
  return { ok: true, text };
}

export type DocumentChunk = {
  ordinal: number;
  sectionTitle: string | null;
  sectionPath: string | null;
  startLine: number;
  endLine: number;
  text: string;
};

const clean = (value: string, max: number) =>
  Array.from(value, (c) => {
    const code = c.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : c;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

export type Chunked = { ok: true; chunks: DocumentChunk[] } | { ok: false; reason: string };

/** Splits clean text into chunks that remember where they came from (D-104):
 * the Markdown section (heading path) and the line range. A chunk never
 * crosses a heading and holds whole paragraphs up to the size limit; a longer
 * paragraph is cut at spaces. Headings inside code fences are not headings.
 * Plain text is one section without a title. */
export function chunkDocument(text: string, format: DocumentFormat): Chunked {
  const lines = text.split('\n');
  const stack: { level: number; title: string }[] = [];
  const chunks: DocumentChunk[] = [];
  let fence: string | null = null;
  let title: string | null = null;
  let path: string | null = null;
  let buffer: { text: string; start: number; end: number }[] = [];

  const flush = () => {
    let current = '';
    let start = 0;
    let end = 0;
    const emit = () => {
      if (current.trim() !== '') {
        chunks.push({
          ordinal: chunks.length,
          sectionTitle: title,
          sectionPath: path,
          startLine: start,
          endLine: end,
          text: current.trim(),
        });
      }
      current = '';
    };
    for (const paragraph of buffer) {
      let rest = paragraph.text;
      while (rest.length > DOCUMENT_LIMITS.maxChunkChars) {
        let cut = rest.lastIndexOf(' ', DOCUMENT_LIMITS.maxChunkChars);
        if (cut < DOCUMENT_LIMITS.maxChunkChars / 2) cut = DOCUMENT_LIMITS.maxChunkChars;
        emit();
        start = paragraph.start;
        end = paragraph.end;
        current = rest.slice(0, cut);
        emit();
        rest = rest.slice(cut).trimStart();
      }
      if (current !== '' && current.length + rest.length + 2 > DOCUMENT_LIMITS.maxChunkChars) {
        emit();
      }
      if (current === '') start = paragraph.start;
      current = current === '' ? rest : `${current}\n\n${rest}`;
      end = paragraph.end;
    }
    emit();
    buffer = [];
  };

  let paragraph: { lines: string[]; start: number } | null = null;
  const endParagraph = (lineNumber: number) => {
    if (paragraph !== null) {
      buffer.push({
        text: paragraph.lines.join('\n'),
        start: paragraph.start,
        end: lineNumber - 1,
      });
      paragraph = null;
    }
  };

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (format === 'markdown') {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker !== undefined) {
        if (fence === null) fence = marker[0] ?? '`';
        else if (marker[0] === fence) fence = null;
      }
      const heading = fence === null ? /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
      if (heading?.[1] !== undefined && heading[2] !== undefined) {
        endParagraph(lineNumber);
        flush();
        const level = heading[1].length;
        while ((stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
        title = clean(heading[2], DOCUMENT_LIMITS.sectionTitleMax) || null;
        stack.push({ level, title: title ?? '' });
        path =
          clean(
            stack
              .map((s) => s.title)
              .filter(Boolean)
              .join(' > '),
            DOCUMENT_LIMITS.sectionPathMax,
          ) || null;
        return;
      }
    }
    if (line.trim() === '') {
      endParagraph(lineNumber);
    } else if (paragraph === null) {
      paragraph = { lines: [line.trimEnd()], start: lineNumber };
    } else {
      paragraph.lines.push(line.trimEnd());
    }
  });
  endParagraph(lines.length + 1);
  flush();

  if (chunks.length === 0) return { ok: false, reason: 'The document has no readable text.' };
  if (chunks.length > DOCUMENT_LIMITS.maxChunks) {
    return { ok: false, reason: 'The document is too long to index.' };
  }
  return { ok: true, chunks };
}
