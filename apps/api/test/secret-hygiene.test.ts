import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

// Phase N review of logs, job payloads and errors, kept as a guard.
// Tests run with the package directory (apps/api) as the working directory.

const root = join(process.cwd(), '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'dev' ? [] : sourceFiles(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

describe('secret hygiene', () => {
  it('queue job data holds identifiers and times only', () => {
    const queues = readFileSync(join(root, 'packages/contracts/src/queues.ts'), 'utf8');
    const blocks = [...queues.matchAll(/export interface (\w*JobData) \{([^}]*)\}/g)];
    assert.ok(blocks.length >= 5, 'job data interfaces found');
    for (const [, name, body] of blocks) {
      const fields = [...(body ?? '').matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1] ?? '');
      for (const field of fields) {
        assert.match(field, /(Id|At)$/, `${name}.${field} must be an id or a time`);
      }
    }
  });

  it('server logging never prints an error message or stack unscrubbed', () => {
    const offenders: string[] = [];
    for (const app of ['api', 'worker']) {
      for (const file of sourceFiles(join(root, 'apps', app, 'src'))) {
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(/logger\.(?:log|warn|error|debug)\(([^;]*?)\);/gs)) {
          const call = m[1] ?? '';
          const usesDetail = /\.(message|stack)\b|String\(error\)|\$\{error\}/.test(call);
          if (usesDetail && !/scrubSecrets/.test(call)) offenders.push(file.replace(root, ''));
        }
      }
    }
    assert.deepEqual(offenders, []);
  });
});
