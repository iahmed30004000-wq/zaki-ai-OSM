import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import {
  CALL_LINK_TTL_S,
  callLink,
  deskCallIntent,
  intentUrl,
  isPairCode,
  last8,
  newPairCode,
  newSecret,
  pairLink,
  readReading,
  samePhone,
  signCall,
} from './core';

/**
 * «مساعد الاتصال» — THE SERVER WRITES WHAT THE APP ACCEPTS (docs/call-helper/CONTRACT.md v1 + v1.1, PR #198).
 *
 * The app's regexes are copied here from its own files (Links.kt, CallSig.kt), and the signature is computed here a
 * second way, straight from the contract's sentence with node's crypto — not by calling `signCall` and comparing it
 * with itself.
 */

// Links.kt / CallSig.kt, verbatim.
const APP_CODE = /^[A-Za-z0-9_-]{32}$/;
const APP_ORDER = /^[A-Za-z0-9_-]{1,64}$/;
const APP_PHONE = /^[0-9]{6,15}$/;
const APP_KEY = /^[A-Za-z0-9_-]{43,}={0,2}$/;
const APP_SIG = /^[0-9a-f]{64}$/;

/** The contract's formula, by hand: lowercase hex HMAC-SHA256(key = UTF-8 of callKey, message = "<orderId>.<phone>.<exp>"). */
const contractSig = (key: string, orderId: string, phone: string, exp: number) =>
  crypto.createHmac('sha256', Buffer.from(key, 'utf8')).update(Buffer.from(`${orderId}.${phone}.${exp}`, 'utf8')).digest('hex');

// Obviously fake: assembled, never a real key.
const KEY = ['fake', 'call', 'key', 'for', 'tests', 'only'].join('-').padEnd(44, 'x');

describe('what the pairing hands the app', () => {
  it('a code of exactly 32 url-safe characters, different each time', () => {
    const a = newPairCode();
    const b = newPairCode();
    expect(a).toMatch(APP_CODE);
    expect(isPairCode(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it('a token and a callKey of 32 random bytes — 43 base64url characters the app keeps', () => {
    for (let i = 0; i < 20; i++) {
      const s = newSecret();
      expect(s.length).toBeGreaterThanOrEqual(43);
      expect(s).toMatch(APP_KEY);
    }
  });

  it('the pair link carries an origin the app reads back, url-encoded', () => {
    const link = pairLink('https://crm.example.test', 'A'.repeat(32));
    const u = new URL(link);
    expect(u.protocol).toBe('zakicall:');
    expect(u.host).toBe('pair');
    expect(u.searchParams.get('base')).toBe('https://crm.example.test');
    expect(u.searchParams.get('code')).toBe('A'.repeat(32));
  });
});

describe('the call link', () => {
  it('is signed with the contract formula', () => {
    const exp = 1_793_000_000;
    expect(signCall(KEY, 'ord_1-a', '963933123456', exp)).toBe(contractSig(KEY, 'ord_1-a', '963933123456', exp));
    const u = new URL(callLink(KEY, 'ord_1-a', '963933123456', exp));
    expect(u.host).toBe('call');
    expect(u.searchParams.get('order')).toMatch(APP_ORDER);
    expect(u.searchParams.get('phone')).toMatch(APP_PHONE);
    expect(u.searchParams.get('exp')).toBe(String(exp));
    expect(u.searchParams.get('sig')).toMatch(APP_SIG);
    expect(u.searchParams.get('sig')).toBe(contractSig(KEY, 'ord_1-a', '963933123456', exp));
  });

  it('on the desk: an Android intent with the dialler as its fallback, good for twelve hours', () => {
    const now = 1_790_000_000_000;
    const link = deskCallIntent(KEY, 'ord1', '963933123456', now)!;
    const m = /^intent:\/\/(call\?[^#]+)#Intent;scheme=zakicall;package=io\.zakiai\.callhelper;S\.browser_fallback_url=([^;]+);end$/.exec(link);
    expect(m, link).not.toBeNull();
    expect(decodeURIComponent(m![2])).toBe('tel:+963933123456');
    const q = new URLSearchParams(m![1].slice('call?'.length));
    const exp = Number(q.get('exp'));
    expect(exp).toBe(Math.floor(now / 1000) + CALL_LINK_TTL_S);
    // The app dials by itself only when now ≤ exp ≤ now + 24h.
    expect(exp - now / 1000).toBeLessThanOrEqual(24 * 3600);
    expect(q.get('sig')).toBe(contractSig(KEY, 'ord1', '963933123456', exp));
  });

  it('is not made for what the app would refuse — the desk keeps tel: then', () => {
    expect(deskCallIntent(KEY, 'ord1', '', 0)).toBeNull();
    expect(deskCallIntent(KEY, 'ord1', '12345', 0)).toBeNull();
    expect(deskCallIntent(KEY, 'has a space', '963933123456', 0)).toBeNull();
    expect(deskCallIntent(KEY, 'x'.repeat(65), '963933123456', 0)).toBeNull();
  });

  it('the intent wrapper keeps the zakicall link’s host and query as they are', () => {
    expect(intentUrl('zakicall://pair?base=a&code=b', 'https://x.test/p#h')).toBe(
      'intent://pair?base=a&code=b#Intent;scheme=zakicall;package=io.zakiai.callhelper;S.browser_fallback_url=https%3A%2F%2Fx.test%2Fp%23h;end'
    );
  });
});

describe('a reading, as the app posts it', () => {
  const now = 1_790_000_000_000;
  const good = { orderId: 'ord1', phone: '963933123456', startedAt: now - 60_000, answered: true, talkSeconds: 133, ringSeconds: 7 };

  it('is read when every field is there and within reason', () => {
    expect(readReading(good, now)).toEqual(good);
    expect(readReading({ ...good, answered: false, talkSeconds: 0, ringSeconds: 25 }, now)).not.toBeNull();
  });

  it('and refused when a number is out of range or of the wrong kind', () => {
    for (const bad of [
      { talkSeconds: -1 },
      { talkSeconds: 4 * 3600 + 1 },
      { ringSeconds: 601 },
      { ringSeconds: 2.5 },
      { talkSeconds: '10' },
      { answered: 'yes' },
      { startedAt: now - 24 * 3600 * 1000 - 1 },
      { startedAt: now + 5 * 60 * 1000 + 1 },
      { phone: '+963933123456' },
      { orderId: '' },
    ]) {
      expect(readReading({ ...good, ...bad }, now), JSON.stringify(bad)).toBeNull();
    }
    expect(readReading(null, now)).toBeNull();
  });

  it('matches the customer on the last eight digits, whatever spelling the order holds', () => {
    expect(samePhone('963933123456', '0933 123 456')).toBe(true);
    expect(samePhone('963933123456', '+963-933-123-456')).toBe(true);
    expect(samePhone('963933123456', '٠٩٣٣١٢٣٤٥٦')).toBe(true);
    expect(samePhone('963933123456', '0933123457')).toBe(false);
    expect(samePhone('963933123456', '')).toBe(false);
    expect(last8('00963933123456')).toBe('33123456');
  });
});
