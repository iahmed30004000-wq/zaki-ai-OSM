import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «واتساب بعد لا يرد» — where the choice lives (`Company.settings.whatsappAfterNoAnswer`), and AGENT unless it is plainly
 * COMPANY.
 */

const { store, conn, db } = vi.hoisted(() => {
  const store = { doc: {} as Record<string, unknown>, failRead: false, raw: null as string | null };
  const conn = { row: null as null | { id: string }, status: 'NEEDS_SETUP' as 'CONNECTED' | 'NEEDS_SETUP' };
  const db = {
    company: {
      findUnique: vi.fn(async () => {
        if (store.failRead) throw new Error('db down');
        return { settings: store.raw ?? JSON.stringify(store.doc) };
      }),
    },
  };
  return { store, conn, db };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('./connection', () => ({
  getActiveConnection: vi.fn(async () => conn.row),
  effectiveStatus: (row: unknown) => (row ? conn.status : 'NEEDS_SETUP'),
}));
vi.mock('../company-settings', () => ({
  updateCompanySettings: async (_c: string, key: string, change: (cur: unknown) => unknown) => {
    const next = change(store.doc[key]);
    store.doc[key] = next;
    return next;
  },
}));

import {
  AFTER_NO_ANSWER_DEFAULT,
  afterNoAnswer,
  companySendsFor,
  forgetAfterNoAnswer,
  parseAfterNoAnswer,
  routeFor,
  saveAfterNoAnswer,
  templateBodyValues,
  validateAfterNoAnswer,
} from './after-no-answer';

beforeEach(() => {
  vi.clearAllMocks();
  store.doc = { winback: { coolingDays: 14 } };
  store.failRead = false;
  store.raw = null;
  conn.row = null;
  conn.status = 'NEEDS_SETUP';
  forgetAfterNoAnswer();
});

describe('reading the setting', () => {
  it('missing — AGENT for every country, no template', async () => {
    const s = await afterNoAnswer(db as never, 'c1');
    expect(s).toEqual(AFTER_NO_ANSWER_DEFAULT);
    expect(routeFor(s, '962')).toBe('AGENT');
    expect(routeFor(s, '963')).toBe('AGENT');
    expect(routeFor(s, null)).toBe('AGENT');
  });

  it('garbage — AGENT everywhere, piece by piece', () => {
    for (const raw of [null, 'COMPANY', 7, [], { byDialCode: 'COMPANY' }, { byDialCode: { '962': 'company', '963': true, '0x': 'COMPANY' } }]) {
      const s = parseAfterNoAnswer(raw);
      expect(routeFor(s, '962'), JSON.stringify(raw)).toBe('AGENT');
      expect(routeFor(s, '963'), JSON.stringify(raw)).toBe('AGENT');
    }
    const bad = parseAfterNoAnswer({ templateName: 'Has Spaces', templateLang: 'arabic', templateParams: 'phone' });
    expect(bad).toMatchObject({ templateName: '', templateLang: 'ar', templateParams: 'none' });
  });

  it('a broken document and a read that FAILS are AGENT, never COMPANY', async () => {
    store.raw = '{not json';
    expect(routeFor(await afterNoAnswer(db as never, 'c1'), '962')).toBe('AGENT');
    forgetAfterNoAnswer();
    store.raw = null;
    store.doc.whatsappAfterNoAnswer = { byDialCode: { '962': 'COMPANY' }, templateName: 'x' };
    store.failRead = true;
    expect(routeFor(await afterNoAnswer(db as never, 'c1'), '962')).toBe('AGENT');
  });

  it('valid values pass — Jordan on the company, Syria on the agent', async () => {
    store.doc.whatsappAfterNoAnswer = {
      byDialCode: { '962': 'COMPANY', '963': 'AGENT' },
      templateName: 'no_answer_followup',
      templateLang: 'en_US',
      templateParams: 'name_order',
    };
    const s = await afterNoAnswer(db as never, 'c1');
    expect(s).toEqual({
      byDialCode: { '962': 'COMPANY', '963': 'AGENT' },
      templateName: 'no_answer_followup',
      templateLang: 'en_US',
      templateParams: 'name_order',
    });
    expect(routeFor(s, '962')).toBe('COMPANY');
    expect(routeFor(s, '963')).toBe('AGENT');
    expect(routeFor(s, '966')).toBe('AGENT');
  });

  it('is read once in a while, not once per press', async () => {
    await afterNoAnswer(db as never, 'c1', 1_000);
    await afterNoAnswer(db as never, 'c1', 5_000);
    expect(db.company.findUnique).toHaveBeenCalledTimes(1);
    await afterNoAnswer(db as never, 'c1', 12_000);
    expect(db.company.findUnique).toHaveBeenCalledTimes(2);
  });
});

describe('saving it', () => {
  it('a valid body is saved under its own key only, and heard at once', async () => {
    const v = validateAfterNoAnswer({ byDialCode: { '962': 'COMPANY' }, templateName: ' no_answer ', templateLang: 'ar', templateParams: 'name' });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    await saveAfterNoAnswer('c1', v.value);
    expect(store.doc.winback).toEqual({ coolingDays: 14 });
    expect(routeFor(await afterNoAnswer(db as never, 'c1'), '962')).toBe('COMPANY');
    expect((await afterNoAnswer(db as never, 'c1')).templateName).toBe('no_answer');
  });

  it('a body it cannot read is refused in Arabic, not quietly turned into the default', () => {
    for (const body of [
      null,
      { byDialCode: { '962': 'company' } },
      { byDialCode: { abc: 'AGENT' } },
      { templateName: 'Not Allowed' },
      { templateLang: 'arabic' },
      { templateParams: 'phone' },
      { byDialCode: {}, extra: 1 },
    ]) {
      const v = validateAfterNoAnswer(body);
      expect(v.ok, JSON.stringify(body)).toBe(false);
      if (!v.ok) expect(v.errorAr).toMatch(/[؀-ۿ]/);
    }
  });
});

describe('what fills the template', () => {
  it('nothing, the name, or the name then the order number', () => {
    expect(templateBodyValues('none', { customerName: 'سارة', orderNumber: 'ORD-1' })).toEqual([]);
    expect(templateBodyValues('name', { customerName: 'سارة', orderNumber: 'ORD-1' })).toEqual(['سارة']);
    expect(templateBodyValues('name_order', { customerName: 'سارة', orderNumber: 'ORD-1' })).toEqual(['سارة', 'ORD-1']);
    // Meta refuses an empty parameter: a blank name is never sent blank.
    expect(templateBodyValues('name', { customerName: '  ', orderNumber: 'ORD-1' })[0]).not.toBe('');
  });
});

describe('will the sheet offer the company number', () => {
  const company = { byDialCode: { '962': 'COMPANY' }, templateName: 'no_answer', templateLang: 'ar', templateParams: 'none' };

  it('only with COMPANY, a template and the number connected', async () => {
    store.doc.whatsappAfterNoAnswer = company;
    conn.row = { id: 'w1' };
    conn.status = 'CONNECTED';
    expect(await companySendsFor(db as never, 'c1', '962')).toBe(true);
    expect(await companySendsFor(db as never, 'c1', '963')).toBe(false);
  });

  it('not connected — no', async () => {
    store.doc.whatsappAfterNoAnswer = company;
    conn.row = { id: 'w1' };
    conn.status = 'NEEDS_SETUP';
    expect(await companySendsFor(db as never, 'c1', '962')).toBe(false);
  });

  it('no template named — no, and the connection is not even asked', async () => {
    store.doc.whatsappAfterNoAnswer = { ...company, templateName: '' };
    conn.row = { id: 'w1' };
    conn.status = 'CONNECTED';
    expect(await companySendsFor(db as never, 'c1', '962')).toBe(false);
  });
});
