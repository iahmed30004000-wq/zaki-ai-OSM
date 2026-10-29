import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A STRANGER MUST NOT BE ABLE TO SHUT THE STAFF OUT OF THE SIGN-IN.
 *
 * Until `TRUST_PROXY` is on, every caller is the same address, and a
 * per-address bucket is then one bucket for the whole company. The sign-in
 * doors therefore count their address buckets through `rateLimitByIp`,
 * which loosens the ceiling for an unknown address (behaviour proven in
 * `src/lib/rate-limit.test.ts`). This pins that the doors really call it,
 * and that nobody quietly goes back to a bare per-address key.
 * ═══════════════════════════════════════════════════════════════════════
 */

const DOORS: Array<{ file: string; scope: string }> = [
  { file: 'login/route.ts', scope: 'login:ip' },
  { file: '2fa/start/route.ts', scope: '2fa:start' },
  { file: '2fa/enrol/route.ts', scope: '2fa:enrol' },
  { file: '2fa/verify/route.ts', scope: '2fa:verify:ip' },
  { file: 'passkey/login/route.ts', scope: 'passkey-login' },
  { file: 'passkey/assert/route.ts', scope: 'passkey:ip' },
];

const source = (file: string) => readFileSync(path.join(__dirname, file), 'utf8');

/** Every `rateLimit(` call whose key is built from the caller's address. */
const bareAddressKeys = (text: string) =>
  [...text.matchAll(/\brateLimit\(\s*`([^`]*\$\{ip\}[^`]*)`/g)].map((m) => m[1]);

describe('each sign-in door counts its address bucket through rateLimitByIp', () => {
  for (const { file, scope } of DOORS) {
    it(file, () => {
      const text = source(file);
      expect(text).toContain(`rateLimitByIp('${scope}', ip,`);
    });

    it(`${file} has no bare per-address key left (the account+address one aside)`, () => {
      const left = bareAddressKeys(source(file)).filter((k) => !k.startsWith('login:user:'));
      expect(left).toEqual([]);
    });
  }
});

describe('and the detector itself sees what it is meant to', () => {
  it('finds a bare per-address key', () => {
    expect(bareAddressKeys('const rl = rateLimit(`2fa:start:${ip}`, 10, 1000);')).toEqual(['2fa:start:${ip}']);
  });

  it('finds one spread over several lines', () => {
    expect(bareAddressKeys('rateLimit(\n  `login:ip:${ip}`, 20, 1000)')).toEqual(['login:ip:${ip}']);
  });

  it('does not mistake a per-account key for a per-address one', () => {
    expect(bareAddressKeys('rateLimit(`passkey:user:${ticket.userId}`, 10, 1000)')).toEqual([]);
  });
});
