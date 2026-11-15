/**
 * ═══════════════════════════════════════════════════════════════════════
 * The shared parts of the local real-PostgreSQL verification kit (Confirmation Center v2, steps A+B).
 *
 * DEFINITION OF DONE (what this file must guarantee for every other script of the kit):
 *   1. Nothing here can reach any database but the throwaway container `zaki-scratch-pg` on 127.0.0.1.
 *      `assertScratchUrl` is the one gate: the host must be localhost / 127.0.0.1 / [::1] AND the database name must start with
 *      `scratch_`. Every script of the kit builds its URL through `scratchUrl()` and passes it explicitly — the URL of the repo's
 *      `.env` (or of the caller's shell) is never read, printed or used.
 *   2. The container's password is generated at runtime, handed to docker through the CHILD's environment (never on the command
 *      line) and read back later with `docker inspect`. It is written to no file, tracked or not, and no script prints it.
 *   3. A destructive thing (remove container / volume) names its target and refuses a name that is not ours.
 *
 * What it does NOT do: it never runs a migration, a seed or a query — those are the other scripts, each behind the gate.
 * ═══════════════════════════════════════════════════════════════════════
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONTAINER = 'zaki-scratch-pg';
export const VOLUME = 'zaki-scratch-pg-data';
export const IMAGE = 'postgres:16-alpine';
export const HOST = '127.0.0.1';
export const PORT = Number(process.env.SCRATCH_PG_PORT || 54329);
export const DB_NAME = 'scratch_zaki';
export const DB_USER = 'postgres';

export const KIT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(KIT_DIR, '..', '..');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Stops the process with a sentence — a kit that fails quietly is a kit nobody can trust. */
export function die(message, code = 1) {
  console.error(`\n[verify-on-postgres] ${message}\n`);
  process.exit(code);
}

/**
 * THE GATE. A URL passes only if it points at this machine AND at a database whose name starts with `scratch_`.
 * Returns the parsed URL so a caller cannot check one string and use another.
 */
export function assertScratchUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    die('ما قدرت أقرأ عنوان القاعدة — الكيت بيرفض يشتغل بعنوان مش مفهوم.');
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') die('العنوان مش PostgreSQL — مرفوض.');
  if (!LOCAL_HOSTS.has(url.hostname)) {
    die(`REFUSED: the database host must be localhost or 127.0.0.1 (got "${url.hostname}"). This kit never touches a remote database.`);
  }
  // libpq (and prisma after it) read these from the query string and let them override the address above: a "local" URL that carries one is not local.
  for (const key of ['host', 'hostaddr', 'dbname', 'service']) {
    if (url.searchParams.has(key)) die(`REFUSED: the query parameter "${key}" can redirect the connection — this kit takes none of them.`);
  }
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!name.startsWith('scratch_')) {
    die(`REFUSED: the database name must start with "scratch_" (got "${name}"). This kit never touches a real database.`);
  }
  return url;
}

/** `docker …` with an explicit argument list (no shell). `env` is added to the child's environment only. */
export function docker(args, { env, input, allowFail = false } = {}) {
  const r = spawnSync('docker', args, {
    encoding: 'utf8',
    input,
    env: { ...process.env, ...(env || {}) },
    windowsHide: true,
  });
  if (r.error) die(`docker غير موجود أو لا يشتغل: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) {
    die(`docker ${args[0]} فشل (${r.status}):\n${(r.stderr || r.stdout || '').trim()}`);
  }
  return { code: r.status ?? 1, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/** A password for the throwaway database: 24 URL-safe characters. Only ever put in a child's environment. */
export function newPassword() {
  return randomBytes(18).toString('base64url');
}

/** The state of OUR container: 'running' | 'stopped' | 'absent'. */
export function containerState() {
  const r = docker(['inspect', '--format', '{{.State.Running}}', CONTAINER], { allowFail: true });
  if (r.code !== 0) return 'absent';
  return r.out === 'true' ? 'running' : 'stopped';
}

export function volumeExists() {
  return docker(['volume', 'inspect', VOLUME], { allowFail: true }).code === 0;
}

/** The password the container was created with — read from docker, never from a file. */
function containerPassword() {
  const r = docker(['inspect', '--format', '{{range .Config.Env}}{{println .}}{{end}}', CONTAINER], { allowFail: true });
  if (r.code !== 0) die('الحاوية zaki-scratch-pg مش موجودة — شغّل start-db.mjs أول.');
  const line = r.out.split(/\r?\n/).find((l) => l.startsWith('POSTGRES_PASSWORD='));
  if (!line) die('ما لقيت كلمة سر الحاوية.');
  return line.slice('POSTGRES_PASSWORD='.length);
}

/**
 * The scratch database's URL — built from parts, so no `user:secret@host` literal sits in this file.
 * `db` defaults to the kit's database; any other name still has to start with `scratch_`.
 */
export function scratchUrl(db = DB_NAME) {
  const url = new URL(`postgresql://${HOST}:${PORT}/${db}`);
  url.username = DB_USER;
  url.password = containerPassword();
  assertScratchUrl(url.href);
  return url.href;
}

/** The URL with the password blanked — safe to print. */
export function redacted(raw) {
  const url = new URL(raw);
  if (url.password) url.password = '***';
  return url.href;
}

/**
 * The environment every child that talks to the database gets: an EXPLICIT scratch DATABASE_URL, and the other URL-ish variables
 * the repo's code could fall back on removed — so nothing in the caller's shell can redirect a child to another database.
 */
export function childEnv(extra = {}) {
  const url = scratchUrl();
  const env = { ...process.env, ...extra, DATABASE_URL: url };
  for (const k of ['DIRECT_URL', 'SHADOW_DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL', 'DATABASE_URL_UNPOOLED']) delete env[k];
  // The kit is a development tool: a production NODE_ENV would make the seed (rightly) refuse and the app demand real secrets.
  if (env.NODE_ENV === 'production') delete env.NODE_ENV;
  assertScratchUrl(env.DATABASE_URL);
  return env;
}

/** `node <args>` in the repo, with a given environment; stdout and stderr go to the console. Returns the exit code. */
export function runNode(args, { env, cwd = REPO, capture = false } = {}) {
  const r = spawnSync(process.execPath, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) die(`node فشل: ${r.error.message}`);
  return capture ? { code: r.status ?? 1, out: `${r.stdout || ''}${r.stderr || ''}` } : r.status ?? 1;
}

/** The prisma CLI entry — run with `node`, so there is no `.cmd` shim and no shell on Windows. */
export const PRISMA_CLI = resolve(REPO, 'node_modules', 'prisma', 'build', 'index.js');
export const TSX_CLI = resolve(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');

/**
 * For a script that imports the repo's own TypeScript: if it is not already running under tsx, run itself again under it and exit with its code.
 * Done through the tsx COMMAND (the way `db:seed` and the worker run) and not by importing tsx as a module — so `node <script>.mjs` keeps working, and
 * the dependency stays what `nothing-unused-ships.test.ts` says it is: a tool the scripts run, not a library the tree imports.
 */
export function relaunchUnderTsx(metaUrl) {
  if (process.env.KIT_UNDER_TSX === '1') return;
  const r = spawnSync(process.execPath, [TSX_CLI, fileURLToPath(metaUrl), ...process.argv.slice(2)], {
    cwd: REPO,
    env: { ...process.env, KIT_UNDER_TSX: '1' },
    stdio: 'inherit',
    windowsHide: true,
  });
  if (r.error) die(`tsx ما اشتغل: ${r.error.message}`);
  process.exit(r.status ?? 1);
}

/** One SQL statement through `psql` INSIDE the container (local socket, no password) — to the maintenance db or a scratch one. */
export function psql(sql, db = 'postgres') {
  if (db !== 'postgres' && !db.startsWith('scratch_')) die(`REFUSED: psql on "${db}"`);
  return docker(['exec', CONTAINER, 'psql', '-U', DB_USER, '-d', db, '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql]);
}

/** Tiny argv reader: `--name value`, `--flag`. */
export function argv(names = {}) {
  const out = { _: [] };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) {
      const key = a[i].slice(2);
      if (names[key] === 'flag') out[key] = true;
      else out[key] = a[++i];
    } else out._.push(a[i]);
  }
  return out;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
