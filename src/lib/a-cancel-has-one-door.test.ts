import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { stripComments } from './guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * AN ORDER IS ENDED BY ONE HELPER — AND THE HELPER FAILS CLOSED.
 *
 * Six doors used to end an order, each with its own idea of what «ended»
 * means, and a parcel on a trolley was cancelled by whichever door the person
 * happened to knock on. Now `endOrder` (src/lib/order-cancel.ts) is the place.
 * This is static, because the thing that goes wrong is not a door that asks
 * wrongly but a SEVENTH door that does not ask:
 *
 *   · nobody but the helper writes the cancelled end state;
 *   · nobody calls the strict 28/09 guard to decide a cancel any more;
 *   · every `cancelVerdict(` names the trolley's status (`batchStatus:`) — the
 *     argument that used to be optional, whose absence read as «not handed
 *     over», the unsafe way round;
 *   · and no cancel door hides a missing field behind a cast.
 * ═══════════════════════════════════════════════════════════════════════
 */

const SRC = join(process.cwd(), 'src');

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

const rel = (f: string) => relative(SRC, f).split(/[\\/]/).join('/');
const read = (f: string) => stripComments(readFileSync(f, 'utf8'));

/** The whole call, paren-counted. */
function callAt(src: string, start: number): string {
  let depth = 0;
  for (let i = src.indexOf('(', start); i < src.length && i < start + 3000; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start, start + 3000);
}

const all = sources(SRC);

describe('who may write the cancelled end state', () => {
  it('found the tree — a sweep that reads nothing proves nothing', () => {
    expect(all.length).toBeGreaterThan(300);
  });

  it('`shippingStatus: \'CANCELLED\'` is written nowhere but in the event the helper announces', () => {
    const hits = all.filter((f) => /shippingStatus:\s*'CANCELLED'/.test(read(f))).map(rel);
    // order-cancel.ts: the golden payload's field. order-state.ts: a `where` that reads the state.
    expect(hits.sort(), 'بابٌ يكتب «ملغى» على الشحن بنفسه').toEqual(['lib/order-cancel.ts', 'lib/order-state.ts']);
  });

  it('`confirmationStatus: \'CANCELLED\' | \'REJECTED\'` as a column is written only by the helper and the void', () => {
    const hits = all
      .filter((f) => /confirmationStatus:\s*'(CANCELLED|REJECTED)'/.test(read(f)))
      .map(rel)
      .filter((f) => !f.startsWith('lib/'));
    /*
     * The void is a CANCELLED + VOIDED ending of its own (our mistake, not the
     * customer's) and is guarded by `assertVoidable`, which refuses any order
     * whose goods are packed — a batched order is always READY_FOR_PICKUP, so it
     * cannot reach it. `confirmation/mine` only READS it, in a `where`.
     */
    expect(hits.sort(), 'بابٌ جديد يُنهي طلباً بلا المساعد').toEqual([
      'app/api/confirmation/issues/[id]/route.ts',
      'app/api/confirmation/mine/route.ts',
    ]);
  });

  it('and the helper is called by every door that ends an order', () => {
    const callers = all.filter((f) => /\bendOrder\s*\(\s*\{/.test(read(f))).map(rel).sort();
    expect(callers).toEqual([
      'app/api/ops/shipments/stand-down/route.ts',
      'app/api/orders/[id]/confirmation/route.ts',
      'app/api/orders/[id]/contact-attempts/route.ts',
      'app/api/orders/[id]/route.ts',
      'app/api/orders/[id]/shipping/route.ts',
    ]);
  });
});

describe('the strict 28/09 guard decides no cancel', () => {
  it('no route or screen calls `assertCancellable`', () => {
    const hits = all
      .filter((f) => /\bassertCancellable\s*\(/.test(read(f)))
      .map(rel)
      .filter((f) => f !== 'lib/order-state.ts');
    expect(hits, 'باب يسأل الحارس الصارم القديم بدل المساعد').toEqual([]);
  });

  it('and no cancel door casts an order to the state shape to get past a missing field', () => {
    const DOORS = [
      'app/api/ops/shipments/stand-down/route.ts',
      'app/api/orders/[id]/confirmation/route.ts',
      'app/api/orders/[id]/contact-attempts/route.ts',
      'app/api/orders/[id]/shipping/route.ts',
      'lib/order-cancel.ts',
    ];
    for (const door of DOORS) {
      const src = read(join(SRC, door));
      expect(src, `${door} يلفّ الطلب بتحويل نوع`).not.toMatch(/as unknown as StateSource/);
    }
  });
});

describe('the trolley’s status is an argument no caller can leave out', () => {
  it('every `cancelVerdict(` in the product names `batchStatus:`', () => {
    const missing: string[] = [];
    let seen = 0;
    for (const f of all) {
      const src = read(f);
      for (const m of src.matchAll(/\bcancelVerdict\s*\(/g)) {
        // The definition itself.
        if (src.slice(Math.max(0, m.index! - 20), m.index!).includes('function ')) continue;
        seen++;
        const call = callAt(src, m.index!);
        // Either the object names it right there, or the argument is a variable DECLARED as
        // `CancelFacts` — whose type makes `batchStatus` required, so the compiler asks for it.
        const ident = /\(\s*([A-Za-z_]\w*)\s*\)/.exec(call)?.[1];
        const typed = ident ? new RegExp(`\\b${ident}: CancelFacts\\b`).test(src) : false;
        if (!call.includes('batchStatus') && !typed) missing.push(`${rel(f)}: ${src.slice(0, m.index!).split(/\r?\n/).length}`);
      }
    }
    expect(seen, 'لا نداء واحد — المسح لا يمسح').toBeGreaterThanOrEqual(4);
    expect(missing, 'نداءٌ لا يقول حالة العربة').toEqual([]);
  });

  it('and the type has no optional way out', () => {
    const src = read(join(SRC, 'lib/shipment-cancel.ts'));
    const facts = src.slice(src.indexOf('export interface CancelFacts'), src.indexOf('export const IN_FLIGHT_AR'));
    for (const field of ['shippingBatchId', 'batchStatus', 'shippedAt', 'labelPrintedAt']) {
      expect(facts, `${field} صار اختيارياً`).toMatch(new RegExp(`\\b${field}: `));
      expect(facts, `${field} صار اختيارياً`).not.toMatch(new RegExp(`\\b${field}\\?:`));
    }
  });

  it('and the old guard refuses a batched order outright — it fails closed on what it cannot see', () => {
    const src = read(join(SRC, 'lib/order-state.ts'));
    expect(src).toMatch(/if \(order\.shippingBatchId\) \{\s*return \{\s*allowed: false,\s*code: 'IN_BATCH'/);
  });
});
