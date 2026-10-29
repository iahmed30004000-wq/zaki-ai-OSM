import { afterEach, describe, expect, it } from 'vitest';
import { UNKNOWN_IP, UNKNOWN_IP_FACTOR, getClientIp, rateLimit, rateLimitByIp } from './rate-limit';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * WHO IS CALLING — AND WHAT HAPPENS WHEN WE CANNOT SAY.
 *
 * Two holes sat in `getClientIp`:
 *
 *   · behind a trusted proxy it read the FIRST entry of X-Forwarded-For,
 *     which is the one the CLIENT wrote. Turning `TRUST_PROXY` on would have
 *     given every caller a fresh bucket per request.
 *   · without it everybody shared one bucket, so twenty requests from a
 *     stranger locked every employee out of the sign-in for five minutes.
 *
 * Each rule below is written so that putting the old behaviour back turns
 * one of them red.
 * ═══════════════════════════════════════════════════════════════════════
 */

const ORIGINAL = { proxy: process.env.TRUST_PROXY, hops: process.env.TRUST_PROXY_HOPS };

afterEach(() => {
  if (ORIGINAL.proxy === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = ORIGINAL.proxy;
  if (ORIGINAL.hops === undefined) delete process.env.TRUST_PROXY_HOPS;
  else process.env.TRUST_PROXY_HOPS = ORIGINAL.hops;
});

const req = (headers: Record<string, string>) => new Request('http://localhost/x', { headers });

describe('without a trusted proxy, the headers are not believed', () => {
  it('every caller is the shared unknown address, whatever they send', () => {
    delete process.env.TRUST_PROXY;
    expect(getClientIp(req({ 'x-forwarded-for': '203.0.113.7' }))).toBe(UNKNOWN_IP);
    expect(getClientIp(req({ 'x-real-ip': '203.0.113.7' }))).toBe(UNKNOWN_IP);
    expect(getClientIp(req({}))).toBe(UNKNOWN_IP);
  });

  it('and only the exact word "true" turns trust on', () => {
    for (const v of ['1', 'yes', 'TRUE', 'false', '']) {
      process.env.TRUST_PROXY = v;
      expect(getClientIp(req({ 'x-forwarded-for': '203.0.113.7' })), v).toBe(UNKNOWN_IP);
    }
  });

  it('keeps the word the local and test code already compares against', () => {
    expect(UNKNOWN_IP).toBe('local');
  });
});

describe('behind a trusted proxy, the address is the one OUR proxy wrote', () => {
  it('the last entry, not the first', () => {
    process.env.TRUST_PROXY = 'true';
    expect(getClientIp(req({ 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7');
    expect(getClientIp(req({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('a client cannot buy a fresh bucket by inventing a left-hand entry', () => {
    process.env.TRUST_PROXY = 'true';
    const keys = new Set(
      ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4'].map((fake) =>
        getClientIp(req({ 'x-forwarded-for': `${fake}, 203.0.113.7` }))
      )
    );
    expect([...keys]).toEqual(['203.0.113.7']);
  });

  it('two real visitors still get two buckets', () => {
    process.env.TRUST_PROXY = 'true';
    const a = getClientIp(req({ 'x-forwarded-for': '203.0.113.7' }));
    const b = getClientIp(req({ 'x-forwarded-for': '203.0.113.8' }));
    expect(a).not.toBe(b);
  });

  it('counts from the right by the number of proxies in front, and no further', () => {
    process.env.TRUST_PROXY = 'true';
    process.env.TRUST_PROXY_HOPS = '2';
    expect(getClientIp(req({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7, 172.18.0.2' }))).toBe('203.0.113.7');
    // Fewer entries than proxies we expect: something is not as configured.
    expect(getClientIp(req({ 'x-forwarded-for': '203.0.113.7' }))).toBe(UNKNOWN_IP);
  });

  it('a hop count that is not a small whole number is read as one', () => {
    process.env.TRUST_PROXY = 'true';
    for (const v of ['0', '-1', '2.5', 'abc', '99', '']) {
      process.env.TRUST_PROXY_HOPS = v;
      expect(getClientIp(req({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7' })), v).toBe('203.0.113.7');
    }
  });

  it('a missing header, a blank entry or a non-address falls to the shared bucket, never to a guess', () => {
    process.env.TRUST_PROXY = 'true';
    expect(getClientIp(req({}))).toBe(UNKNOWN_IP);
    // X-Real-IP alone is what a request that skipped the proxy looks like.
    expect(getClientIp(req({ 'x-real-ip': '203.0.113.7' }))).toBe(UNKNOWN_IP);
    expect(getClientIp(req({ 'x-forwarded-for': '203.0.113.7, ' }))).toBe(UNKNOWN_IP);
    expect(getClientIp(req({ 'x-forwarded-for': '203.0.113.7, <script>' }))).toBe(UNKNOWN_IP);
    expect(getClientIp(req({ 'x-forwarded-for': '999.1.1.1' }))).toBe(UNKNOWN_IP);
    expect(getClientIp(req({ 'x-forwarded-for': 'unknown' }))).toBe(UNKNOWN_IP);
  });

  it('takes the port off, and unwraps the bracketed IPv6 form', () => {
    process.env.TRUST_PROXY = 'true';
    expect(getClientIp(req({ 'x-forwarded-for': '203.0.113.7:51234' }))).toBe('203.0.113.7');
    expect(getClientIp(req({ 'x-forwarded-for': '[2001:db8:1:2:3:4:5:6]:443' }))).toBe('2001:db8:1:2::/64');
  });

  it('keys an IPv6 caller by its /64, so rotating the low bits buys nothing', () => {
    process.env.TRUST_PROXY = 'true';
    const a = getClientIp(req({ 'x-forwarded-for': '2001:db8:1:2:aaaa:bbbb:cccc:dddd' }));
    const b = getClientIp(req({ 'x-forwarded-for': '2001:0db8:0001:0002::1' }));
    const c = getClientIp(req({ 'x-forwarded-for': '2001:db8:1:3::1' }));
    expect(a).toBe('2001:db8:1:2::/64');
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(getClientIp(req({ 'x-forwarded-for': '::1' }))).toBe('0:0:0:0::/64');
  });

  it('reads an IPv4-mapped IPv6 address as the IPv4 it is', () => {
    process.env.TRUST_PROXY = 'true';
    expect(getClientIp(req({ 'x-forwarded-for': '::ffff:203.0.113.7' }))).toBe('203.0.113.7');
  });
});

describe('the sign-in doors do not hand a stranger a switch', () => {
  const window5 = 5 * 60 * 1000;

  it('a known address is limited exactly as before: twenty, then refused', () => {
    const results = Array.from({ length: 21 }, () => rateLimitByIp('t-known', '203.0.113.7', 20, window5));
    expect(results.slice(0, 20).every((r) => r.allowed)).toBe(true);
    expect(results[20].allowed).toBe(false);
  });

  it('and one address being refused does not touch another', () => {
    for (let i = 0; i < 25; i += 1) rateLimitByIp('t-two', '203.0.113.7', 20, window5);
    expect(rateLimitByIp('t-two', '203.0.113.7', 20, window5).allowed).toBe(false);
    expect(rateLimitByIp('t-two', '203.0.113.8', 20, window5).allowed).toBe(true);
  });

  it('when the address is unknown, twenty requests from a stranger do NOT lock everyone out', () => {
    // The old behaviour: the 21st request on the shared bucket was refused,
    // for every employee at once.
    for (let i = 0; i < 20; i += 1) rateLimitByIp('t-unknown', UNKNOWN_IP, 20, window5);
    expect(rateLimitByIp('t-unknown', UNKNOWN_IP, 20, window5).allowed).toBe(true);
  });

  it('the ceiling is five times, not more: a hundred a window for the sign-in door, so one password cannot be sprayed over many emails', () => {
    expect(UNKNOWN_IP_FACTOR).toBe(5);
    const results = Array.from({ length: 101 }, () => rateLimitByIp('t-spray', UNKNOWN_IP, 20, window5));
    expect(results.filter((r) => r.allowed)).toHaveLength(100);
  });

  it('but a flood on the unknown address is still stopped, at the looser ceiling', () => {
    const ceiling = 20 * UNKNOWN_IP_FACTOR;
    let refusedAt = 0;
    for (let i = 1; i <= ceiling + 1; i += 1) {
      if (!rateLimitByIp('t-flood', UNKNOWN_IP, 20, window5).allowed) {
        refusedAt = i;
        break;
      }
    }
    expect(refusedAt).toBe(ceiling + 1);
  });

  it('shares its counters with the plain limiter under the same key, so nothing is counted twice', () => {
    rateLimitByIp('t-same', '203.0.113.9', 2, window5);
    rateLimitByIp('t-same', '203.0.113.9', 2, window5);
    expect(rateLimit('t-same:203.0.113.9', 2, window5).allowed).toBe(false);
  });
});
