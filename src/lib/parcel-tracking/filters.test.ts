import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STATUS,
  EVERY_STATUS,
  NOBODY,
  SHIPPING_STATUSES,
  TASKS,
  isOneOf,
  isStatusChoice,
  isTask,
  searchWhere,
  trackingFilters,
} from './filters';
import { SHIPPING_STATUS_AR } from '../shipping-workflow';
import { URGENCIES } from './priority';
import { repoFile, stripComments } from '../guard-source';

/**
 * WHAT A FOLLOW-UP AGENT CAN CHOOSE, READ ONCE.
 *
 * «متابعة الشحن — صفحات + فلاتر + بحث». The state, the chip, the delivery company, the governorate, how long it has
 * been out, the word searched: each is read here, a value this module does not know is REFUSED in Arabic, and the chip
 * names are the very names `parcel-tracking/priority.ts` ranks by — never a second list of them.
 */

const ask = (query = '') => trackingFilters(new URLSearchParams(query));
const COURIER = '22222222-2222-4222-8222-222222222222';
const REGION = '33333333-3333-4333-8333-333333333333';

describe('nothing chosen', () => {
  it('— is the screen’s own job description: the default state, no chip, no company, no governorate, no age, no word', () => {
    expect(ask()).toEqual({ ok: true, applied: { status: DEFAULT_STATUS, task: null, courier: null, region: null, age: null, product: null, q: null } });
  });

  it('and «all» and blanks are no choice — except in the state, where `all` keeps the meaning it always had', () => {
    for (const q of ['task=all', 'courier=all', 'region=all', 'age=all', 'task=', 'courier=%20', 'q=%20%20']) {
      expect(ask(q), q).toEqual({ ok: true, applied: { status: DEFAULT_STATUS, task: null, courier: null, region: null, age: null, product: null, q: null } });
    }
  });
});

describe('the state', () => {
  it('— `every` is every state, and so is the old `all`: a link or a test that says it keeps working', () => {
    expect(ask('status=every')).toMatchObject({ ok: true, applied: { status: EVERY_STATUS } });
    expect(ask('status=all')).toMatchObject({ ok: true, applied: { status: EVERY_STATUS } });
  });

  it('and any of the twelve shipping states is a state', () => {
    expect(SHIPPING_STATUSES).toHaveLength(12);
    for (const s of SHIPPING_STATUSES) expect(ask(`status=${s}`), s).toMatchObject({ ok: true, applied: { status: s } });
    expect(new Set(SHIPPING_STATUSES)).toEqual(new Set(Object.keys(SHIPPING_STATUS_AR)));
  });

  it('and one that is not is refused in Arabic — it is not quietly «no results»', () => {
    for (const bad of ['SHIPPING', 'delivered', 'DELIVERED ', '1']) {
      const r = ask(`status=${encodeURIComponent(bad)}`);
      if (bad === 'DELIVERED ') {
        // Spaces are trimmed: this IS «DELIVERED».
        expect(r).toMatchObject({ ok: true, applied: { status: 'DELIVERED' } });
      } else {
        expect(r, bad).toMatchObject({ ok: false, errorAr: `الحالة غير معروف: ${bad}` });
      }
    }
  });

  it('and the predicates agree: the default and every are choices, a state is, a stranger is not', () => {
    expect(isStatusChoice(DEFAULT_STATUS)).toBe(true);
    expect(isStatusChoice(EVERY_STATUS)).toBe(true);
    expect(isStatusChoice('RETURNED')).toBe(true);
    for (const bad of ['all', '', undefined, 7, null, 'returned']) expect(isStatusChoice(bad), String(bad)).toBe(false);
  });
});

describe('the product', () => {
  const PRODUCT = '44444444-4444-4444-8444-444444444444';

  it('— is the id of one product, or no choice: «all» and blanks are none', () => {
    expect(ask(`product=${PRODUCT}`)).toMatchObject({ ok: true, applied: { product: PRODUCT } });
    for (const q of ['product=all', 'product=', 'product=%20']) expect(ask(q), q).toMatchObject({ ok: true, applied: { product: null } });
  });

  it('and what is not an id — a name, «nobody» — is refused in Arabic, saying which', () => {
    for (const bad of ['كريم', 'none', '123']) {
      const r = ask(`product=${encodeURIComponent(bad)}`);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.errorAr).toContain('المنتج');
    }
  });
});

describe('the chip', () => {
  it('— is one of the seven conditions `parcel-tracking/priority.ts` ranks, in the order they are drawn, and «nothing» is not a chip', () => {
    expect([...TASKS]).toEqual(['CANCELLED', 'CHANGED', 'FAILED', 'RETURNING', 'LATE', 'NO_BARCODE', 'COLLECT']);
    expect(TASKS).toEqual(URGENCIES.filter((k) => k !== 'NONE'));
    for (const t of TASKS) expect(ask(`task=${t}`), t).toMatchObject({ ok: true, applied: { task: t } });
    expect(isTask('NONE')).toBe(false);
    expect(ask('task=NONE')).toMatchObject({ ok: false, errorAr: 'المهمة غير معروف: NONE' });
  });

  it('and a word that is no chip is refused', () => {
    for (const bad of ['late', 'LATEST', 'COLLECTING']) expect(ask(`task=${bad}`), bad).toMatchObject({ ok: false });
  });
});

describe('the company, the governorate and the age', () => {
  it('— a company and a governorate are an id, or «nobody» — which is a parcel with none on it', () => {
    expect(ask(`courier=${COURIER}&region=${REGION}`)).toMatchObject({ ok: true, applied: { courier: COURIER, region: REGION } });
    expect(ask('courier=none&region=none')).toMatchObject({ ok: true, applied: { courier: NOBODY, region: NOBODY } });
    expect(isOneOf(COURIER)).toBe(true);
    expect(isOneOf(NOBODY)).toBe(true);
    for (const bad of ['dhl', '1', '', 'all', undefined, 7, null]) expect(isOneOf(bad), String(bad)).toBe(false);
  });

  it('and what is not an id is refused in Arabic, saying which', () => {
    expect(ask('courier=dhl')).toMatchObject({ ok: false, errorAr: 'شركة الشحن غير معروف: dhl' });
    expect(ask('region=amman')).toMatchObject({ ok: false, errorAr: 'المحافظة غير معروف: amman' });
  });

  it('and an age is one of the four piles, or refused', () => {
    for (const age of ['fresh', 'few', 'week', 'old']) expect(ask(`age=${age}`), age).toMatchObject({ ok: true, applied: { age } });
    expect(ask('age=ancient')).toMatchObject({ ok: false, errorAr: 'مدّة الشحن غير معروف: ancient' });
  });

  it('and the refusal carries the English sentence too, for the logs', () => {
    const r = ask('age=ancient');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('Unknown age: ancient');
  });
});

describe('the word', () => {
  it('— is trimmed, capped at a hundred, and blanks are no word', () => {
    const r = ask(`q=${encodeURIComponent('  ' + 'س'.repeat(300) + '  ')}`);
    expect(r.ok && r.applied.q).toBe('س'.repeat(100));
    expect(ask('q=%20%20')).toMatchObject({ ok: true, applied: { q: null } });
  });

  it('and it is searched the way every order list is searched: one builder, so a field added to it reaches this list', () => {
    const or = (searchWhere('0791234567') as { OR: Record<string, unknown>[] }).OR;
    expect(or.map((c) => Object.keys(c)[0])).toEqual(['orderNumber', 'merchantRef', 'trackingNumber', 'customer', 'customer', 'customer']);
    const customer = or.filter((c) => c.customer).flatMap((c) => Object.keys(c.customer as object));
    expect(customer.sort()).toEqual(['fullName', 'phone', 'rawPhone']);
  });

  it('and the order of the parameters is no part of the question', () => {
    expect(JSON.stringify(ask(`age=old&task=LATE&courier=none&q=a`))).toBe(JSON.stringify(ask(`q=a&courier=none&task=LATE&age=old`)));
  });
});

describe('the module is safe for the screen to import', () => {
  it('— it reaches no server module: no database, no session, no queue', () => {
    const src = stripComments(repoFile('src/lib/parcel-tracking/filters.ts'));
    for (const forbidden of ["'../db'", "'@/lib/db'", 'next/server', 'next/headers', 'geo-context', 'authorization']) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });
});
