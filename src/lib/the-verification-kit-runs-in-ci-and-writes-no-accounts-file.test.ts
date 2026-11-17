import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPECTED_HAND_OUT, EXPECTED_REFUSALS, USERS, buildScenario, diffHandOut } from '../../scripts/verify-on-postgres/scenario.mjs';

/**
 * DEFINITION OF DONE — the verification kit in CI (planner 15/11, ruling 30) and «console only, no accounts file» (ruling 32).
 * Next to `the-verification-kit-never-leaves-the-scratch-database.test.ts`, which keeps pinning the gate (localhost + `scratch_` only);
 * this file does not touch it and does not repeat it.
 *
 * WHAT MUST WORK
 *   A. (ruling 32) No kit script writes the seeded password, or any accounts file. The ONLY writers are `migrate.mjs` (a decoy `.env` whose host cannot
 *      resolve, in a temporary directory, removed after) and `screenshots.mjs` (PNG bytes). The seed — the script that knows the password — imports no
 *      file-system module at all, and prints a password only when it generated one.
 *   B. (ruling 30) `.github/workflows/verify-on-postgres.yml` exists and: runs on pull_request (and push to main); has read-only permissions at the top
 *      and none widened per job; uses only `actions/checkout` and `actions/setup-node`; has a timeout; contains no secret, no password literal, no
 *      credentialed URL and no DATABASE_URL; never names the coolify remote; never pushes, deploys or logs in anywhere; stops the container as its LAST
 *      step with `if: always()`; calls only kit scripts that exist, in the kit's order (start-db, migrate, seed, pull-order, stop-db), pull-order with
 *      `--assert`; leaves the screenshots, check-app and scale-retries out; and does not touch ci.yml.
 *   C. (ruling 30) `pull-order --assert` can really FAIL: `diffHandOut` names every difference between two lists (a swap, a missing order, an extra one,
 *      no list at all), pull-order exits 3 on a mismatch, and the list the CI asserts (`EXPECTED_HAND_OUT`) agrees with an INDEPENDENT oracle — the
 *      planner's rules applied to the scenario's own times, written below, with no import from the product code.
 *
 * EDGE CASES: `if: always()` written as `${{ always() }}` is the same thing; the generated password is masked BEFORE it is written to GITHUB_ENV; the
 * OFF company's list has no retries in it (its switch is off: the dues are not read).
 *
 * BLOCKERS: a password in a file · the workflow able to write to the repository or deploy · a green CI over a pull-order that asserts nothing.
 *
 * Also proved by hand when this was written (not repeatable here, it needs Docker): the exact steps of the workflow were run in order on a clean machine
 * — start-db, migrate (152 migrations), seed, pull-order --assert — and a deliberately swapped expected list made pull-order exit 3.
 */

const KIT = join(process.cwd(), 'scripts', 'verify-on-postgres');
const WORKFLOW_PATH = join(process.cwd(), '.github', 'workflows', 'verify-on-postgres.yml');

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');
const scripts = readdirSync(KIT)
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => [f, stripComments(readFileSync(join(KIT, f), 'utf8'))] as const);
const source = (name: string) => scripts.find(([n]) => n === name)?.[1] ?? '';

const WRITES = /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|copyFile(?:Sync)?|cpSync|renameSync|outputFile)\b|process\.std(?:out|err)\.write|fs\.promises/;

// ───────────────────────── ruling 32 ─────────────────────────

describe('ruling 32 — the kit writes no accounts file', () => {
  it('sweeps the real folder', () => {
    expect(scripts.length).toBeGreaterThanOrEqual(10);
  });

  it('only migrate.mjs (a decoy .env) and screenshots.mjs (PNG bytes) write anything at all', () => {
    const writers = scripts.filter(([, src]) => WRITES.test(src)).map(([f]) => f);
    expect(writers.sort()).toEqual(['migrate.mjs', 'screenshots.mjs']);
  });

  it('neither writer puts a password, the database URL or the accounts into what it writes', () => {
    for (const f of ['migrate.mjs', 'screenshots.mjs']) {
      const calls = source(f).match(/writeFileSync\([^\n]*/g) ?? [];
      expect(calls.length, `${f} was expected to write something`).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call, `${f} writes: ${call}`).not.toMatch(/password|KIT_PASSWORD|passwordFrom|scratchUrl|childEnv|USERS|process\.env/i);
      }
    }
    // The one thing migrate writes is a decoy whose host can never resolve, with no credentials.
    const migrate = source('migrate.mjs');
    expect(migrate).toMatch(/decoy_user@\$\{DECOY_HOST\}/);
    expect(migrate).toMatch(/DECOY_HOST = 'decoy-host\.invalid'/);
    // Screenshots write the bytes of a screenshot, named by the page — nothing else.
    expect(source('screenshots.mjs')).toMatch(/writeFileSync\(file, Buffer\.from\(shot\.data, 'base64'\)\)/);
  });

  it('the seed — which knows the password — imports no file-system module, and the password reaches the console only', () => {
    const seed = source('seed.mjs');
    expect(seed).not.toMatch(/node:fs|from 'fs'|require\(['"]fs/);
    expect(seed).not.toMatch(WRITES);
    // Every line that names the password is the definition, the hash, or a console line.
    const lines = seed.split('\n').filter((l) => /\bpassword\b/.test(l) && !/passwordHash|bcrypt/.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l, `a password line that is neither a console line nor a definition: ${l.trim()}`).toMatch(/console\.log|const password|generated/);
    // A password the caller chose (KIT_PASSWORD) is never echoed; one the kit made is printed once.
    expect(seed).toMatch(/if \(generated\)/);
  });

  it('no other script imports a file-system module (run-app only LOOKS for a real node_modules)', () => {
    for (const [f, src] of scripts) {
      // team-leader-role.mjs READS one migration file of the repo (to run it in a rolled-back transaction): `readFileSync` and nothing that writes (checked just below).
      if (['migrate.mjs', 'screenshots.mjs', 'run-app.mjs', 'team-leader-role.mjs'].includes(f)) continue;
      expect(src, `${f} touches the file system`).not.toMatch(/node:fs|from 'fs'/);
    }
    expect(source('run-app.mjs')).toMatch(/import \{ existsSync, lstatSync \} from 'node:fs'/);
    expect(source('team-leader-role.mjs')).toMatch(/import \{ readFileSync \} from 'node:fs'/);
    expect(source('team-leader-role.mjs')).not.toMatch(/writeFile|appendFile|createWriteStream|mkdir|unlink|rmSync|rename/);
  });
});

// ───────────────────────── the workflow (ruling 30) ─────────────────────────

type Step = { name?: string; uses?: string; run?: string; if?: unknown; env?: Record<string, unknown>; with?: Record<string, unknown> };
type Job = { 'runs-on': string; 'timeout-minutes'?: number; permissions?: unknown; services?: unknown; steps: Step[] };
type Workflow = { on: Record<string, unknown>; permissions: Record<string, string>; jobs: Record<string, Job> };

/** A real YAML parser (js-yaml, which eslint already brings in): a regex over a workflow reads a comment as a step. */
function loadWorkflow(): { raw: string; wf: Workflow; job: Job } {
  const raw = readFileSync(WORKFLOW_PATH, 'utf8');
  const { load } = createRequire(import.meta.url)('js-yaml') as { load: (s: string) => unknown };
  const wf = load(raw) as Workflow;
  return { raw, wf, job: Object.values(wf.jobs)[0] };
}

const runOf = (s: Step) => s.run ?? '';

describe('ruling 30 — the kit runs in CI on a PostgreSQL container, as a permanent guard', () => {
  it('the workflow file exists and parses, with one job', () => {
    expect(existsSync(WORKFLOW_PATH)).toBe(true);
    expect(Object.keys(loadWorkflow().wf.jobs)).toHaveLength(1);
  });

  it('runs on every pull request and on pushes to main — like ci.yml', () => {
    const { wf, raw } = loadWorkflow();
    expect(Object.keys(wf.on).sort()).toEqual(['pull_request', 'push']);
    expect(wf.on.push).toEqual({ branches: ['main'] });
    // `pull_request_target` would hand a fork's code a token with the base repository's rights.
    expect(raw).not.toMatch(/pull_request_target|workflow_run/);
  });

  it('has read-only permissions, and no job widens them', () => {
    const { wf, job } = loadWorkflow();
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(job.permissions).toBeUndefined();
  });

  it('uses a fixed runner and Node 24 with the npm cache, installs from the lockfile, and has a timeout', () => {
    const { job } = loadWorkflow();
    expect(job['runs-on']).toBe('ubuntu-24.04');
    expect(job['timeout-minutes']).toBeGreaterThan(0);
    expect(job['timeout-minutes']).toBeLessThanOrEqual(60);
    const node = job.steps.find((s) => s.uses?.startsWith('actions/setup-node@'));
    expect(node?.with).toMatchObject({ 'node-version': 24, cache: 'npm' });
    expect(job.steps.some((s) => runOf(s).trim() === 'npm ci')).toBe(true);
    expect(job.steps.some((s) => runOf(s).trim() === 'docker pull postgres:16-alpine')).toBe(true);
    // The container comes from the kit (start-db), not from a `services:` block that would need a password written here.
    expect(job.services).toBeUndefined();
  });

  it('uses only the two first-party actions ci.yml uses', () => {
    const uses = loadWorkflow().job.steps.map((s) => s.uses).filter(Boolean);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u, `an action outside the two ci.yml uses: ${u}`).toMatch(/^actions\/(checkout|setup-node)@v\d+$/);
  });

  it('contains no secret, no password literal, no credentialed URL and no DATABASE_URL', () => {
    const { raw: withComments, job } = loadWorkflow();
    // The comments may SAY «no DATABASE_URL is set here»; what is pinned is the executable text.
    const raw = withComments.replace(/^\s*#.*$/gm, '');
    expect(raw).not.toMatch(/secrets\./);
    expect(raw).not.toMatch(/DATABASE_URL|DIRECT_URL|POSTGRES_PASSWORD|JWT_SECRET/);
    expect(withComments).not.toMatch(/(postgres|postgresql|mysql|redis):\/\/[^\s'"`/]+:[^\s'"`@]+@/);
    for (const s of job.steps) {
      // Every `…PASSWORD=` in a command is the generated value, by reference.
      for (const m of runOf(s).matchAll(/PASSWORD\s*[:=]\s*(\S*)/g)) expect(m[1], `a literal after PASSWORD in: ${runOf(s)}`).toMatch(/^"?\$\{?pw\}?"?$/);
      for (const [k, v] of Object.entries(s.env ?? {})) {
        if (/pass|secret|token|key/i.test(k)) expect(String(v), `env ${k} carries a literal`).toMatch(/^\$\{\{|^\$/);
      }
    }
  });

  it('generates the accounts password at run time, masks it BEFORE writing it, and passes it on through GITHUB_ENV only', () => {
    const { raw, job } = loadWorkflow();
    const step = job.steps.find((s) => /GITHUB_ENV/.test(runOf(s)));
    expect(step, 'no step hands KIT_PASSWORD on').toBeDefined();
    const run = runOf(step!);
    expect(run).toMatch(/randomBytes\(/);
    expect(run.indexOf('::add-mask::')).toBeGreaterThanOrEqual(0);
    expect(run.indexOf('::add-mask::')).toBeLessThan(run.indexOf('GITHUB_ENV'));
    expect(run).toMatch(/echo "KIT_PASSWORD=\$\{pw\}" >> "\$GITHUB_ENV"/);
    // Nothing else writes it anywhere: no other command mentions it, no file, no tee, no upload.
    expect(job.steps.filter((s) => /KIT_PASSWORD/.test(runOf(s)))).toHaveLength(1);
    expect(raw).not.toMatch(/upload-artifact|actions\/cache|\btee\b/);
  });

  it('never names the coolify remote, never pushes, deploys, logs in, or touches a registry', () => {
    const { raw, job } = loadWorkflow();
    expect(raw).not.toMatch(/coolify/i);
    const commands = job.steps.map(runOf).join('\n');
    expect(commands).not.toMatch(/git\s+(?:push|remote|commit|tag)|--force|docker\s+(?:login|push|tag)|ghcr\.io|\bgh\s|curl|wget|redeploy|deploy/i);
    expect(job.steps.map((s) => s.uses ?? '').join('\n')).not.toMatch(/deploy|publish|release|login|push/i);
  });

  it('calls kit scripts that exist, in the kit order, pull-order with --assert, and leaves the browser part and the unasserting probe out', () => {
    const { job } = loadWorkflow();
    const calls = job.steps.flatMap((s) => [...runOf(s).matchAll(/node (scripts\/verify-on-postgres\/([\w-]+\.mjs))([^\n]*)/g)].map((m) => ({ file: m[2], rest: m[3] })));
    for (const c of calls) expect(existsSync(join(KIT, c.file)), `the workflow calls ${c.file}, which does not exist`).toBe(true);
    expect(calls.map((c) => c.file)).toEqual(['start-db.mjs', 'migrate.mjs', 'seed.mjs', 'pull-order.mjs', 'intake-filter.mjs', 'queue-priority.mjs', 'scorecard.mjs', 'team-leader-role.mjs', 'eod-report.mjs', 'winback-daily.mjs', 'leads-intake.mjs', 'queue-health.mjs', 'stop-db.mjs']);
    expect(calls.find((c) => c.file === 'intake-filter.mjs')?.rest).toMatch(/--assert/);
    expect(calls.find((c) => c.file === 'queue-priority.mjs')?.rest).toMatch(/--assert/);
    expect(calls.find((c) => c.file === 'scorecard.mjs')?.rest).toMatch(/--assert/);
    expect(calls.find((c) => c.file === 'team-leader-role.mjs')?.rest).toMatch(/--assert/);
    expect(calls.find((c) => c.file === 'eod-report.mjs')?.rest).toMatch(/--assert/);
    expect(calls.find((c) => c.file === 'winback-daily.mjs')?.rest).toMatch(/--assert/);
    expect(calls.find((c) => c.file === 'leads-intake.mjs')?.rest).toMatch(/--assert/);
    expect(calls.find((c) => c.file === 'queue-health.mjs')?.rest).toMatch(/--assert/);
    expect(calls.find((c) => c.file === 'pull-order.mjs')?.rest).toMatch(/--assert/);
    for (const left of ['screenshots.mjs', 'check-app.mjs', 'run-app.mjs', 'scale-retries.mjs']) expect(calls.map((c) => c.file)).not.toContain(left);
  });

  it('stops the container as the LAST step, with if: always(), and no earlier step is able to skip the rest', () => {
    const { job } = loadWorkflow();
    const last = job.steps[job.steps.length - 1];
    expect(runOf(last)).toMatch(/node scripts\/verify-on-postgres\/stop-db\.mjs/);
    expect(String(last.if).replace(/[\s${}]/g, '')).toBe('always()');
    for (const s of job.steps.slice(0, -1)) expect(String(s.if ?? ''), `a step that can skip itself: ${s.name}`).not.toMatch(/failure\(\)|cancelled\(\)/);
  });

  it('adds no other way into a database than the kit (whose gate the older test pins)', () => {
    expect(loadWorkflow().raw).not.toMatch(/psql|prisma |npx |docker run|docker exec/);
  });

  it('leaves ci.yml alone: no PostgreSQL service and no kit script in the existing gate', () => {
    const ci = readFileSync(join(process.cwd(), '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).not.toMatch(/services:|postgres|verify-on-postgres/);
  });
});

// ───────────────────────── pull-order --assert really fails (ruling 30) ─────────────────────────

interface ScenarioOrder {
  key: string;
  country: string;
  company: 'on' | 'off';
  pool?: boolean;
  status: string;
  createdAt: Date;
  postponedUntil?: Date;
  lines: { due: Date | null; createdAt: Date }[];
}

describe("pull-order --assert can fail, and what it asserts is the planner's rule", () => {
  const now = new Date('2026-11-15T12:00:00Z');
  const orders = buildScenario(now) as unknown as ScenarioOrder[];

  it('diffHandOut says nothing for the same list and names every difference otherwise', () => {
    expect(diffHandOut(['a', 'b'], ['a', 'b'])).toEqual([]);
    expect(diffHandOut(['b', 'a'], ['a', 'b'])).toEqual(['#1: expected a · got b', '#2: expected b · got a']);
    expect(diffHandOut(['a'], ['a', 'b'])).toEqual(['#2: expected b · got (nothing)']);
    expect(diffHandOut(['a', 'b', 'c'], ['a', 'b'])).toEqual(['#3: expected (nothing) · got c']);
    expect(diffHandOut([], [])).toEqual([]);
    expect(diffHandOut(['a'], undefined as never)).toHaveLength(1);
  });

  it('pull-order exits 3 on a mismatch, compares only when --assert is given, and asserts the door\'s refusals too', () => {
    const src = source('pull-order.mjs');
    expect(src).toMatch(/process\.exit\(failed \? 2 : mismatches\.length > 0 \? 3 : 0\)/);
    expect(src).toMatch(/if \(!args\.assert\) return;/);
    expect(src).toMatch(/EXPECTED_HAND_OUT\[desk\.email\]/);
    expect(src).toMatch(/EXPECTED_REFUSALS\.atSeed/);
    expect(src).toMatch(/EXPECTED_REFUSALS\.whenEmpty/);
    expect(EXPECTED_REFUSALS).toEqual({ atSeed: 'UNTOUCHED_ORDER', whenEmpty: 'QUEUE_EMPTY' });
  });

  /**
   * THE ORACLE — the planner's rules applied to the scenario's own numbers, with the product's code nowhere in sight:
   *   NEW (never rung) oldest-created first · the customer's promise whose date arrived, the earliest date first · retries whose due passed, the oldest due
   *   first (a tie: the older order) · the rest, oldest-created. Not handed: a promise whose date has not come, a retry whose due has not passed.
   *   The OFF company reads no dues: new, then the rest by age.
   */
  function oracle(company: 'on' | 'off', country: string): string[] {
    const pool = orders.filter((o) => o.pool && o.company === company && o.country === country);
    const byAge = (a: ScenarioOrder, b: ScenarioOrder) => a.createdAt.getTime() - b.createdAt.getTime();
    const dueOf = (o: ScenarioOrder) => o.lines.map((l) => l.due?.getTime() ?? null).filter((d): d is number => d !== null).pop() ?? null;
    const neverRung = pool.filter((o) => o.lines.length === 0).sort(byAge);
    const rung = pool.filter((o) => o.lines.length > 0);
    if (company === 'off') return [...neverRung, ...rung.sort(byAge)].map((o) => o.key);
    const promised = rung.filter((o) => o.postponedUntil && o.postponedUntil <= now).sort((a, b) => a.postponedUntil!.getTime() - b.postponedUntil!.getTime() || byAge(a, b));
    const rest = rung.filter((o) => !promised.includes(o) && !(o.postponedUntil && o.postponedUntil > now));
    const retries = rest.filter((o) => (dueOf(o) ?? Infinity) <= now.getTime()).sort((a, b) => dueOf(a)! - dueOf(b)! || byAge(a, b));
    const others = rest.filter((o) => dueOf(o) === null).sort(byAge);
    return [...neverRung, ...promised, ...retries, ...others].map((o) => o.key);
  }

  it('the oracle itself says what the planner says for the Syria desk (a hand-written check of the oracle)', () => {
    expect(oracle('on', 'SY')).toEqual(['SY-NEW-1', 'SY-NEW-2', 'SY-PROMISE-DUE', 'SY-RETRY-A', 'SY-RETRY-B', 'SY-RETRY-C', 'SY-RETRY-E', 'SY-LEGACY']);
  });

  it.each([
    [USERS.agent1On.email, 'on', 'SY'],
    [USERS.agent2On.email, 'on', 'JO'],
    [USERS.agentOff.email, 'off', 'SY'],
  ] as const)("the list CI asserts for %s is the oracle's", (email, company, country) => {
    const expected = (EXPECTED_HAND_OUT as Record<string, string[]>)[email];
    expect(expected).toBeDefined();
    expect(diffHandOut(expected, oracle(company, country))).toEqual([]);
  });

  it('every desk of the harness has a list, every key in it is a seeded pool order, and no list repeats an order', () => {
    expect(Object.keys(EXPECTED_HAND_OUT).sort()).toEqual([USERS.agent1On.email, USERS.agent2On.email, USERS.agentOff.email].sort());
    const pool = new Set(orders.filter((o) => o.pool).map((o) => o.key));
    for (const list of Object.values(EXPECTED_HAND_OUT) as string[][]) {
      expect(new Set(list).size).toBe(list.length);
      for (const k of list) expect(pool.has(k), `${k} is not a seeded pool order`).toBe(true);
    }
    // The OFF company's switch is off: no retry may appear in its list.
    expect((EXPECTED_HAND_OUT as Record<string, string[]>)[USERS.agentOff.email].some((k) => k.includes('RETRY'))).toBe(false);
  });
});
