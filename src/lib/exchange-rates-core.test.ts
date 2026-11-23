import { describe, expect, it } from 'vitest';
import {
  NEVER_FROM_A_SOURCE,
  STALE_SENTENCE,
  effectiveRate,
  equivalentOf,
  isStale,
  kindWord,
  mayTryNow,
  missingRateSentence,
  readFiatAnswer,
  readUsdtAnswer,
  type AutoRates,
  type ManualRates,
} from './exchange-rates-core';

/**
 * «سعر الصرف التلقائي» (23/11, F8) — THE SIX RULES OF A RATE, AND THE TWO SOURCES' ANSWERS READ STRICTLY.
 * Every expected figure below is worked by hand in its comment; none is computed with the function under test.
 */

const NOW = new Date('2026-11-23T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();

const AUTO: AutoRates = {
  attemptedAt: at(DAY / 2),
  fiat: { source: 'open.er-api.com', asOf: at(DAY / 2), fetchedAt: at(DAY / 2), perUsd: { JOD: 0.709, EGP: 48, EUR: 0.9 } },
  usdt: { source: 'api.kraken.com', asOf: at(DAY / 2), fetchedAt: at(DAY / 2), usdPerUnit: 0.998 },
};
const NONE: ManualRates = { rates: {} };

describe('the six rules', () => {
  it('USD is 1 and FIXED — with no source, no table at all, and even when the owner typed something for it', () => {
    expect(effectiveRate('USD', undefined, undefined, NOW)).toMatchObject({ perUsd: 1, kind: 'FIXED', stale: false });
    expect(effectiveRate('usd', AUTO, { rates: { USD: { perUsd: 3, at: at(0) } } }, NOW)).toMatchObject({ perUsd: 1, kind: 'FIXED' });
  });

  it('USDT comes from its source and is NOT 1: 0.998 $ a coin → 1/0.998 coins a dollar', () => {
    const r = effectiveRate('USDT', AUTO, NONE, NOW)!;
    expect(r.kind).toBe('AUTO');
    expect(r.source).toBe('api.kraken.com');
    expect(r.perUsd).toBeCloseTo(1.002004, 6);
    expect(r.perUsd).not.toBe(1);
  });

  it('NEGATIVE: USDT with no crypto answer has NO rate — never a silent 1', () => {
    expect(effectiveRate('USDT', { ...AUTO, usdt: undefined }, NONE, NOW)).toBeNull();
    expect(effectiveRate('USDT', undefined, NONE, NOW)).toBeNull();
  });

  it('JOD comes from the fiat source', () => {
    expect(effectiveRate('JOD', AUTO, NONE, NOW)).toMatchObject({ perUsd: 0.709, kind: 'AUTO', source: 'open.er-api.com' });
  });

  it('NEGATIVE: SYP is never taken from a source — even a table that somehow carries it', () => {
    const poisoned: AutoRates = { ...AUTO, fiat: { ...AUTO.fiat!, perUsd: { ...AUTO.fiat!.perUsd, SYP: 13002 } } };
    expect(effectiveRate('SYP', poisoned, NONE, NOW)).toBeNull();
    expect(NEVER_FROM_A_SOURCE).toContain('SYP');
  });

  it('SYP from the owner’s typed rate only', () => {
    expect(effectiveRate('SYP', AUTO, { rates: { SYP: { perUsd: 13000, at: at(DAY * 30) } } }, NOW)).toMatchObject({
      perUsd: 13000,
      kind: 'MANUAL',
      stale: false,
    });
  });

  it('a code neither source knows behaves like SYP: nothing, then the owner’s rate', () => {
    expect(effectiveRate('XYZ', AUTO, NONE, NOW)).toBeNull();
    expect(effectiveRate('XYZ', AUTO, { rates: { XYZ: { perUsd: 7, at: at(0) } } }, NOW)).toMatchObject({ perUsd: 7, kind: 'MANUAL' });
  });

  it('the manual override wins over the automatic rate — for a fiat code and for USDT', () => {
    const manual: ManualRates = { rates: { JOD: { perUsd: 0.71, at: at(0) }, USDT: { perUsd: 1, at: at(0) } } };
    expect(effectiveRate('JOD', AUTO, manual, NOW)).toMatchObject({ perUsd: 0.71, kind: 'MANUAL' });
    expect(effectiveRate('USDT', AUTO, manual, NOW)).toMatchObject({ perUsd: 1, kind: 'MANUAL' });
  });

  it('NEGATIVE: a broken typed rate (0, negative, not a number) is no rate — the automatic one stands', () => {
    for (const bad of [0, -2, Number.NaN, Infinity]) {
      expect(effectiveRate('JOD', AUTO, { rates: { JOD: { perUsd: bad, at: at(0) } } }, NOW)?.kind, String(bad)).toBe('AUTO');
    }
  });
});

describe('freshness', () => {
  it('older than three days is flagged; three days or less is not', () => {
    expect(isStale(at(3 * DAY + 1000), NOW)).toBe(true);
    expect(isStale(at(3 * DAY - 1000), NOW)).toBe(false);
    expect(isStale(null, NOW)).toBe(true);
    const old: AutoRates = { ...AUTO, fiat: { ...AUTO.fiat!, asOf: at(4 * DAY) } };
    expect(effectiveRate('JOD', old, NONE, NOW)).toMatchObject({ perUsd: 0.709, stale: true });
    expect(STALE_SENTENCE).toBe('السعر أقدم من 3 أيام — ما قدرنا نجيب سعر جديد من الإنترنت');
  });

  it('a stale rate is still USED (a failed fetch keeps the last value) and the equivalent carries the flag', () => {
    const old: AutoRates = { ...AUTO, fiat: { ...AUTO.fiat!, asOf: at(5 * DAY) } };
    const e = equivalentOf(100, 'JOD', 'USD', 2, old, NONE, NOW);
    expect(e).toMatchObject({ ok: true, stale: true });
  });

  it('once a day: a try 23 h ago blocks, 24 h ago allows, never tried allows', () => {
    expect(mayTryNow({ attemptedAt: at(23 * 60 * 60 * 1000) }, NOW)).toBe(false);
    expect(mayTryNow({ attemptedAt: at(DAY) }, NOW)).toBe(true);
    expect(mayTryNow(undefined, NOW)).toBe(true);
  });
});

describe('what a draw comes to in the store’s currency', () => {
  it('100 JOD in a USD store at 0.709 JOD a dollar → 100 / 0.709 = 141.043… → 141.04', () => {
    expect(equivalentOf(100, 'JOD', 'USD', 2, AUTO, NONE, NOW)).toMatchObject({ ok: true, value: 141.04, kind: 'AUTO' });
  });

  it('1,300,000 SYP in a USD store at the owner’s 13,000 → exactly 100.00, kind MANUAL', () => {
    const e = equivalentOf(1_300_000, 'SYP', 'USD', 2, AUTO, { rates: { SYP: { perUsd: 13000, at: at(0) } } }, NOW);
    expect(e).toMatchObject({ ok: true, value: 100, kind: 'MANUAL' });
  });

  it('500 USDT in a USD store at 0.998 $ a coin → 499.00 (not 500)', () => {
    expect(equivalentOf(500, 'USDT', 'USD', 2, AUTO, NONE, NOW)).toMatchObject({ ok: true, value: 499 });
  });

  it('100 USD in a JOD store (3 decimals) → 70.900', () => {
    expect(equivalentOf(100, 'USD', 'JOD', 3, AUTO, NONE, NOW)).toMatchObject({ ok: true, value: 70.9 });
  });

  it('48 EGP in a JOD store crosses the dollar: 48 × 0.709 / 48 = 0.709', () => {
    expect(equivalentOf(48, 'EGP', 'JOD', 3, AUTO, NONE, NOW)).toMatchObject({ ok: true, value: 0.709 });
  });

  it('NEGATIVE: no SYP rate → no figure and the owner’s sentence', () => {
    expect(equivalentOf(1_300_000, 'SYP', 'USD', 2, AUTO, NONE, NOW)).toEqual({
      ok: false,
      missing: ['SYP'],
      sentence: 'ما في سعر — اكتب سعر الليرة بالإعدادات',
    });
  });

  it('NEGATIVE: a USDT fetch that never succeeded → no figure (never 1:1)', () => {
    const e = equivalentOf(500, 'USDT', 'USD', 2, { ...AUTO, usdt: undefined }, NONE, NOW);
    expect(e).toMatchObject({ ok: false, missing: ['USDT'] });
  });

  it('the sentence for another currency, and for two', () => {
    expect(missingRateSentence(['XYZ'])).toBe('ما في سعر — اكتب سعر XYZ بالإعدادات');
    expect(missingRateSentence(['XYZ', 'SYP'])).toBe('ما في سعر — اكتب سعر XYZ وSYP بالإعدادات');
  });

  it('the words of a kind', () => {
    expect([kindWord('AUTO'), kindWord('MANUAL'), kindWord('FIXED')]).toEqual(['تلقائي', 'يدوي', 'ثابت']);
  });
});

describe('the sources’ answers', () => {
  it('the fiat answer: rates per dollar, SYP and USD dropped, the source’s own date kept', () => {
    const r = readFiatAnswer({ result: 'success', base_code: 'USD', time_last_update_unix: 1795392152, rates: { USD: 1, JOD: 0.709, SYP: 13002, eur: 0.9, BAD: 'x' } });
    expect(r).toEqual({ asOf: new Date(1795392152 * 1000).toISOString(), perUsd: { JOD: 0.709, EUR: 0.9 } });
  });

  it('NEGATIVE: an answer that is not a success, or on another base, is refused', () => {
    expect(readFiatAnswer({ result: 'error', base_code: 'USD', rates: { JOD: 0.7 } })).toBeNull();
    expect(readFiatAnswer({ result: 'success', base_code: 'EUR', rates: { JOD: 0.7 } })).toBeNull();
    expect(readFiatAnswer(null)).toBeNull();
    expect(readFiatAnswer({ result: 'success', base_code: 'USD', rates: { SYP: 13000 } })).toBeNull();
  });

  it('the USDT answer: the last trade price', () => {
    expect(readUsdtAnswer({ error: [], result: { USDTZUSD: { c: ['0.99877000', '522.4'] } } })).toBe(0.99877);
  });

  it('NEGATIVE: an error, a price far from a dollar, or garbage is refused', () => {
    expect(readUsdtAnswer({ error: ['EQuery:Unknown asset pair'], result: {} })).toBeNull();
    expect(readUsdtAnswer({ error: [], result: { USDTZUSD: { c: ['3.1'] } } })).toBeNull();
    expect(readUsdtAnswer({ error: [], result: { USDTZUSD: { c: ['abc'] } } })).toBeNull();
    expect(readUsdtAnswer('nope')).toBeNull();
  });
});
