import {
  chunkDocument,
  DOCUMENT_LIMITS,
  documentFormatFor,
  extractDocumentText,
} from '@datasentinel/contracts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('document formats and extraction', () => {
  it('supports only text and Markdown files', () => {
    assert.equal(documentFormatFor('runbook.md'), 'markdown');
    assert.equal(documentFormatFor('Runbook.MARKDOWN'), 'markdown');
    assert.equal(documentFormatFor('notes.txt'), 'text');
    for (const bad of ['a.pdf', 'a.docx', 'a.html', 'a.md.exe', 'md', '']) {
      assert.equal(documentFormatFor(bad), null, bad);
    }
  });

  it('cleans text: byte-order mark, line endings, trailing spaces', () => {
    const out = extractDocumentText('﻿line one   \r\nline two\rline three\n');
    assert.deepEqual(out, { ok: true, text: 'line one\nline two\nline three\n' });
  });

  it('refuses empty, oversized, and binary-looking content', () => {
    const bad = [
      '',
      '   \n\n ',
      'x'.repeat(DOCUMENT_LIMITS.maxChars + 1),
      'PK\u0003\u0004\u0000\u0000binary',
      'text with a NUL \u0000 inside',
      'broken � encoding',
      `${'a'.repeat(100)}${'\u0001'.repeat(20)}`,
    ];
    for (const raw of bad) {
      assert.equal(extractDocumentText(raw).ok, false, JSON.stringify(raw.slice(0, 20)));
    }
    // A stray control character in real text is dropped, not fatal.
    assert.deepEqual(extractDocumentText(`${'word '.repeat(2000)}\u0007`).ok, true);
  });

  it('keeps links and markup as plain text and never interprets them', () => {
    const out = extractDocumentText('See https://example.com and <script>alert(1)</script>');
    assert.deepEqual(out, {
      ok: true,
      text: 'See https://example.com and <script>alert(1)</script>',
    });
  });
});

const md = `Intro paragraph before any heading.

# Setup

Install the loader.

## Credentials

Rotate the key every 90 days.
Never share it.

\`\`\`
# not a heading, inside a fence
\`\`\`

## Schedules

Runs at 02:00.

# Troubleshooting

Check the export job first.
`;

describe('chunking', () => {
  it('records the section path and line range of every chunk', () => {
    const result = chunkDocument(md, 'markdown');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const byText = (needle: string) => result.chunks.find((c) => c.text.includes(needle));
    assert.deepEqual(
      [byText('Intro paragraph')?.sectionTitle, byText('Intro paragraph')?.sectionPath],
      [null, null],
    );
    assert.equal(byText('Install the loader')?.sectionPath, 'Setup');
    assert.equal(byText('Rotate the key')?.sectionPath, 'Setup > Credentials');
    assert.equal(byText('Rotate the key')?.sectionTitle, 'Credentials');
    assert.equal(byText('Runs at 02:00')?.sectionPath, 'Setup > Schedules');
    assert.equal(byText('Check the export job')?.sectionPath, 'Troubleshooting');
    const rotate = byText('Rotate the key')!;
    assert.equal(
      md
        .split('\n')
        .slice(rotate.startLine - 1, rotate.endLine)
        .join('\n')
        .includes('Never share it.'),
      true,
    );
    assert.deepEqual(
      result.chunks.map((c) => c.ordinal),
      result.chunks.map((_, i) => i),
    );
  });

  it('does not treat a heading inside a code fence as a heading', () => {
    const result = chunkDocument(md, 'markdown');
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(
      result.chunks.some((c) => c.sectionTitle === 'not a heading, inside a fence'),
      false,
    );
    const fenced = result.chunks.find((c) => c.text.includes('inside a fence'));
    assert.equal(fenced?.sectionPath, 'Setup > Credentials');
  });

  it('treats plain text as one untitled section, even with # lines', () => {
    const result = chunkDocument('# not a heading in text\n\nSecond paragraph.', 'text');
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(
      result.chunks.every((c) => c.sectionPath === null),
      true,
    );
    assert.equal(result.chunks.length, 1);
  });

  it('keeps chunks within the size limit and splits long paragraphs at spaces', () => {
    const long = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ');
    const result = chunkDocument(`${long}\n\nShort tail.`, 'text');
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.ok(result.chunks.length >= 3);
    for (const chunk of result.chunks) {
      assert.ok(chunk.text.length <= DOCUMENT_LIMITS.maxChunkChars, `${chunk.text.length}`);
      assert.ok(chunk.startLine >= 1 && chunk.endLine >= chunk.startLine);
    }
    const rejoined = result.chunks.map((c) => c.text).join(' ');
    assert.equal(rejoined.includes('word0') && rejoined.includes('word599'), true);
    assert.equal(rejoined.includes('Short tail.'), true);
  });

  it('packs short paragraphs together and never crosses a heading', () => {
    const result = chunkDocument('# A\n\none\n\ntwo\n\n# B\n\nthree', 'markdown');
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(
      result.chunks.map((c) => [c.sectionPath, c.text]),
      [
        ['A', 'one\n\ntwo'],
        ['B', 'three'],
      ],
    );
  });

  it('refuses a document with no readable text or too many chunks', () => {
    assert.equal(chunkDocument('# Only a heading', 'markdown').ok, false);
    const many = Array.from(
      { length: DOCUMENT_LIMITS.maxChunks + 1 },
      (_, i) => `# H${i}\n\nbody ${i}`,
    ).join('\n\n');
    assert.equal(chunkDocument(many, 'markdown').ok, false);
  });

  it('cleans odd characters out of headings', () => {
    const result = chunkDocument('# Setup\u0007 ‮ title  \n\nbody', 'markdown');
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.chunks[0]?.sectionTitle?.includes('\u0007'), false);
  });
});
