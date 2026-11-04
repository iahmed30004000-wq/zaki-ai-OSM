import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * EVERY HANDLER ASKS WHO IS CALLING.
 *
 * «The defect to hunt: a control hidden in the UI but permitted by the
 * API. That is not a permission, it is a decoration.» Its strongest form
 * is a handler with no check at all — the screen never draws the button,
 * so nobody notices the door standing open.
 *
 * PER HANDLER, not per file. A route with a guarded GET and a bare DELETE
 * would pass a file-level sweep, and the DELETE is the one that matters.
 *
 * AND ONE CALL DEEP, because that is where the guards actually live:
 * `sendOutboundMessage` asks for `whatsapp.send` itself, and the
 * categories route checks inside a helper above its exports. A first
 * version of this sweep read only the handler's own body, reported
 * thirty-six, and every one of them was already guarded — a sweep that
 * cries wolf is a sweep people learn to ignore.
 */

const root = process.cwd();

/*
 * `requireSystemToken` IS A DOOR, AND IT IS NOT A SESSION.
 *
 * O7 added `/api/v1`, which another SYSTEM calls with a bearer token: there
 * is no cookie, so none of the session guards can appear in those handlers.
 * The check is `requireSystemToken(req, scope)` in
 * `src/lib/v1/system-token.ts` — it proves the key against `SystemToken`,
 * refuses a revoked or expired one, refuses a missing scope, and returns the
 * `companyId` FROM THE TOKEN so a caller can never name a company.
 *
 * It is listed here rather than exempted under `PUBLIC` below, because the
 * door is not public — it is guarded differently. `verifyCourierToken` is
 * the precedent: a token at the door is still a door.
 *
 * `requireCallHelperDevice` and `redeemPairCode` (src/lib/call-helper/door.ts)
 * are the same kind: the call helper's Android app has no cookie, so its
 * bearer token — or, once, its one-time pairing code — is the door. The
 * token is proved against `CallHelperDevice.tokenHash`, refused when revoked
 * or when its person is not ACTIVE, and the company comes FROM THE ROW.
 */
const GUARD =
  /require(?:Context|Permission|Auth|CompanyTenant|SystemToken|CallHelperDevice)\s*\(|getCurrentUser\s*\(|guardRoute\s*\(|redeemPairCode\s*\(|verifyCourierToken|verifyWebhookSignature|webhookToken/;

/**
 * OPEN TO THE WORLD, DELIBERATELY — each with the reason it is.
 *
 * This list is the audit's own statement of what has no door, so adding a
 * route here is a decision somebody has to write down rather than a check
 * somebody forgot.
 */
const PUBLIC: [string, string][] = [
  ['src/app/api/auth/', 'signing in, out, registering, recovering — there is no session yet'],
  ['src/app/api/public/', 'a shopper reaches these with no account at all'],
  ['src/app/api/webhooks/', 'a courier or a platform calls in; the token or the signature is the door'],
  ['src/app/api/media/', 'an image referenced by a page the world can already open'],
  ['src/app/api/dev-fonts/', 'development only, and refused in a production build'],
  ['src/app/api/store-fonts/', 'a shop page loading its own fonts'],
  [
    'src/app/api/health/',
    'an uptime monitor has no cookie and never will; both handlers are GET-only, answer a closed vocabulary of eight fixed words, and read nothing a login would protect — see the leak rules in src/app/api/health/route.ts',
  ],
];

const strip = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

function routeFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('route.ts')) out.push(relative(root, p).split('\\').join('/'));
    }
  };
  walk(join(root, 'src', 'app', 'api'));
  return out;
}

/** Names of functions that guard: local ones, and imported modules' exports. */
function guardingNames(file: string, src: string): Set<string> {
  const names = new Set<string>();

  /*
   * A DECLARATION'S BODY ENDS WHERE THE NEXT ONE BEGINS.
   *
   * The first version took a fixed two-and-a-half-thousand characters
   * from each declaration, which swallowed the guard belonging to a
   * LATER function and marked almost every local name as guarding. The
   * sweep then passed a mutation that stripped a handler's only check —
   * a green guard over an open door, which is the one outcome worse than
   * having no guard.
   */
  const DECL = /(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/g;
  const decls = [...src.matchAll(DECL)];
  for (let i = 0; i < decls.length; i++) {
    const name = decls[i][1] ?? decls[i][2];
    const body = src.slice(decls[i].index!, decls[i + 1]?.index ?? src.length);
    if (GUARD.test(body)) names.add(name);
  }

  /*
   * Imported: the named export, and only if ITS OWN body guards. «The
   * module contains a guard somewhere» would let one guarded function in
   * a file vouch for every other function in it.
   */
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(@\/[^']+)'/g)) {
    for (const ext of ['.ts', '.tsx']) {
      const candidate = 'src/' + m[2].slice(2) + ext;
      if (!existsSync(join(root, candidate))) continue;
      const target = strip(readFileSync(join(root, candidate), 'utf8'));
      const theirs = [...target.matchAll(DECL)];
      for (const raw of m[1].split(',')) {
        const name = raw.split(' as ').pop()!.trim();
        if (!name) continue;
        for (let i = 0; i < theirs.length; i++) {
          if ((theirs[i][1] ?? theirs[i][2]) !== name) continue;
          const body = target.slice(theirs[i].index!, theirs[i + 1]?.index ?? target.length);
          if (GUARD.test(body)) names.add(name);
        }
      }
    }
  }
  return names;
}

describe('no handler is left without a door', () => {
  const files = routeFiles();
  const unguarded: string[] = [];
  let handlers = 0;

  for (const file of files) {
    if (PUBLIC.some(([prefix]) => file.startsWith(prefix))) continue;
    const src = strip(readFileSync(join(root, file), 'utf8'));
    const guards = guardingNames(file, src);

    const marks = [...src.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)];
    for (let i = 0; i < marks.length; i++) {
      handlers++;
      const body = src.slice(marks[i].index!, marks[i + 1]?.index ?? src.length);
      if (GUARD.test(body)) continue;
      // …or it calls something that does.
      if ([...guards].some((n) => new RegExp(`\\b${n}\\s*\\(`).test(body))) continue;
      unguarded.push(`${marks[i][1].padEnd(6)} ${file}`);
    }
  }

  it('found routes and handlers to check — a sweep over nothing proves nothing', () => {
    expect(files.length).toBeGreaterThan(150);
    expect(handlers).toBeGreaterThan(150);
  });

  it('and every one of them asks who is calling', () => {
    expect(
      unguarded,
      `مُعالِجاتٌ بلا أيِّ فحصٍ لهويّة المُنادي:\n${unguarded.join('\n')}`
    ).toEqual([]);
  });

  it('and the list of what is open says why', () => {
    for (const [prefix, why] of PUBLIC) {
      expect(why.length, `${prefix}: بلا سبب`).toBeGreaterThan(20);
      // A prefix that matches nothing is a stale exemption.
      expect(files.some((f) => f.startsWith(prefix)), `${prefix}: لا مسارَ تحته`).toBe(true);
    }
  });
});
