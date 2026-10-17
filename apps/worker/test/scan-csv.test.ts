import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { CsvRejection, scanCsv, type CsvLimits } from '../src/csv/scan-csv.js';

const limits: CsvLimits = { maxBytes: 1000, maxColumns: 4, maxRowBytes: 64 };

/** Splits the bytes into small chunks, as a network stream would. */
async function* chunks(bytes: Uint8Array, size = 7) {
  for (let i = 0; i < bytes.length; i += size) {
    await Promise.resolve();
    yield bytes.subarray(i, i + size);
  }
}

const names = (r: { columns: { name: string }[] }) => r.columns.map((c) => c.name);

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Scans `content`, declaring its real size and checksum unless overridden. */
function scan(
  content: string | Uint8Array,
  declared: { sizeBytes?: number; sha256?: string } = {},
  scanLimits = limits,
) {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return scanCsv(chunks(bytes), {
    limits: scanLimits,
    sizeBytes: declared.sizeBytes ?? bytes.length,
    sha256: declared.sha256 ?? sha256(bytes),
  });
}

/** Expects a rejection with this code, and a message matching `text`. */
async function rejects(promise: Promise<unknown>, code: string, text: RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CsvRejection, `not a CsvRejection: ${String(error)}`);
    assert.equal(error.code, code);
    assert.match(error.message, text);
    return true;
  });
}

describe('scanCsv', () => {
  it('returns the header and row count', async () => {
    const result = await scan('id,name\r\n1,Ada\r\n2,"Grace, ""Amazing"""\r\n');
    assert.deepEqual(names(result), ['id', 'name']);
    assert.equal(result.rowCount, 2);
  });

  it('accepts a byte-order mark, a missing final newline, quoted newlines, and blank lines', async () => {
    const result = await scan('﻿id,note\n1,"two\nlines"\n\n2,x');
    assert.deepEqual(names(result), ['id', 'note']);
    assert.equal(result.rowCount, 2);
  });

  it('decodes characters split across chunks', async () => {
    const result = await scan('city\nZürich\n東京\n');
    assert.equal(result.rowCount, 2);
  });

  it('counts a header-only file as zero rows', async () => {
    const result = await scan('a,b\n');
    assert.deepEqual(names(result), ['a', 'b']);
    assert.equal(result.rowCount, 0);
  });

  it('rejects an empty file', async () => {
    await rejects(scan(''), 'malformed', /empty/i);
    await rejects(scan('\n\n'), 'malformed', /empty/i);
  });

  it('rejects bytes that are not UTF-8', async () => {
    await rejects(scan(Buffer.from([0x61, 0x0a, 0xff, 0xfe, 0x0a])), 'malformed', /UTF-8/);
  });

  it('rejects binary content', async () => {
    await rejects(scan('a,b\n1,\u0000\n'), 'malformed', /binary|NUL/i);
  });

  it('rejects a file bigger than the limit, or than declared', async () => {
    await rejects(scan('a\n' + 'x\n'.repeat(600)), 'too_large', /larger than/i);
    await rejects(scan('a\n1\n', { sizeBytes: 3 }), 'malformed', /size/i);
    await rejects(scan('a\n1\n', { sizeBytes: 9 }), 'malformed', /size/i);
  });

  it('rejects content that does not match the declared checksum', async () => {
    await rejects(scan('a\n1\n', { sha256: '0'.repeat(64) }), 'malformed', /checksum/i);
  });

  it('rejects too many columns', async () => {
    await rejects(scan('a,b,c,d,e\n'), 'too_large', /5 columns.*at most 4/);
  });

  it('rejects a row longer than the limit, naming its line', async () => {
    await rejects(scan(`a,b\n1,2\n3,${'x'.repeat(80)}\n`), 'too_large', /line 3/i);
  });

  it('rejects rows whose value count differs from the header', async () => {
    await rejects(scan('a,b\n1,2\n3\n'), 'malformed', /line 3 has 1 value.*header has 2/i);
  });

  it('rejects unbalanced quotes', async () => {
    await rejects(scan('a,b\n1,"open\n'), 'malformed', /quote/i);
  });

  it('rejects empty or repeated header names', async () => {
    await rejects(scan('a,,c\n'), 'malformed', /column 2 has no name/i);
    await rejects(scan('a,b,a\n'), 'malformed', /"a" appears more than once/);
  });

  it('never puts cell values in its messages', async () => {
    await rejects(scan('a,b\nSECRET-VALUE\n'), 'malformed', /^(?!.*SECRET)/);
  });

  it('infers each column’s type and counts empty values as nulls', async () => {
    const result = await scan(
      [
        'n,price,ok,day,at,label,blank,mixed',
        '1,9.5,true,2026-10-17,2026-10-17T09:30:00Z,a,,1',
        '-20,1e3,FALSE,2026-02-28,2026-10-17 09:30:00.123+02:00,,,x',
        ',.5,,,,b, ,2.5',
      ].join('\n'),
      {},
      { ...limits, maxColumns: 10, maxRowBytes: 1000 },
    );
    assert.deepEqual(result.columns, [
      { name: 'n', type: 'integer', nullCount: 1 },
      { name: 'price', type: 'decimal', nullCount: 0 },
      { name: 'ok', type: 'boolean', nullCount: 1 },
      { name: 'day', type: 'date', nullCount: 1 },
      { name: 'at', type: 'timestamp', nullCount: 1 },
      { name: 'label', type: 'text', nullCount: 1 },
      { name: 'blank', type: 'unknown', nullCount: 3 },
      { name: 'mixed', type: 'text', nullCount: 0 },
    ]);
  });

  it('does not call impossible dates dates', async () => {
    const result = await scan('d\n2026-02-30\n');
    assert.equal(result.columns[0]?.type, 'text');
  });
});
