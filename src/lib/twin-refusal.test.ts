import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_CONVERSATION_REJECTION_REASONS, REJECTION_REASONS, rejectionNeedsConversation } from './confirmation-workflow';
import { repoFile, stripComments } from './guard-source';
import {
  TWIN_CONFIRMED_CODE,
  TWIN_FORM_NEXT,
  confirmAnywayBody,
  rejectAsDuplicateBody,
  twinConfirmedSentence,
  twinFormReason,
  twinsFromRefusal,
} from './twin-refusal';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE WORDS AND THE SHAPE OF «الزبون عنده طلب مؤكَّد بنفس المنتج», FOR THE SERVER AND FOR EVERY SCREEN (the owner, 2/11).
 *
 * One sentence, one parser, two bodies — written once in a file that imports nothing, so a screen can read it. And the wiring
 * claims no behaviour test can see from inside one file: who may write the acknowledgement, what the guard may touch, and that it
 * carries no customer.
 * ═══════════════════════════════════════════════════════════════════════
 */

const TWIN = { orderNumber: 'ORD-2026-1711', confirmedAt: '2026-11-02T09:30:00.000Z', confirmedByName: 'سارة' };

describe('the sentence', () => {
  it('names the orders and says both ways out, in Arabic', () => {
    expect(twinConfirmedSentence(['ORD-1'])).toBe(
      'الزبون عنده طلب مؤكَّد بنفس المنتج (ORD-1) — إذا هالطلب مكرر ارفضه كمكرر، وإذا طلب تاني فعلاً أكّده وانت متأكد'
    );
    expect(twinConfirmedSentence(['ORD-1', 'ORD-2'])).toContain('(ORD-1، ORD-2)');
    expect(twinConfirmedSentence([])).not.toContain('(');
  });

  it('the form’s reason names them too, and its advice is not «press it again»', () => {
    expect(twinFormReason([TWIN, { ...TWIN, orderNumber: 'ORD-2026-1701' }])).toBe('عند الزبون طلب مؤكَّد بنفس المنتج (ORD-2026-1711، ORD-2026-1701)');
    expect(twinFormReason([])).toBe('عند الزبون طلب مؤكَّد بنفس المنتج');
    expect(TWIN_FORM_NEXT).toContain('ارفضه كمكرر');
    expect(TWIN_FORM_NEXT).not.toBe('أكّده من شاشة الطلبات.');
  });
});

describe('reading a refusal', () => {
  it('the twin refusal reads as its twins', () => {
    expect(twinsFromRefusal({ code: TWIN_CONFIRMED_CODE, twins: [TWIN] })).toEqual([TWIN]);
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a string', 'TWIN_CONFIRMED'],
    ['a number', 409],
    ['another code', { code: 'CONTACT_FIRST', twins: [TWIN] }],
    ['no code', { twins: [TWIN] }],
    ['a code in the wrong case', { code: 'twin_confirmed', twins: [TWIN] }],
  ])('anything that is not that refusal reads as null — %s', (_name, data) => {
    expect(twinsFromRefusal(data)).toBeNull();
  });

  it('inside the refusal, a twin that is not well-formed is dropped and the rest are kept', () => {
    expect(
      twinsFromRefusal({
        code: TWIN_CONFIRMED_CODE,
        twins: [null, 7, {}, { orderNumber: '' }, { orderNumber: 5 }, { orderNumber: 'ORD-9', confirmedAt: 12, confirmedByName: '' }, TWIN],
      })
    ).toEqual([{ orderNumber: 'ORD-9', confirmedAt: null, confirmedByName: null }, TWIN]);
  });

  it('a refusal with the code and no list is still the question — an empty one, not a dead end', () => {
    expect(twinsFromRefusal({ code: TWIN_CONFIRMED_CODE })).toEqual([]);
    expect(twinsFromRefusal({ code: TWIN_CONFIRMED_CODE, twins: 'x' })).toEqual([]);
  });
});

describe('the two bodies the dialog’s buttons send', () => {
  it('«رفضه كمكرر» is the door’s own reject with the reason that already exists, at the given version', () => {
    expect(rejectAsDuplicateBody(7)).toEqual({ action: 'reject', rejectionReason: 'DUPLICATE_ORDER', expectedVersion: 7 });
  });

  it('and that reason is one the door accepts WITHOUT a call — the agent has just been told it is a duplicate, she has nobody to ring', () => {
    const reason = rejectAsDuplicateBody(1).rejectionReason;
    expect(REJECTION_REASONS as readonly string[]).toContain(reason);
    expect(NO_CONVERSATION_REJECTION_REASONS as readonly string[]).toContain(reason);
    expect(rejectionNeedsConversation(reason)).toBe(false);
  });

  it('«طلب تاني فعلاً — أكّد» is the confirm again with her word, at the given version, carrying her note only when she wrote one', () => {
    expect(confirmAnywayBody(7)).toEqual({ action: 'confirm', acknowledgeTwin: true, expectedVersion: 7 });
    expect(confirmAnywayBody(7, '  الزبون أكد الطلبين  ')).toEqual({
      action: 'confirm',
      acknowledgeTwin: true,
      expectedVersion: 7,
      note: 'الزبون أكد الطلبين',
    });
    expect(confirmAnywayBody(7, '   ')).not.toHaveProperty('note');
    expect(confirmAnywayBody(7, '')).not.toHaveProperty('note');
  });
});

/* ───────────────────────── the wiring ───────────────────────── */

function everyProductionFile(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '.next') continue;
      everyProductionFile(p, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(relative(process.cwd(), p).replace(/\\/g, '/'));
    }
  }
  return out;
}
const code = (rel: string) => stripComments(repoFile(rel));

describe('who may say «I know» — and who may not', () => {
  const files = everyProductionFile(join(process.cwd(), 'src'));

  it('`acknowledgeTwin: true` is written in ONE production file, and nothing else in the product can confirm past the guard', () => {
    const writers = files.filter((f) => /acknowledgeTwin\s*:\s*true/.test(code(f)));
    expect(writers).toEqual(['src/lib/twin-refusal.ts']);
  });

  it('the door READS it, and only as a literal true', () => {
    const readers = files.filter((f) => /acknowledgeTwin/.test(code(f))).sort();
    expect(readers).toEqual(['src/app/api/orders/[id]/confirmation/route.ts', 'src/lib/twin-refusal.ts']);
    expect(code('src/app/api/orders/[id]/confirmation/route.ts')).toContain('acknowledgeTwin !== true');
  });

  it('no automatic path confirms with it: the form, the Telegram door, the systems door and the AI intake never name it', () => {
    for (const f of ['src/lib/confirm-now.ts', 'src/lib/telegram/order-creation.ts', 'src/lib/v1/order-intake.ts', 'src/app/api/orders/ai-intake/route.ts', 'src/lib/public-order.ts']) {
      expect(code(f), f).not.toMatch(/acknowledgeTwin|confirmAnywayBody/);
    }
  });
});

describe('the guard’s own file', () => {
  const src = code('src/lib/confirmed-twin.ts');

  it('writes one kind of row — a history row — and never an order, a line, a customer or stock', () => {
    const writes = [...src.matchAll(/\.(\w+)\.(create|update|updateMany|delete|deleteMany|upsert|createMany)\(/g)].map((m) => `${m[1]}.${m[2]}`);
    expect(writes).toEqual(['orderActivity.create']);
  });

  it('is never sent a name, a phone or an address, and cannot reach a model or the network', () => {
    expect(src).not.toMatch(/fullName|phone|address|customerName|rawPhone/i);
    expect(src).not.toMatch(/aiChat|fetch\(|ai-provider/);
  });

  it('takes its lock with `$executeRaw` like the other two lock sites — a void result read through `$queryRaw` would make every yes a 500', () => {
    expect(src).toContain('tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(');
    expect(src).not.toContain('$queryRaw');
    expect(code('src/lib/reservation.ts')).toContain('$executeRaw`SELECT pg_advisory_xact_lock(');
    expect(code('src/lib/manual-statement.ts')).toContain('$executeRaw`SELECT pg_advisory_xact_lock(');
  });

  it('asks the lock BEFORE it reads anything, in the source as in the behaviour', () => {
    const guard = src.slice(src.indexOf('export async function guardConfirmAgainstTwins'));
    expect(guard.indexOf('$executeRaw')).toBeGreaterThan(-1);
    expect(guard.indexOf('$executeRaw')).toBeLessThan(guard.indexOf('orderItem.findMany'));
    expect(guard.indexOf('orderItem.findMany')).toBeLessThan(guard.indexOf('findConfirmedTwins('));
  });

  it('asks «still ours» through the one rendering of the handover line, and «the same product» through its own clause', () => {
    expect(src).toContain('notHandedToCourierWhere()');
    expect(src).toContain('sameProductWhere(');
    // no hand-written list of shipping statuses beside the one rule
    expect(src).not.toMatch(/'(?:SHIPPED|DELIVERED|READY_FOR_PICKUP|OUT_FOR_DELIVERY|RETURNED)'/);
  });

  it('is read from a transaction by the door and from nowhere else in the product', () => {
    const files = everyProductionFile(join(process.cwd(), 'src')).filter((f) => f !== 'src/lib/confirmed-twin.ts');
    const importers = files.filter((f) => /from '(?:@\/lib|\.)\/confirmed-twin'/.test(code(f))).sort();
    expect(importers).toEqual(['src/app/api/orders/[id]/confirmation/route.ts', 'src/lib/order-timeline.ts']);
  });
});

describe('the shared words are readable from a screen', () => {
  it('twin-refusal.ts imports nothing: no database, no server module can ride into a client bundle with it', () => {
    expect(code('src/lib/twin-refusal.ts')).not.toMatch(/^\s*import\s/m);
  });

  it('and the dialog, the screens and the form import it and not the server file', () => {
    for (const f of ['src/components/orders/TwinConfirmedDialog.tsx', 'src/components/orders/ConfirmationActions.tsx', 'src/components/screens/ConfirmationMineScreen.tsx', 'src/lib/confirm-now.ts']) {
      expect(code(f), f).not.toMatch(/from '(?:@\/lib|\.)\/confirmed-twin'/);
    }
  });
});
