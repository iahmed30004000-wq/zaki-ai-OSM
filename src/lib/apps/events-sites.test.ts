import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { stripComments } from '../guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * WHERE AN EVENT MAY BE ANNOUNCED FROM, AND WHAT IT MUST CARRY.
 *
 * `events.test.ts` proves the ENVELOPE matches the contract System 7
 * reads. It cannot prove the thing a running system actually gets wrong:
 * a fourth place starts emitting, or an existing call quietly stops
 * carrying `total`, and every envelope test stays green because the
 * envelope is still an envelope.
 *
 * So this is static. It walks the source, finds every `emitAppEvent(`
 * outside the module that defines it, and insists on two things:
 *
 *   THE CALL SITES ARE THE THREE WE KNOW. An event announced from a
 *   fourth place is an event nobody wrote the data contract for — and
 *   `contracts/oms-app-events.v1/` has one golden body per event, not per
 *   caller.
 *
 *   EACH ONE CARRIES THE FOUR REQUIRED FIELDS. `schema.json` marks
 *   `orderId`, `orderNumber`, `total` and `currency` required; a payload
 *   missing one of them is refused by the other side, at night, with
 *   nobody watching.
 *
 * `total: Number(` is matched literally and on purpose: `totalAmount` is a
 * Prisma `Decimal`, and a Decimal serialised into JSON is a STRING. The
 * schema says `"type": "number"`. Dropping the `Number(` is a one-character
 * change that turns every delivery into a rejected one.
 * ═══════════════════════════════════════════════════════════════════════
 */

const SRC = join(process.cwd(), 'src');

/**
 * The places an order's life actually changes.
 *
 * ADDED (28/10, additive only — the contract and the envelope are untouched):
 *   · `lib/order-cancel.ts` — `order.cancelled`, from the ONE helper every cancel door goes through
 *     (before, the confirmation and shipping doors each announced a cancel of their own and the
 *     other four never did). It carries the shipping golden payload for a parcel that had a
 *     shipping life, and the confirmation one otherwise — never REJECTED.
 *   · `app/api/shipping-batches/[id]/route.ts` — `order.shipped`, one per parcel, when the press of
 *     «إغلاق الشحنة — سُلّمت للشركة» hands the trolley over (it stamped the parcels and told nobody).
 *   · `lib/parcel-swap-events.ts` — `order.delivered` for the sale a parcel swap records and `order.returned` for
 *     the box's order, after the commit (29/10). Never `order.created`; `replacesOrderNumber` is an optional
 *     field inside `data`, which the contract allows.
 */
const ALLOWED = [
  'lib/public-order.ts',
  'lib/order-cancel.ts',
  'lib/parcel-swap-events.ts',
  'app/api/orders/[id]/confirmation/route.ts',
  'app/api/orders/[id]/shipping/route.ts',
  'app/api/shipping-batches/[id]/route.ts',
].sort();

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

/** The whole `emitAppEvent( … )` call, brace- and paren-counted. */
function callAt(src: string, start: number): string {
  let depth = 0;
  for (let i = src.indexOf('(', start); i < src.length && i < start + 4000; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start, start + 4000);
}

interface Site {
  file: string;
  line: number;
  call: string;
}

function sites(): Site[] {
  const out: Site[] = [];
  for (const file of sources(SRC)) {
    const rel = relative(SRC, file).split(/[\\/]/).join('/');
    if (rel === 'lib/apps/events.ts') continue; // the definition, not a call
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/emitAppEvent\s*\(/g)) {
      out.push({
        file: rel,
        line: src.slice(0, m.index!).split(/\r?\n/).length,
        call: callAt(src, m.index!),
      });
    }
  }
  return out;
}

describe('every place an app event is announced from', () => {
  const all = sites();

  it('found them — a sweep that counts nothing proves nothing', () => {
    expect(all.length, 'لم يُعثَر على أيّ نداء — المسح لا يمسح').toBeGreaterThanOrEqual(3);
  });

  it('and they are exactly the six the contract was written for (the three it began with, and the three that announce a cancel, a handover and a parcel swap)', () => {
    const files = [...new Set(all.map((s) => s.file))].sort();
    expect(
      files,
      `حدثٌ يُعلَن من مكانٍ لم يُكتَب له عقد:\n${all.map((s) => `  ${s.file}:${s.line}`).join('\n')}`
    ).toEqual(ALLOWED);
  });

  it('and every call carries the four fields the schema requires', () => {
    const missing: string[] = [];
    for (const s of all) {
      for (const field of ['orderId:', 'orderNumber:', 'total: Number(', 'currency:']) {
        if (!s.call.includes(field)) missing.push(`${s.file}:${s.line} — ينقصه «${field}»`);
      }
    }
    expect(missing, `نداءٌ لا يطابق العقد:\n${missing.join('\n')}`).toEqual([]);
  });

  it('and the two state doors say WHICH state, because the schema lets them', () => {
    /*
     * `confirmationStatus` and `shippingStatus` are optional in the schema
     * and are the only thing that tells the replies system what to say.
     * An `order.confirmed` with no status is a message the other side
     * cannot word.
     */
    const confirmation = all.find((s) => s.file.includes('confirmation'))!;
    const shipping = all.find((s) => s.file.includes('shipping'))!;
    expect(confirmation.call, 'باب التأكيد لا يقول الحالة').toContain('confirmationStatus');
    expect(shipping.call, 'باب الشحن لا يقول الحالة').toContain('shippingStatus');
  });
});
