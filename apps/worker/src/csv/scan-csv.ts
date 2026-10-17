import { CSV_LIMITS, type UploadFailure } from '@datasentinel/contracts';
import { CsvError, parse } from 'csv-parse';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ColumnProfiler, type CsvColumnType } from './column-profiler.js';

export type CsvLimits = { [K in keyof typeof CSV_LIMITS]: number };

export interface ScanOptions {
  limits?: CsvLimits;
  /** What the uploader declared; the bytes must match both. */
  sizeBytes: number;
  sha256: string;
  signal?: AbortSignal;
  /** Sees each data row after its checks pass, with the header names. */
  onRow?: (values: readonly string[], columns: readonly string[]) => void;
}

export interface CsvColumn {
  name: string;
  type: CsvColumnType;
  /** Empty or blank values. */
  nullCount: number;
}

export interface CsvSummary {
  /** In file order. */
  columns: CsvColumn[];
  /** Data rows, not counting the header. */
  rowCount: number;
}

/** A file DataSentinel will not accept. The message names lines and limits,
 * never cell values, so it is safe to store and show (D-42). */
export class CsvRejection extends Error {
  constructor(
    readonly code: 'too_large' | 'malformed',
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = 'CsvRejection';
  }

  toJSON(): UploadFailure {
    return { code: this.code, message: this.message, hint: this.hint, retryable: false };
  }
}

const FIX = 'Fix the file and upload it again.';
const malformed = (message: string, hint = FIX) => new CsvRejection('malformed', message, hint);
const tooLarge = (message: string, hint = FIX) => new CsvRejection('too_large', message, hint);

/** Header names can be long; messages quote at most 60 characters. */
const quoteName = (name: string) => `"${name.length > 60 ? `${name.slice(0, 60)}…` : name}"`;

const MB = 1024 * 1024;
const size = (n: number) => (n >= MB ? `${n / MB} MB` : `${n} bytes`);
const sizeMismatch = () =>
  malformed(
    'The file size does not match the size declared when the upload started.',
    'Start a new upload with the same file.',
  );

/** Reads a CSV once, as a stream, profiles each column (type and nulls,
 * D-43), and checks it against the D-08 limits:
 * size and checksum as declared, UTF-8 (a byte-order mark is allowed), no
 * binary content, a header row with unique non-empty names, at most
 * `maxColumns` columns and `maxRowBytes` per row, and the header's number
 * of values on every row. Memory stays bounded by one row. Blank lines are
 * skipped. Rejects with CsvRejection; other errors (storage) pass through. */
export async function scanCsv(
  body: AsyncIterable<Uint8Array>,
  { limits = CSV_LIMITS, sizeBytes, sha256, signal, onRow }: ScanOptions,
): Promise<CsvSummary> {
  const hash = createHash('sha256');
  let bytes = 0;

  async function* text() {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const decode = (chunk?: Uint8Array) => {
      try {
        return chunk === undefined ? decoder.decode() : decoder.decode(chunk, { stream: true });
      } catch {
        throw malformed('The file is not UTF-8 text.', 'Save it as CSV UTF-8 and upload it again.');
      }
    };
    for await (const chunk of body) {
      bytes += chunk.length;
      if (bytes > limits.maxBytes) {
        throw tooLarge(
          `The file is larger than ${size(limits.maxBytes)}.`,
          'Split it into smaller files.',
        );
      }
      if (bytes > sizeBytes) throw sizeMismatch();
      hash.update(chunk);
      const part = decode(chunk);
      if (part.includes('\u0000')) {
        throw malformed('The file contains binary content (NUL bytes), so it is not a CSV file.');
      }
      if (part !== '') yield part;
    }
    const rest = decode();
    if (rest !== '') yield rest;
  }

  const parser = parse({
    raw: true,
    info: true,
    skip_empty_lines: true,
    // Our own check below gives a clearer message.
    relax_column_count: true,
    // Characters, so a byte limit can never be passed by much; the exact
    // byte check is on each record's raw text.
    max_record_size: limits.maxRowBytes,
  });

  let columns: string[] | undefined;
  let profilers: ColumnProfiler[] = [];
  let rowCount = 0;

  try {
    await pipeline(
      Readable.from(text()),
      parser,
      async (
        records: AsyncIterable<{ record: string[]; raw: string; info: { lines: number } }>,
      ) => {
        for await (const { record, raw, info } of records) {
          const line = info.lines;
          if (Buffer.byteLength(raw) > limits.maxRowBytes) {
            throw tooLarge(
              `Line ${line} is longer than the ${size(limits.maxRowBytes)} row limit.`,
            );
          }
          if (columns === undefined) {
            columns = checkHeader(record, limits.maxColumns);
            profilers = columns.map(() => new ColumnProfiler());
            continue;
          }
          if (record.length !== columns.length) {
            throw malformed(
              `Line ${line} has ${record.length} ${record.length === 1 ? 'value' : 'values'}; the header has ${columns.length}.`,
            );
          }
          record.forEach((value, i) => profilers[i]?.add(value));
          onRow?.(record, columns);
          rowCount += 1;
        }
      },
      { signal },
    );
  } catch (error) {
    throw fromParser(error, limits);
  }

  if (columns === undefined) throw malformed('The file is empty; a header row is required.');
  if (bytes !== sizeBytes) throw sizeMismatch();
  if (hash.digest('hex') !== sha256) {
    throw malformed(
      'The file does not match the checksum declared when the upload started.',
      'Start a new upload with the same file.',
    );
  }
  return {
    columns: columns.map((name, i) => ({
      name,
      type: profilers[i]?.type ?? 'unknown',
      nullCount: profilers[i]?.nullCount ?? 0,
    })),
    rowCount,
  };
}

function checkHeader(names: string[], maxColumns: number): string[] {
  if (names.length > maxColumns) {
    throw tooLarge(`The header has ${names.length} columns; at most ${maxColumns} are allowed.`);
  }
  const seen = new Set<string>();
  names.forEach((raw, i) => {
    const name = raw.trim();
    if (name === '') throw malformed(`Column ${i + 1} has no name in the header row.`);
    if (seen.has(name))
      throw malformed(`The column name ${quoteName(name)} appears more than once.`);
    seen.add(name);
  });
  return names.map((n) => n.trim());
}

/** Parser errors become safe rejections; their own text can quote data. */
function fromParser(error: unknown, limits: CsvLimits): unknown {
  if (error instanceof CsvRejection || !(error instanceof CsvError)) return error;
  const line = (error as CsvError & { lines?: number }).lines;
  const at = typeof line === 'number' ? `Line ${line}` : 'A line';
  const known: Partial<Record<CsvError['code'], () => CsvRejection>> = {
    CSV_MAX_RECORD_SIZE: () =>
      tooLarge(`${at} is longer than the ${size(limits.maxRowBytes)} row limit.`),
    CSV_QUOTE_NOT_CLOSED: () => malformed(`${at} opens a quote that is never closed.`),
    CSV_INVALID_CLOSING_QUOTE: () => malformed(`${at} has text right after a closing quote.`),
    CSV_NON_TRIMABLE_CHAR_AFTER_CLOSING_QUOTE: () =>
      malformed(`${at} has text right after a closing quote.`),
  };
  return known[error.code]?.() ?? malformed(`${at} could not be read as CSV.`);
}
