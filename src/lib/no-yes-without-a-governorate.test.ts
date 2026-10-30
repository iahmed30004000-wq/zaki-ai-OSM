import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REGION_REQUIRED_MESSAGE, needsRegionFirst } from './confirmation-queue';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * NO CONFIRMATION WITHOUT A GOVERNORATE — THE RULE AND WHERE IT IS ASKED (30/10).
 *
 * The owner: «المفروض ما يسمح لموظفة التأكيد تأكّد غير لما تحدد المحافظة». The rule is one pure function, asked at both
 * doors that can confirm; the doors themselves are driven in
 * `api/orders/[id]/confirmation/no-yes-without-a-governorate.test.ts` and
 * `api/orders/[id]/no-yes-without-a-governorate-on-the-edit-door.test.ts`.
 * ═══════════════════════════════════════════════════════════════════════
 */

describe('needsRegionFirst', () => {
  it.each([
    ['null', { regionId: null }],
    ['an empty string', { regionId: '' }],
    ['blanks', { regionId: '   ' }],
    ['absent', {}],
    ['undefined', { regionId: undefined }],
  ])('%s ⇒ the order needs its governorate first', (_name, order) => {
    expect(needsRegionFirst(order)).toBe(true);
  });

  it('a real id ⇒ it does not', () => {
    expect(needsRegionFirst({ regionId: 'a1b2c3d4-0000-4000-8000-000000000000' })).toBe(false);
    expect(needsRegionFirst({ regionId: 'r1' })).toBe(false);
  });

  it('only the id is asked: a written city on the object changes nothing', () => {
    expect(needsRegionFirst({ regionId: null, ...({ city: 'سكاكة الجوف' } as object) })).toBe(true);
    expect(needsRegionFirst({ regionId: null, ...({ customer: { city: 'دمشق' } } as object) })).toBe(true);
  });
});

describe('the sentence', () => {
  it('is the one the server and the screen both say, in Arabic only', () => {
    expect(REGION_REQUIRED_MESSAGE).toBe('حدّد المحافظة أولاً — أجرة التوصيل مبنية عليها ولا يُؤكَّد طلب بلا محافظة');
    expect(REGION_REQUIRED_MESSAGE).not.toMatch(/[A-Za-z0-9]/);
  });
});

/** The source of a file with its comments taken out, so a mention in prose cannot satisfy a check on code. */
const code = (rel: string) =>
  readFileSync(join(process.cwd(), rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('it is asked where the yes is given — and before anything is reserved', () => {
  const door = code('src/app/api/orders/[id]/confirmation/route.ts');

  it('the confirmation door asks it inside «confirm», before the target is set and before the reservation', () => {
    const confirmCase = door.indexOf("case 'confirm'");
    const asked = door.indexOf('needsRegionFirst(order)', confirmCase);
    const target = door.indexOf("target = 'CONFIRMED'", confirmCase);
    const reserve = door.indexOf('reserveOrderLines(tx');
    expect(confirmCase).toBeGreaterThan(-1);
    expect(asked, 'الباب ما بيسأل عن المحافظة').toBeGreaterThan(confirmCase);
    expect(asked).toBeLessThan(target);
    expect(target).toBeLessThan(reserve);
    expect(door).toContain("code: 'REGION_REQUIRED'");
    expect(door).toMatch(/code: 'REGION_REQUIRED' \},\s*\{ status: 409 \}/);
  });

  it('the edit door asks it for a move to CONFIRMED and for a clear, before it writes', () => {
    const edit = code('src/app/api/orders/[id]/route.ts');
    const asked = edit.indexOf('needsRegionFirst({');
    expect(asked, 'الباب الثاني ما بيسأل').toBeGreaterThan(-1);
    expect(edit).toContain("(changingCombined && status === 'CONFIRMED')");
    expect(edit).toContain("(changingConfirmation && confirmationStatus === 'CONFIRMED')");
    expect(edit).toContain('regionId === null');
    expect(edit).toContain("code: 'REGION_REQUIRED'");
    // before the first write of the route, which is the transaction near its end
    expect(asked).toBeLessThan(edit.indexOf('db.$transaction'));
  });

  it('the desk list carries the id the card asks about', () => {
    const mine = code('src/app/api/confirmation/mine/route.ts');
    expect(mine).toMatch(/\bregionId: true,/);
  });
});
