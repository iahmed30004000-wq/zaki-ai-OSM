import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from './guard-source';

/**
 * THE SAME CUSTOMER, THE SAME PRODUCT, TEN MINUTES: EVERY DOOR THAT TAKES AN ORDER SAYS SO — AND NONE OF THEM REFUSES.
 *
 * `a-block-holds-at-every-door.test.ts` enumerates the doors for the blacklist, which refuses. This is its sibling for
 * the flag, which must not. The doors are the same ones, and the same lesson applies: a check one level up is not a
 * check missing, and a door added later must have to choose.
 */

/** The doors that raise an order for a customer, and the file the flag is called from. */
const DOORS: Record<string, string> = {
  'the dashboard’s own order form (and the sheet import, which posts row by row to it)': 'src/app/api/orders/route.ts',
  'the AI intake': 'src/app/api/orders/ai-intake/route.ts',
  'every public door — landing page, storefront, single product': 'src/lib/public-order.ts',
  'Telegram': 'src/lib/telegram/order-creation.ts',
  'the systems door (/api/v1)': 'src/lib/v1/order-intake.ts',
};

/** Files that create an order and are NOT a customer asking now — each with the reason, so the list is an argument. */
const EXEMPT: Record<string, string> = {
  'src/lib/replacement-order.ts': 'a replacement is a repeat of the same sale on purpose (and carries replacesOrderId)',
  'src/app/api/confirmation/winback/route.ts': 'a win-back is a second offer for a lost order on purpose',
  'src/lib/order-migration.ts': 'dated history brought over from the old system, not a customer typing now',
};

function everySourceFile(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '.next') continue;
      everySourceFile(p, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(relative(process.cwd(), p).replace(/\\/g, '/'));
    }
  }
  return out;
}

const code = (rel: string) => stripComments(repoFile(rel));

describe('every door that raises an order for a customer flags a repeat', () => {
  it.each(Object.entries(DOORS))('%s', (_name, file) => {
    // The CALL, with a customer and the order it just wrote — not the import line.
    expect(code(file)).toMatch(/await flagRecentTwins\(\s*db,\s*\{[^}]*orderId:\s*order\.id[^}]*customerId:\s*customer\.id/s);
  });

  it('and AFTER the order is saved, never inside the transaction that writes it', () => {
    for (const file of Object.values(DOORS)) {
      const src = code(file);
      const flagged = src.search(/await flagRecentTwins\(/);
      const created = src.search(/(?:tx|db)\.order\.create/);
      expect(flagged, `${file}: الفحص قبل الإنشاء`).toBeGreaterThan(created);
      // After the transaction's own last line (`return created;`), so a failing note cannot abort the order in Postgres.
      const lastLine = src.indexOf('return created;', src.indexOf('$transaction'));
      expect(lastLine, `${file}: لم أجد آخر سطر في المعاملة`).toBeGreaterThan(-1);
      expect(flagged, `${file}: الفحص داخل المعاملة`).toBeGreaterThan(lastLine);
    }
  });

  it('and nobody reads the answer: the result decides nothing, so it cannot become a refusal', () => {
    for (const file of Object.values(DOORS)) {
      const src = code(file);
      expect(src, `${file} يقرأ نتيجة الفحص`).not.toMatch(/(?:const|let)\s+\w+\s*=\s*await flagRecentTwins/);
      expect(src, `${file} يعتمد على نتيجة الفحص`).not.toMatch(/if\s*\(\s*await flagRecentTwins/);
    }
  });

  it('every file that creates an order is a door above or an exemption with a reason — a new one has to choose', () => {
    const creators = everySourceFile(join(process.cwd(), 'src')).filter((rel) =>
      /(?:tx|db)\.order\.create\(/.test(stripComments(repoFile(rel)))
    );
    const known = new Set([...Object.values(DOORS), ...Object.keys(EXEMPT)]);
    expect(creators.filter((f) => !known.has(f)), 'باب جديد لإنشاء الطلب لا يفحص التكرار ولا هو مستثنى بسبب').toEqual([]);
    // And the list does not rot the other way: a door that stopped creating orders leaves the list.
    expect([...known].filter((f) => !creators.includes(f)), 'بند في القائمة لم يعد ينشئ طلباً').toEqual([]);
  });

  it('the exemptions do not call it: a flag on a replacement would be noise on every one', () => {
    for (const file of Object.keys(EXEMPT)) {
      expect(code(file), file).not.toContain('flagRecentTwins');
    }
  });
});

describe('the detector itself refuses nothing and moves no money', () => {
  const src = () => code('src/lib/recent-twin-order.ts');

  it('throws nothing outward, returns no status, and imports no money', () => {
    expect(src()).not.toMatch(/throw\s/);
    expect(src()).not.toMatch(/NextResponse|status:\s*4\d\d/);
    expect(src()).not.toMatch(/from '\.\/(?:money|offer-gift|product-cost|reservation)'/);
    expect(src()).not.toMatch(/computeCod/);
  });

  it('and writes one kind of row, a history row — never an order, a line, a customer or stock', () => {
    const writes = [...src().matchAll(/\.(\w+)\.(create|update|updateMany|delete|deleteMany|upsert|createMany)\(/g)].map(
      (m) => `${m[1]}.${m[2]}`
    );
    expect(writes).toEqual(['orderActivity.create']);
  });

  it('asks only this customer’s orders of this company, in the window, and leaves out the ones a person refused', () => {
    const s = src();
    expect(s).toContain('customerId: q.customerId');
    expect(s).toContain('companyId: q.companyId');
    expect(s).toMatch(/confirmationStatus:\s*\{\s*notIn:\s*\[\.\.\.CONFIRMATION_REFUSED\]/);
    expect(s).toContain('replacesOrderId: null');
  });

  it('is never sent a name, a phone or an address — it takes ids and a date, so nothing can reach a model', () => {
    const s = src();
    expect(s).not.toMatch(/fullName|phone|address|customerName/i);
    expect(s).not.toMatch(/aiChat|fetch\(|ai-provider/);
  });

  it('is named in Arabic in the order’s history, so the timeline never prints the code', () => {
    const timeline = repoFile('src/lib/order-timeline.ts');
    expect(timeline).toContain('[TWIN_ACTION]:');
  });
});

describe('the confirmation window shows it above the buttons', () => {
  it('the notice is drawn before the confirmation actions, for whoever works the phone', () => {
    const modal = stripComments(repoFile('src/components/orders/OrderDetailModal.tsx'));
    const notice = modal.indexOf('<DuplicateSuspectNotice');
    const actions = modal.indexOf('<ConfirmationActions');
    expect(notice).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(actions);
    expect(modal).toMatch(/mayRecordCalls && order\?\.id && <DuplicateSuspectNotice/);
  });

  it('and it hides no button: the notice neither wraps the actions nor reads their state', () => {
    const notice = stripComments(repoFile('src/components/orders/DuplicateSuspectNotice.tsx'));
    expect(notice).not.toMatch(/disabled|children|onConfirm|ConfirmationActions/);
  });

  it('its words are Arabic only', () => {
    const notice = readFileSync(join(process.cwd(), 'src/components/orders/DuplicateSuspectNotice.tsx'), 'utf8');
    expect(notice).toContain('طلب مشابه قبل دقائق');
    expect(notice).toContain('اسأله قبل التأكيد');
  });
});
