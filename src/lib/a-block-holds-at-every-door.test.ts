import { describe, expect, it } from 'vitest';
import { NEUTRAL_REFUSAL } from './blacklist';
import { repoFile, stripComments } from './guard-source';

/**
 * تشطيب ٢ — PASS 3: «blacklist a phone → blocked across ALL stores and
 * countries?» and «submit a landing page form from a blacklisted phone → no
 * order, neutral message?»
 *
 * THE ANSWER IS YES, AND IT TOOK TWO HOPS TO SEE IT — which is why this file
 * exists. `telegram/order-creation.ts` creates an order and contains no
 * blacklist check at all; I read it and wrote down that the Telegram channel
 * was a hole. It is not: `telegram/inbound.ts` checks one level up, before it
 * ever calls the creator, with a comment about why it passes the RAW phone.
 *
 * A fact that takes two hops to establish is a fact the next person will get
 * wrong the same way. So the doors are enumerated here with the file the
 * check actually lives in, and a door that stops checking fails.
 */

/** Doors that raise a NEW order for a phone somebody supplied. */
const DOORS: Record<string, { checkedIn: string; why: string }> = {
  'the dashboard’s own order form': {
    checkedIn: 'src/app/api/orders/route.ts',
    why: 'موظّفٌ يُدخل طلباً بالهاتف',
  },
  'every public door — landing page, storefront, single product': {
    checkedIn: 'src/lib/public-order.ts',
    why: 'المحرّك المشترك لكل أبواب الزائر، فالفحص فيه يغطّيها كلّها',
  },
  'Telegram': {
    // NOT `order-creation.ts`, which is the file that creates the order.
    checkedIn: 'src/lib/telegram/inbound.ts',
    why: 'الرسالة الواردة تُفحص قبل أن تصل منشئ الطلب أصلاً',
  },
  'the AI intake': {
    checkedIn: 'src/app/api/orders/ai-intake/route.ts',
    why: 'طلبٌ يُستخرج من نصّ',
  },
  'the spreadsheet import': {
    checkedIn: 'src/app/api/orders/import/route.ts',
    why: 'صفوفٌ كثيرة، وكلّ صفٍّ هاتف',
  },
  /*
   * O7 — THE SIXTH DOOR, AND THE FIRST THAT NO PERSON HERE PRESSES.
   *
   * `/api/v1/orders` takes an order from another SYSTEM. The hole it could
   * have opened is the widest of the six: a blocked number that cannot
   * order on any screen in this product, ordering freely because the
   * replies system asked on its behalf. The check is in the intake service
   * and not in the route handler, which is where every other rule at that
   * door lives too.
   */
  'the systems door (/api/v1)': {
    checkedIn: 'src/lib/v1/order-intake.ts',
    why: 'نظامٌ خارجيٌّ يرحّل طلباً — والرقمُ المحظورُ لا يصير مسموحاً لأنّ غيرَنا سأل عنه',
  },
};

describe('a blocked phone is blocked at every door that takes a new order', () => {
  it.each(Object.entries(DOORS))('%s', (_name, door) => {
    const src = stripComments(repoFile(door.checkedIn));
    // The CALL, not the import: this repository has recorded more than once
    // that a guard asking whether a name is present is satisfied by the
    // import line of the thing that was deleted.
    expect(src, door.why).toMatch(/(activeBlock|isBlocked)\s*\(\s*\w/);
  });

  it('and the check comes before the order is written, not after', () => {
    for (const door of Object.values(DOORS)) {
      const src = stripComments(repoFile(door.checkedIn));
      const checked = src.search(/(activeBlock|isBlocked)\s*\(\s*\w/);
      /*
       * The WRITE, not a declaration that happens to share the name.
       * `createPublicOrder(` matched `export async function
       * createPublicOrder(` — which is of course before the check inside
       * it — and the guard reported the engine as checking too late.
       */
      const created = src.search(/(?:tx|db)\.order\.create|await createTelegramOrder\(/);
      if (created === -1) continue; // the check and the create are in different files
      expect(checked, `${door.checkedIn}: الفحص بعد الإنشاء`).toBeLessThan(created);
    }
  });

  /*
   * EVERY CREATE, NOT THE FIRST ONE.
   *
   * The check above compares the FIRST check with the FIRST create. The Telegram door had two creates (the old labeled
   * path and the seven-line one) and now has the one, the labeled door's. A second create added later with no check of
   * its own in front of it would pass that comparison on the strength of the first path's check. So each
   * `await createTelegramOrder(` must have an `isBlocked(` between it and the create before it.
   */
  it('and in the Telegram door, EVERY create has a check of its own in front of it', () => {
    const src = stripComments(repoFile('src/lib/telegram/inbound.ts'));
    const creates = [...src.matchAll(/await createTelegramOrder\(/g)].map((m) => m.index!);
    const checks = [...src.matchAll(/isBlocked\s*\(\s*\w/g)].map((m) => m.index!);
    expect(creates.length, 'الباب لم يعد يُنشئ طلباً؟').toBeGreaterThanOrEqual(1);
    creates.forEach((at, i) => {
      const since = i === 0 ? 0 : creates[i - 1];
      expect(
        checks.some((c) => c > since && c < at),
        `الإنشاء رقم ${i + 1} في inbound.ts بلا فحص قائمة الحظر قبله`
      ).toBe(true);
    });
  });
});

describe('what a blocked visitor is told', () => {
  it('is the same sentence for everybody, and it says nothing', () => {
    // Telling somebody they are blacklisted invites them to try another
    // number and tells them which one is burned.
    expect(NEUTRAL_REFUSAL).not.toMatch(/حظر|محظور|قائمة|سوداء|blocked|blacklist/i);
    expect(NEUTRAL_REFUSAL.length).toBeGreaterThan(10);
  });

  it('and the public engine answers with exactly that, not with its own words', () => {
    const src = stripComments(repoFile('src/lib/public-order.ts'));
    const at = src.search(/isBlocked\s*\(/);
    expect(at).toBeGreaterThan(-1);
    // The refusal is the shared constant, within a few lines of the check.
    expect(src.slice(at, at + 400)).toContain('NEUTRAL_REFUSAL');
  });

  it('and the block is matched on the canonical phone, so a rewrite does not walk round it', () => {
    const src = stripComments(repoFile('src/lib/blacklist.ts'));
    const fn = src.slice(src.indexOf('export async function activeBlock('));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain('canonicalPhone(');
    // Every stored form of the number (RV136 keeps a foreign number's code), never one spelling of it.
    expect(body).toMatch(/phone: \{ in: keys \},\s*releasedAt: null/);
  });

  it('and it covers the whole company — every store and every country of it', () => {
    const src = stripComments(repoFile('src/lib/blacklist.ts'));
    const fn = src.slice(src.indexOf('export async function activeBlock('));
    const body = fn.slice(0, fn.indexOf('\n}'));
    // Scoped by company and NOT by store or country: a number blocked in
    // Syria must not be able to order from the Jordanian store.
    expect(body).toContain('companyId');
    expect(body).not.toMatch(/storeId|countryId/);
  });
});

describe('a door that continues an order already placed does not re-ask', () => {
  /**
   * Winback and replacement reuse `order.customerId` — a customer this shop
   * already sold to, on an order that already exists. They are a member of
   * staff continuing a known order, not a stranger starting one, so the
   * blacklist is not their gate. Said here because the absence of a check
   * in a file that calls `order.create` is otherwise indistinguishable from
   * the hole I thought I had found in Telegram.
   */
  it.each([
    'src/app/api/confirmation/winback/route.ts',
    'src/lib/replacement-order.ts',
  ])('%s carries the existing customer rather than a phone', (file) => {
    const src = stripComments(repoFile(file));
    expect(src).toMatch(/customerId: order\.customerId/);
    // And takes no phone from anybody.
    expect(src).not.toMatch(/phone:\s*(body|input|parsed|raw)\./);
  });
});
