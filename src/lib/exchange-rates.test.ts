import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «سعر الصرف التلقائي» (23/11, F8) — THE ONE OUTBOUND CALL, ON AN IN-MEMORY SETTINGS ROW.
 *
 * `fetch` is ALWAYS injected: a call that reached the global one fails this file (it is replaced by a spy that throws). What is held:
 * the two addresses are fixed and carry nothing of the business (no body, only `accept`, a timeout); once a day, success or not; a
 * source that fails keeps its last good value and is noted; SYP is never stored even when the source lists it.
 */

const { store } = vi.hoisted(() => ({ store: { system: new Map<string, unknown>(), company: new Map<string, Record<string, unknown>>() } }));

vi.mock('./db', () => ({
  db: {
    company: {
      findUnique: async ({ where }: { where: { id: string } }) => ({ settings: JSON.stringify(store.company.get(where.id) ?? {}) }),
    },
  },
}));
vi.mock('./system-settings', () => ({
  readSystemSetting: async (key: string) => structuredClone(store.system.get(key)),
  updateSystemSetting: async (key: string, change: (c: unknown) => unknown) => {
    const next = change(structuredClone(store.system.get(key)));
    if (next === undefined) store.system.delete(key);
    else store.system.set(key, structuredClone(next));
    return next;
  },
}));
vi.mock('./company-settings', () => ({
  updateCompanySettings: async (companyId: string, key: string, change: (c: unknown) => unknown) => {
    const all = store.company.get(companyId) ?? {};
    const next = change(structuredClone(all[key]));
    store.company.set(companyId, { ...all, [key]: next });
    return next;
  },
}));

import { AUTO_KEY, FETCH_TIMEOUT_MS, readRateTable, refreshExchangeRates, saveManualRates } from './exchange-rates';
import { FIAT_SOURCE, USDT_SOURCE, effectiveRate, type AutoRates } from './exchange-rates-core';

const NOW = new Date('2026-11-23T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const later = (h: number) => new Date(NOW.getTime() + h * HOUR);

const FIAT_OK = { result: 'success', base_code: 'USD', time_last_update_unix: Math.floor(NOW.getTime() / 1000) - 3600, rates: { USD: 1, JOD: 0.709, SYP: 13002, EGP: 48 } };
const USDT_OK = { error: [], result: { USDTZUSD: { c: ['0.99877000', '1'] } } };

type Call = { url: string; init: RequestInit };
function fakeFetch(answers: { fiat: unknown | Error; usdt: unknown | Error }) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const a = url === FIAT_SOURCE.url ? answers.fiat : url === USDT_SOURCE.url ? answers.usdt : new Error(`unexpected ${url}`);
    if (a instanceof Error) throw a;
    return { ok: true, status: 200, json: async () => a } as unknown as Response;
  });
  return { impl, calls };
}

beforeEach(() => {
  store.system.clear();
  store.company.clear();
  // NEGATIVE BY CONSTRUCTION: the real network is never reached from this file.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('the network was reached'); }));
});

describe('the request carries no business data', () => {
  it('two fixed GET addresses — only the base «USD» and the pair «USDTUSD» — no body, only `accept`, with a timeout', async () => {
    const { impl, calls } = fakeFetch({ fiat: FIAT_OK, usdt: USDT_OK });
    await refreshExchangeRates({ now: NOW, fetchImpl: impl });
    expect(calls.map((c) => c.url).sort()).toEqual(['https://api.kraken.com/0/public/Ticker?pair=USDTUSD', 'https://open.er-api.com/v6/latest/USD']);
    for (const c of calls) {
      expect(c.init.method).toBe('GET');
      expect(c.init.body).toBeUndefined();
      expect(c.init.headers).toEqual({ accept: 'application/json' });
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
      // Nothing of a company, a store, a person or an order rides in the address.
      expect(new URL(c.url).search).toMatch(/^(\?pair=USDTUSD)?$/);
    }
    expect(FETCH_TIMEOUT_MS).toBe(5000);
  });

  it('NEGATIVE: the global fetch is never touched when one is injected', async () => {
    const { impl } = fakeFetch({ fiat: FIAT_OK, usdt: USDT_OK });
    await refreshExchangeRates({ now: NOW, fetchImpl: impl });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('what is stored', () => {
  it('a good fetch stores both sides with their sources and dates; SYP is dropped even though the source listed it', async () => {
    const { impl } = fakeFetch({ fiat: FIAT_OK, usdt: USDT_OK });
    expect(await refreshExchangeRates({ now: NOW, fetchImpl: impl })).toEqual({ tried: true, fiat: 'ok', usdt: 'ok' });
    const row = store.system.get(AUTO_KEY) as AutoRates;
    expect(row.fiat).toMatchObject({ source: 'open.er-api.com', perUsd: { JOD: 0.709, EGP: 48 } });
    expect(row.fiat!.perUsd).not.toHaveProperty('SYP');
    expect(row.usdt).toMatchObject({ source: 'api.kraken.com', usdPerUnit: 0.99877, fetchedAt: NOW.toISOString() });
    expect(row.attemptedAt).toBe(NOW.toISOString());
  });

  it('at most once a day: a second run 23 h later goes nowhere; 24 h later it goes again', async () => {
    const { impl } = fakeFetch({ fiat: FIAT_OK, usdt: USDT_OK });
    await refreshExchangeRates({ now: NOW, fetchImpl: impl });
    expect(await refreshExchangeRates({ now: later(23), fetchImpl: impl })).toEqual({ tried: false, fiat: 'skipped', usdt: 'skipped' });
    expect(impl).toHaveBeenCalledTimes(2);
    await refreshExchangeRates({ now: later(24), fetchImpl: impl });
    expect(impl).toHaveBeenCalledTimes(4);
  });

  it('NEGATIVE: a fiat fetch that fails keeps the LAST stored value and says why; the USDT side still updates', async () => {
    await refreshExchangeRates({ now: NOW, fetchImpl: fakeFetch({ fiat: FIAT_OK, usdt: USDT_OK }).impl });
    const before = (store.system.get(AUTO_KEY) as AutoRates).fiat;
    const usdt2 = { error: [], result: { USDTZUSD: { c: ['0.99500000'] } } };
    const out = await refreshExchangeRates({ now: later(25), fetchImpl: fakeFetch({ fiat: new Error('timeout'), usdt: usdt2 }).impl });
    expect(out).toEqual({ tried: true, fiat: 'failed', usdt: 'ok' });
    const row = store.system.get(AUTO_KEY) as AutoRates;
    expect(row.fiat).toEqual(before);
    expect(row.usdt!.usdPerUnit).toBe(0.995);
    expect(row.failed).toEqual({ fiat: 'timeout' });
  });

  it('NEGATIVE: a USDT fetch that fails keeps the last USDT price — and with none ever stored, USDT has no rate (never 1)', async () => {
    await refreshExchangeRates({ now: NOW, fetchImpl: fakeFetch({ fiat: FIAT_OK, usdt: new Error('HTTP 503') }).impl });
    let row = store.system.get(AUTO_KEY) as AutoRates;
    expect(row.usdt).toBeUndefined();
    expect(effectiveRate('USDT', row, undefined, NOW)).toBeNull();

    await refreshExchangeRates({ now: later(24), fetchImpl: fakeFetch({ fiat: FIAT_OK, usdt: USDT_OK }).impl });
    await refreshExchangeRates({ now: later(48), fetchImpl: fakeFetch({ fiat: FIAT_OK, usdt: { error: [], result: { USDTZUSD: { c: ['9'] } } } }).impl });
    row = store.system.get(AUTO_KEY) as AutoRates;
    expect(row.usdt!.usdPerUnit).toBe(0.99877);
    expect(row.failed?.usdt).toBe('جواب غير مفهوم');
  });

  it('a failure is cleared by that source’s next success', async () => {
    await refreshExchangeRates({ now: NOW, fetchImpl: fakeFetch({ fiat: new Error('x'), usdt: USDT_OK }).impl });
    await refreshExchangeRates({ now: later(24), fetchImpl: fakeFetch({ fiat: FIAT_OK, usdt: USDT_OK }).impl });
    expect((store.system.get(AUTO_KEY) as AutoRates).failed).toEqual({});
  });
});

describe('the owner’s rates', () => {
  it('are saved per company, a null removes one, and the other company sees nothing', async () => {
    await saveManualRates('c1', [{ code: 'syp', perUsd: 13000 }, { code: 'JOD', perUsd: 0.71 }], 'u1', NOW);
    expect((await readRateTable('c1')).manual.rates).toMatchObject({ SYP: { perUsd: 13000, byId: 'u1' }, JOD: { perUsd: 0.71 } });
    await saveManualRates('c1', [{ code: 'JOD', perUsd: null }], 'u1', NOW);
    expect(Object.keys((await readRateTable('c1')).manual.rates)).toEqual(['SYP']);
    expect((await readRateTable('c2')).manual.rates).toEqual({});
  });
});
