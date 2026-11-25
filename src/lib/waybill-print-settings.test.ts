import { describe, expect, it } from 'vitest';
import { renderLabelSheet, type LabelView, type SheetOptions, type SheetShow } from './label-sheet';
import {
  HIDEABLE_KEYS, LOCKED_KEYS, WAYBILL_ELEMENTS, isOwnWaybillLogo, readDocument, resolveWaybillPrint, storeEntry,
  validateWaybillPrint, type WaybillPrintDocument,
} from './waybill-print-settings';

/**
 * «البوليصة المطبوعة» (25/11, F15): what each part's switch does to the ONE waybill renderer, what may never be left
 * off, and that one store's choice is that store's alone.
 */

const label: LabelView = {
  orderId: '00000000-0000-4000-8000-000000000001',
  courier: 'شركة-التوصيل-س',
  ref: 'SY-REF-777',
  courierCode: 'JO7000000123',
  name: 'زبون-تجربة',
  phones: ['0911111111', '0922222222'],
  place: 'عنوان-تجربة — شارع',
  items: [{ name: 'صنف-تجربة', qty: 2 }],
  note: 'ملاحظة-تجربة',
  cod: '32.500 JOD',
  qrSvg: '<svg data-qr="1"></svg>',
};
const LOGO = '/api/media/companies/c1/products/s1/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.webp';
const opts = (show?: SheetShow, logoUrl: string | null = LOGO): SheetOptions => ({
  store: { name: 'متجر-تجربة', logoUrl, supportPhone: '0933333333' },
  mode: 'print',
  token: 't',
  stampUrl: '/api/ops/labels/printed',
  ...(show ? { show } : {}),
});
const ALL: SheetShow = { storeName: true, courierName: true, ref: true, items: true, note: true, qr: true, supportPhone: true };
const page = (show?: SheetShow, logoUrl?: string | null) => {
  const html = renderLabelSheet([label], { width: 100, height: 150 }, opts(show, logoUrl));
  return html.slice(html.indexOf('<section'), html.indexOf('</section>'));
};

/** What each part prints, as it can be found on the paper. */
const MARK: Record<keyof SheetShow, string> = {
  storeName: '<strong>متجر-تجربة</strong>',
  courierName: '<span>شركة-التوصيل-س</span>',
  ref: '<b dir="ltr">SY-REF-777</b>',
  items: 'صنف-تجربة',
  note: 'ملاحظة-تجربة',
  qr: 'data-qr="1"',
  supportPhone: '0933333333',
};
const COURIER_MARKS = ['زبون-تجربة', '0911111111', '0922222222', 'عنوان-تجربة', '32.500 JOD', 'aria-label="JO7000000123"'];

describe('each switch leaves off exactly its part', () => {
  it('with every part shown, every part prints', () => {
    const p = page(ALL);
    for (const m of [...Object.values(MARK), ...COURIER_MARKS, 'class="logo"']) expect(p, m).toContain(m);
  });

  it.each(HIDEABLE_KEYS)('«%s» off: its part is gone, every other part and every courier part still prints', (key) => {
    const p = page({ ...ALL, [key]: false });
    expect(p, key).not.toContain(MARK[key]);
    for (const other of HIDEABLE_KEYS.filter((k) => k !== key)) {
      // The QR's caption repeats our reference: with the header's reference off it still prints there, as it should.
      expect(p, other).toContain(MARK[other]);
    }
    for (const m of COURIER_MARKS) expect(p, m).toContain(m);
  });

  it('the items off: no item line and no count line either', () => {
    const p = page({ ...ALL, items: false, note: false });
    expect(p).not.toContain('class="items"');
    expect(p).not.toContain('class="count"');
    expect(p).not.toContain('class="body"');
  });

  it('the items off with the note on: the note prints alone — no item line, no count line', () => {
    const p = page({ ...ALL, items: false });
    expect(p).toContain('class="body"');
    expect(p).toContain(MARK.note);
    expect(p).not.toContain('class="items"');
    expect(p).not.toContain('class="count"');
  });

  it('the logo «بلا شعار» is no logo; every header part off is no header at all', () => {
    expect(page(ALL, null)).not.toContain('class="logo"');
    const p = page({ ...ALL, storeName: false, courierName: false, ref: false }, null);
    expect(p).not.toContain('class="head"');
    for (const m of COURIER_MARKS) expect(p, m).toContain(m);
  });

  it('a part left off gives its room back: the type grows on a crowded label', () => {
    const crowded: LabelView = { ...label, items: Array.from({ length: 12 }, (_, i) => ({ name: `صنف ${i}`, qty: 1 })) };
    const scale = (show?: SheetShow) =>
      Number(/--s: ([\d.]+)/.exec(renderLabelSheet([crowded], { width: 100, height: 100 }, opts(show)).split('<section')[1])![1]);
    expect(scale({ ...ALL, items: false, qr: false, note: false })).toBeGreaterThan(scale());
  });
});

describe('the parts the courier works from cannot be left off', () => {
  it('they are the five: name, phones, address, COD, barcode — locked in the one list', () => {
    expect([...LOCKED_KEYS].sort()).toEqual(['barcode', 'cod', 'name', 'phones', 'place']);
    expect(WAYBILL_ELEMENTS.filter((e) => e.locked).map((e) => e.key).sort()).toEqual([...LOCKED_KEYS].sort());
    // and the renderer has no switch for any of them
    for (const k of LOCKED_KEYS) expect(Object.keys(ALL)).not.toContain(k);
  });

  it.each(['name', 'phones', 'place', 'cod', 'barcode'])('NEGATIVE: hiding «%s» is refused with COURIER_FIELD_LOCKED and an Arabic sentence', (k) => {
    const v = validateWaybillPrint({ hide: ['qr', k], logo: 'store' }, { ownLogo: false });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe('COURIER_FIELD_LOCKED');
      expect(v.errorAr).toMatch(/[؀-ۿ]/);
    }
  });
});

describe('the door’s validation', () => {
  it('takes the hideable parts, in print order, without repeats', () => {
    expect(validateWaybillPrint({ hide: ['qr', 'storeName', 'qr'], logo: 'none' }, { ownLogo: false })).toEqual({
      ok: true,
      value: { hide: ['storeName', 'qr'], logo: 'none' },
    });
  });

  it.each([
    [null, 'INVALID'],
    [{ hide: ['qr'] }, 'INVALID'],
    [{ hide: 'qr', logo: 'store' }, 'INVALID'],
    [{ hide: ['nothing'], logo: 'store' }, 'INVALID'],
    [{ hide: [], logo: 'big' }, 'INVALID'],
    [{ hide: [], logo: 'store', ownLogo: LOGO }, 'INVALID'],
    [{ hide: [], logo: 'own' }, 'NO_OWN_LOGO'],
  ])('NEGATIVE: %j → %s', (input, code) => {
    const v = validateWaybillPrint(input, { ownLogo: false });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe(code);
  });
});

describe('the own logo, and one store’s choice is its own', () => {
  it('an own logo is exactly a file of THIS store’s folder of THIS company, an image', () => {
    expect(isOwnWaybillLogo(LOGO, 'c1', 's1')).toBe(true);
    expect(isOwnWaybillLogo(LOGO, 'c1', 's2')).toBe(false);
    expect(isOwnWaybillLogo(LOGO, 'c2', 's1')).toBe(false);
    expect(isOwnWaybillLogo(LOGO.replace('.webp', '.svg'), 'c1', 's1')).toBe(false);
    expect(isOwnWaybillLogo('https://elsewhere.example/a.webp', 'c1', 's1')).toBe(false);
    expect(isOwnWaybillLogo(`${LOGO}/../x.webp`, 'c1', 's1')).toBe(false);
  });

  it('store A’s choice changes store A only', () => {
    const doc: WaybillPrintDocument = { v: 1, stores: { s1: { hide: ['qr'], logo: 'own', ownLogo: LOGO } } };
    expect(resolveWaybillPrint(doc, { companyId: 'c1', storeId: 's1' }, '/api/public/store-logo/x/y.webp')).toEqual({
      logoUrl: LOGO,
      show: { ...ALL, qr: false },
    });
    expect(resolveWaybillPrint(doc, { companyId: 'c1', storeId: 's2' }, null)).toEqual({ logoUrl: null });
  });

  it('NEGATIVE: an own logo that is another store’s file is not drawn', () => {
    const doc: WaybillPrintDocument = { v: 1, stores: { s2: { hide: [], logo: 'own', ownLogo: LOGO } } };
    expect(resolveWaybillPrint(doc, { companyId: 'c1', storeId: 's2' }, null).logoUrl).toBeNull();
  });

  it('a broken document is today’s waybill', () => {
    expect(readDocument('x')).toBeNull();
    expect(readDocument({ v: 2, stores: {} })).toBeNull();
    expect(storeEntry({ v: 1, stores: { s1: 'x' as never } }, 's1')).toBeNull();
    expect(storeEntry({ v: 1, stores: { s1: { hide: ['name', 'qr'], logo: 'odd' } as never } }, 's1')).toEqual({ hide: ['qr'], logo: 'store' });
  });
});
