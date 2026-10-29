import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from './guard-source';
import { FROZEN_STEPS, frozenText } from '../../scripts/freeze-deploy-steps';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE LINE THAT LOOKED LIKE A HEALTH CHECK FOR FOUR MONTHS.
 *
 * What stood at the end of the Dockerfile was this, indented by two
 * spaces:
 *
 *     CMD wget -qO- http://127.0.0.1:3000/login >/dev/null 2>&1 || exit 1
 *
 * Every word of a health check except the word `HEALTHCHECK`. Docker reads
 * it as the container's default COMMAND, and since an `ENTRYPOINT` is set
 * two lines below, those words became ARGUMENTS to the entrypoint script —
 * which ends in `exec node server.js` and never reads `"$@"`. So the line
 * probed nothing, ran nothing, and `docker inspect` reported the image as
 * having no health check at all. Nothing anywhere said so.
 *
 * That is why the rules below are RULES and not a copy of the new line. A
 * guard that checked for the text `wget …/login` would have passed on the
 * broken version; a guard that checks for the literal `/api/health` would
 * pass on a probe pointed at a route that no longer exists. So:
 *
 *   - there must be a HEALTHCHECK instruction, read as Docker reads it;
 *   - whatever path it probes must be a route that EXISTS in this app;
 *   - that route must answer without a session, because the probe has
 *     none and never will;
 *   - and a bare `CMD` may not sit next to an `ENTRYPOINT` that ignores
 *     its arguments — the exact shape of the original defect.
 *
 * `docker inspect` is the only thing that can prove the IMAGE declares the
 * check, and that proof belongs where Docker runs: `.github/workflows/
 * image.yml` builds the image, starts it against a real database, and
 * fails if the container never reports itself healthy. This file holds the
 * part that can be known without a daemon, and the last two claims hold
 * the workflow that holds the rest.
 * ═══════════════════════════════════════════════════════════════════════
 */

/** The Dockerfile as Docker sees it: no comments, continuations joined. */
function instructions(): { keyword: string; rest: string }[] {
  const joined = repoFile('Dockerfile')
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
    .replace(/\\\n/g, ' ');
  return joined
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^([A-Za-z]+)\s+([\s\S]*)$/.exec(l);
      return { keyword: (m?.[1] ?? l).toUpperCase(), rest: m?.[2] ?? '' };
    });
}

describe('the image says whether it is ready', () => {
  it('declares a HEALTHCHECK — the instruction, not a line that resembles one', () => {
    const health = instructions().filter((i) => i.keyword === 'HEALTHCHECK');
    expect(health, 'الصورة بلا HEALTHCHECK — Coolify ما بيعرف إذا الحاوية جاهزة').toHaveLength(1);
    // `HEALTHCHECK NONE` is a legal instruction that switches it OFF.
    expect(health[0].rest.trim().toUpperCase()).not.toBe('NONE');
    expect(health[0].rest).toMatch(/\bCMD\b/);
  });

  it('and waits long enough for the migrations the entrypoint runs first', () => {
    // The container runs `prisma migrate deploy` before the server listens.
    // With no start period, a container that is starting normally is killed
    // for failing a check it could not yet answer — and the deploy loops.
    const [health] = instructions().filter((i) => i.keyword === 'HEALTHCHECK');
    const start = /--start-period=(\d+)s/.exec(health.rest);
    expect(start, 'بلا --start-period الحاوية بتنقتل وهي عمّا تقلع').not.toBeNull();
    expect(Number(start![1])).toBeGreaterThanOrEqual(60);

    const retries = /--retries=(\d+)/.exec(health.rest);
    expect(retries, 'بلا --retries رفض واحد بيكفي').not.toBeNull();
    expect(Number(retries![1])).toBeGreaterThanOrEqual(2);
  });

  it('probes a route this app actually serves', () => {
    const [health] = instructions().filter((i) => i.keyword === 'HEALTHCHECK');
    const url = /https?:\/\/[^/\s]+(\/[^\s"']*)/.exec(health.rest);
    expect(url, 'الفحص ما بينادي عنواناً').not.toBeNull();

    const path = url![1].replace(/\?.*$/, '').replace(/\/$/, '');
    const route = join('src', 'app', path, 'route.ts');
    const page = join('src', 'app', path, 'page.tsx');
    expect(
      existsSync(join(process.cwd(), route)) || existsSync(join(process.cwd(), page)),
      `الفحص بينادي ${path} وما في شي بهالعنوان`
    ).toBe(true);
  });

  it('and that route answers without a session, because the probe has none', () => {
    // A probe carries no cookie and never will. Pointing the check at an
    // authenticated path turns every container unhealthy at once — and the
    // orchestrator would then restart a perfectly working app, for ever.
    const [health] = instructions().filter((i) => i.keyword === 'HEALTHCHECK');
    const path = /https?:\/\/[^/\s]+(\/[^\s"']*)/
      .exec(health.rest)![1]
      .replace(/\?.*$/, '')
      .replace(/\/$/, '');
    const file = join('src', 'app', path, 'route.ts');
    if (!existsSync(join(process.cwd(), file))) return; // a page, covered above
    // Comments stripped first, and the CALL and not the name: that route's
    // own header explains at length that authentication in this codebase
    // lives in each handler and names `requirePermission` while doing it —
    // so the first version of this claim failed on the prose that says the
    // route is open. Seventh time a guard here has read its own paperwork.
    const src = stripComments(repoFile(file));
    for (const gate of ['requirePermission', 'requireCompanyTenant', 'requireContext', 'requireAuth']) {
      expect(src, `${path} بيطلب تسجيل دخول، والفحص ما عنده جلسة`).not.toContain(`${gate}(`);
    }
  });

  it('and the route it probes asks neither the database nor the worker — the process alone', () => {
    /*
     * RV185. The probe used to be `/api/health`, which answers 503 when the
     * database is unreachable and was cached from a query. A database that
     * was merely SLOW then failed three checks in a row, the container
     * became «unhealthy», and the proxy stopped sending visitors to a
     * website that was perfectly alive: the monitoring manufactured the
     * outage. The database question has its own door (`/api/health`, for
     * the uptime monitor and Coolify's own setting); the container asks
     * only «is the process answering?».
     *
     * A RULE and not a path: whichever route the HEALTHCHECK names may not
     * import the database, the heartbeat, the health cache, or anything
     * under `@/lib/jobs`.
     */
    const [health] = instructions().filter((i) => i.keyword === 'HEALTHCHECK');
    const path = /https?:\/\/[^/\s]+(\/[^\s"']*)/
      .exec(health.rest)![1]
      .replace(/\?.*$/, '')
      .replace(/\/$/, '');
    expect(path, 'فحص الحاوية رجع لمسار فيه قاعدة بيانات').not.toBe('/api/health');
    const file = join('src', 'app', path, 'route.ts');
    expect(existsSync(join(process.cwd(), file)), `${file} مش موجود`).toBe(true);
    const src = stripComments(repoFile(file));
    for (const dependency of ['@/lib/db', '@/lib/jobs', './cached', '../cached', 'prisma', 'heartbeat']) {
      expect(src, `فحص الحاوية بيستورد ${dependency} — يعني بيسأل القاعدة أو العامل`).not.toContain(dependency);
    }
  });

  it('carries no bare CMD beside an ENTRYPOINT that ignores its arguments', () => {
    /*
     * THE ORIGINAL DEFECT, AS A RULE.
     *
     * With an ENTRYPOINT set, a `CMD` is not a command — it is the default
     * ARGUMENTS handed to that entrypoint. `docker-entrypoint.sh` ends in
     * `exec node server.js` and never mentions `"$@"`, so anything a `CMD`
     * says is read by nobody. A line nobody reads that looks exactly like a
     * line that matters is how four months passed with no health check.
     */
    const ins = instructions();
    const hasEntrypoint = ins.some((i) => i.keyword === 'ENTRYPOINT');
    const bareCmd = ins.filter((i) => i.keyword === 'CMD');
    if (!hasEntrypoint || bareCmd.length === 0) return;

    const entrypoint = repoFile('docker-entrypoint.sh');
    expect(
      entrypoint.includes('"$@"') || entrypoint.includes('$@'),
      'في CMD بالـDockerfile وENTRYPOINT ما بيقرا وسائطه — فالسطر ما بيعمل ولا إشي'
    ).toBe(true);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE BUILD, THE PROOF AND THE PUBLISH ARE FROZEN, WORD FOR WORD.
 *
 * What stood here was a list of spellings: not `docker build`, not
 * `buildx build`, the gate must read `github.ref == 'refs/heads/main'`,
 * every pushed name must be `docker tag`ged from the proved image. Three
 * rounds of widening that list, and a review beat it six more ways —
 * `docker builder build`, a second `bake-action`, `docker pull` plus
 * `docker tag`, `docker commit`, `docker load`, `podman build` — each
 * putting an image nothing had proved into the registry with every claim
 * green. And widening it a fourth time opened a hole of its own: the
 * looser gate pattern accepted `if: ${{ !(github.ref == …) }}`, which
 * publishes from every branch EXCEPT main.
 *
 * A guard that is a list is incomplete the day it is written. So the list
 * is gone, and what replaces it asks one question instead: ARE THESE
 * STEPS STILL THE STEPS THAT WERE READ? `image.proved-steps.lock` holds
 * their exact text — the five that compute the tag, build the image, ask
 * Docker whether a health check is declared, wait for the container to
 * report healthy, and push what ran.
 *
 * Any edit to any of them — a new command, a moved gate, a reworded
 * comment, a changed timeout — turns this red until somebody regenerates
 * the lock ON PURPOSE. That is the point: the deploy pipeline is not a
 * thing to adjust in passing, and a one-line diff in the lock file is
 * exactly the review that was missing.
 *
 * To update it after a deliberate change:
 *     node scripts/freeze-deploy-steps.mjs
 * ═══════════════════════════════════════════════════════════════════════
 */
describe('the build, the proof and the publish are frozen', () => {
  it('match the text that was read, to the character', () => {
    const wf = repoFile('.github/workflows/image.yml');
    // Normalised on both sides — see the note in the script: the working
    // tree is CRLF here and LF on the runner.
    const lock = repoFile('.github/workflows/image.proved-steps.lock').replace(/\r\n/g, '\n');

    expect(
      frozenText(wf),
      'تغيّرت خطوة من خطوات البناء/الإثبات/النشر. إذا التغيير مقصود: node scripts/freeze-deploy-steps.mjs'
    ).toBe(lock);
  });

  it('and every frozen step is still there, under its own name', () => {
    // Renaming a step to slip out of the freeze is the obvious way around
    // it — and it cannot work: the extractor writes «MISSING STEP» in its
    // place, so the comparison above fails rather than passing on nothing.
    const text = frozenText(repoFile('.github/workflows/image.yml'));
    expect(text, 'خطوة مجمّدة مفقودة أو انتغيّر اسمها').not.toContain('MISSING STEP');
    for (const name of FROZEN_STEPS) expect(text).toContain(`- name: ${name}`);
  });
});

describe('and the two promises the freeze does not cover', () => {
  const workflow = () => repoFile('.github/workflows/image.yml');

  /** The steps, indentation kept, whole-line comments removed. */
  const steps = (): string[] =>
    workflow()
      .split(/\n(?= {6}- )/)
      .map((s) =>
        s
          .split(/\r?\n/)
          .filter((l) => !l.trim().startsWith('#'))
          .join('\n')
      );

  const stepWith = (needle: string): string => steps().find((s) => s.includes(needle)) ?? '';

  it('says nothing to Coolify until both of its secrets exist', () => {
    /*
     * NOT frozen, because this step is the one the owner will edit when he
     * wires the webhook up — and the promise has to hold through that
     * edit: merging on a day nobody touches the server must change
     * nothing. A guard that notices the secrets are missing and then FAILS
     * the job turns every merge red instead, which is this promise
     * inverted.
     */
    const step = stepWith('COOLIFY_WEBHOOK_URL');
    expect(step, 'ما في خطوة نداء لـCoolify').not.toBe('');

    const guard = step.indexOf('-z "${COOLIFY_WEBHOOK_URL');
    const call = step.indexOf('curl');
    expect(guard, 'النداء بلا حارس على السرّين').toBeGreaterThan(-1);
    expect(step).toContain('-z "${COOLIFY_TOKEN');
    expect(guard, 'الحارس بعد النداء').toBeLessThan(call);

    const miss = step.slice(guard, call);
    expect(miss, 'الحارس بيوقّع الوظيفة بدل ما يسكت').toContain('exit 0');
    expect(miss, 'الحارس بيوقّع الوظيفة').not.toContain('exit 1');
  });

  it('and reads every secret through env, never into the shell line', () => {
    /*
     * `${{ secrets.X }}` inside a `run:` block is substituted into the
     * script BEFORE the shell runs it. From then on the token is part of
     * the command text: it reaches the log under `set -x`, in a syntax
     * error, and in any message that quotes the failing line. Through
     * `env:` it is a masked variable instead.
     *
     * This one covers EVERY step, including ones not yet written, so it
     * cannot be replaced by a frozen copy of five.
     *
     * The body is taken by indentation, as YAML takes a block scalar: it
     * ends at the first line no deeper than the `run:` key. Earlier
     * versions matched `run: |` alone and missed the plain form
     * (`- run: cmd`, which exists in this file), and took the key's column
     * from the line's leading spaces — wrong for `- run:`, where the dash
     * is part of the indentation. The column of `run:` itself is the one
     * YAML uses.
     */
    for (const block of workflow().split(/\n(?= {6}- )/)) {
      const lines = block.split(/\r?\n/);
      const at = lines.findIndex((l) => /^\s*(- )?run:(\s|$)/.test(l));
      if (at === -1) continue;
      const depth = lines[at].indexOf('run:');
      const body: string[] = [
        lines[at].replace(/^.*?run:\s*/, '').replace(/^[|>][-+]?\d*$/, ''),
      ];
      for (const line of lines.slice(at + 1)) {
        if (line.trim() === '') continue;
        if ((line.match(/^\s*/) ?? [''])[0].length <= depth) break;
        body.push(line);
      }
      expect(body.join('\n').includes('${{ secrets.'), 'سرّ مكتوب جوّا سطر الصدفة').toBe(false);
    }
  });
});

describe('and the secret scanner is not a thing somebody has to remember', () => {
  it('runs in CI, which is what its own header has been claiming', () => {
    // `scripts/scan-secrets.mjs` said «this runs in CI, right after the
    // linter, and fails the build» from the day it was written, and for a
    // while nothing in `.github/` mentioned it. The password that thirteen
    // real accounts were using is in this repository's history because
    // nothing ever looked.
    const script = JSON.parse(repoFile('package.json')).scripts?.['scan:secrets'];
    expect(script, 'ما في سكربت scan:secrets').toBeTruthy();

    const ci = repoFile('.github/workflows/ci.yml');
    expect(ci, 'الحارس مش بالـCI — فهو بيشتغل لمّا حدا يتذكّره').toContain('scan:secrets');

    // Before the tests, not after: a leaked credential is not something to
    // learn about four minutes later.
    expect(ci.indexOf('scan:secrets')).toBeLessThan(ci.indexOf('npm test'));
  });
});
