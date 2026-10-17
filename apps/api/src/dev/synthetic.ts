/** Writes the synthetic CSV files: node dist/dev/synthetic.js <directory> */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SYNTHETIC_CASES, syntheticCsv } from './synthetic-datasets.js';

const dir = process.argv[2];
if (dir === undefined) {
  console.error('Usage: node dist/dev/synthetic.js <directory>');
  process.exit(1);
}
await mkdir(dir, { recursive: true });
for (const kind of SYNTHETIC_CASES) {
  await writeFile(join(dir, `orders_${kind}.csv`), syntheticCsv(kind));
}
console.log(`Wrote ${SYNTHETIC_CASES.length} files to ${dir}`);
