// Starts everything one small host needs: database migrations, the API, the
// worker, and nginx (web app plus /api proxy). If any process stops, the rest
// are stopped too, so the platform restarts the whole container.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const port = process.env.PORT ?? '10000';
const node = process.execPath;
const heap = '--max-old-space-size=160';

writeFileSync(
  '/tmp/nginx.conf',
  readFileSync('/repo/deploy/render-nginx.conf', 'utf8').replaceAll('__PORT__', port),
);

// Migrations use the direct database address when one is given (Neon's pooled
// address cannot run them).
const migrate = spawnSync('/repo/packages/db/node_modules/.bin/prisma', ['migrate', 'deploy'], {
  cwd: '/repo/packages/db',
  stdio: 'inherit',
});
if (migrate.status !== 0) {
  console.error('database migration failed; not starting');
  process.exit(1);
}

const processes = [
  {
    name: 'api',
    cmd: node,
    args: [heap, '--env-file-if-exists=../../.env', 'dist/main.js'],
    cwd: '/repo/apps/api',
    env: { API_PORT: '3000', TRUST_PROXY: 'true' },
  },
  {
    name: 'worker',
    cmd: node,
    args: [heap, '--env-file-if-exists=../../.env', 'dist/main.js'],
    cwd: '/repo/apps/worker',
    env: {},
  },
  {
    name: 'nginx',
    cmd: 'nginx',
    args: ['-e', '/dev/stderr', '-c', '/tmp/nginx.conf', '-g', 'daemon off;'],
    cwd: '/',
    env: {},
  },
];

const running = processes.map((p) => {
  const child = spawn(p.cmd, p.args, {
    cwd: p.cwd,
    env: { ...process.env, ...p.env },
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => {
    console.error(`${p.name} stopped (${signal ?? code}); stopping the rest`);
    stop(1);
  });
  return child;
});

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of running) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 5000).unref();
}
process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));
