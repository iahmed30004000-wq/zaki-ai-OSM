/**
 * Boots the app (`next dev`) against the SCRATCH database, on a free port, and keeps it in the foreground until Ctrl+C.
 *
 * DEFINITION OF DONE:
 *   1. The child gets an EXPLICIT scratch DATABASE_URL (`childEnv`, behind `assertScratchUrl`); nothing from the caller's shell or the repo's `.env`
 *      can point it elsewhere (a process variable beats `.env` — proved by `migrate.mjs`), and the variables the repo could fall back on are removed.
 *   2. `JWT_SECRET` is generated here, per run, and exists only in the child's environment (no literal, no file).
 *   3. The port is the first free one from 3100 (or `--port`), found by binding it; the URL is printed on a line a script can grep:
 *      `KIT_APP_URL=http://127.0.0.1:<port>`.
 *   4. A second checkout cannot build under Turbopack through a symlinked `node_modules` (the comment in `next.config.ts`): when the repo has no
 *      real `node_modules` of its own, `NEXT_TURBOPACK_ROOT` is the nearest ancestor that has one, and the build goes to `.next-verify` (git-ignored).
 *   5. It returns "ready" only after the server answered a request, and says so; the first page compile of `next dev` is slow on a loaded machine.
 *
 *   node scripts/verify-on-postgres/run-app.mjs [--port 3100] [--webpack]
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { REPO, argv, childEnv, die, redacted, scratchUrl, sleep } from './lib.mjs';

const args = argv({ webpack: 'flag' });

/** A port is free when we can bind it on the loopback address. */
function isFree(port) {
  return new Promise((ok) => {
    const s = createServer();
    s.once('error', () => ok(false));
    s.listen(port, '127.0.0.1', () => s.close(() => ok(true)));
  });
}

async function freePort(from) {
  for (let p = from; p < from + 50; p++) if (await isFree(p)) return p;
  die(`ما لقيت port فاضي من ${from} لـ${from + 49}.`);
}

/** The directory Turbopack may read: the repo itself when `node_modules` is a real directory here, else the nearest ancestor that has one. */
function turbopackRoot() {
  const own = join(REPO, 'node_modules');
  if (existsSync(own) && !lstatSync(own).isSymbolicLink()) {
    // A Windows junction reports as a symlink to lstat; a real directory does not.
    return null;
  }
  let dir = dirname(REPO);
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'node_modules');
    if (existsSync(candidate) && !lstatSync(candidate).isSymbolicLink()) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const port = await freePort(Number(args.port || 3100));
const root = turbopackRoot();
const env = childEnv({
  JWT_SECRET: randomBytes(32).toString('base64url'),
  NEXT_DIST_DIR: '.next-verify',
  NEXT_TELEMETRY_DISABLED: '1',
  PORT: String(port),
  ...(root ? { NEXT_TURBOPACK_ROOT: root } : {}),
});
// A development server: cookies are not `secure`, so a plain-http login works.
env.NODE_ENV = 'development';

const NEXT_CLI = resolve(REPO, 'node_modules', 'next', 'dist', 'bin', 'next');
const url = `http://127.0.0.1:${port}`;
console.log(`[run-app] قاعدة: ${redacted(scratchUrl())}`);
console.log(`[run-app] Turbopack root: ${root ?? '(المشروع نفسو)'} · build dir: .next-verify`);
console.log(`[run-app] next dev ${args.webpack ? '--webpack ' : ''}على ${url} …`);

const child = spawn(process.execPath, [NEXT_CLI, 'dev', '-p', String(port), '-H', '127.0.0.1', ...(args.webpack ? ['--webpack'] : [])], {
  cwd: REPO,
  env,
  stdio: ['ignore', 'inherit', 'inherit'],
  windowsHide: true,
});
child.on('exit', (code) => {
  console.log(`[run-app] next خلص (${code}).`);
  process.exit(code ?? 0);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill());

// Ready = a request is answered (any status below 500 on a cheap, public, API path).
let ready = false;
for (let i = 0; i < 180 && !ready; i++) {
  try {
    const r = await fetch(`${url}/api/auth/me`, { redirect: 'manual' });
    ready = r.status < 500;
  } catch {
    /* not listening yet */
  }
  if (!ready) await sleep(1000);
}
if (!ready) {
  child.kill();
  die('السيرفر ما جاوب خلال 3 دقائق — شوف الأخطاء فوق.');
}
console.log(`\n[run-app] جاهز.\nKIT_APP_URL=${url}\n(اضغط Ctrl+C لإيقافو. أول فتحة لكل صفحة بطيئة: next dev بيبني الصفحة وقت الطلب.)`);
