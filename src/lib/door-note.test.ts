import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from './guard-source';
import { NOTE_KINDS } from '@/app/api/orders/[id]/notes/route';

/**
 * WHAT THE FOLLOW-UP AGENT LEARNS HAS TO REACH A PERSON.
 *
 * The note typed beside a delivery went into the delivery attempt row and
 * into the activity's metadata JSON — three machine places and no human one.
 * The order's own note thread, which the confirmation team, the returns desk
 * and the owner all open, never saw it. «رفض القطعة الثانية لأنّ اللون غير
 * المطلوب» was recorded and unreadable.
 *
 * And most of what an agent learns is not an outcome at all: «رنّيت ثلاث
 * مرّات ما ردّ», «المندوب قال بكرة الصبح». The row offered a delivery and a
 * transfer and nothing else, so that went in a notebook and the next person
 * to open the order started from nothing.
 */

const lib = () => stripComments(repoFile('src/lib/partial-delivery.ts'));
const dialog = () => stripComments(repoFile('src/components/screens/tracking/DeliverDialog.tsx'));
const screen = () => stripComments(repoFile('src/components/screens/TrackingScreen.tsx'));
const notesDoor = () => stripComments(repoFile('src/app/api/orders/[id]/notes/route.ts'));

describe('the sentence written at the door', () => {
  it('lands on the order as an internal note', () => {
    const src = lib();
    expect(src, 'الملاحظة ما زالت في البيانات الوصفية فقط').toContain('tx.orderNote.create');
    expect(src).toMatch(/kind: 'internal'/);
    expect(src).toContain('authorId: input.userId');
  });

  /** A note that survives a rolled-back delivery describes nothing. */
  it('in the same transaction as the outcome it explains', () => {
    const src = lib();
    const at = src.indexOf('tx.orderNote.create');
    expect(at).toBeGreaterThan(-1);
    // `tx`, not the bare client — the whole function runs inside one.
    expect(src.slice(at - 40, at)).not.toContain('db.');
  });

  it('and only when something was actually written', () => {
    expect(lib(), 'يكتب ملاحظةً فارغة').toMatch(/if \(input\.note\?\.trim\(\)\) \{/);
  });

  /** Prefixed, because a bare sentence on a thread says nothing about when. */
  it('carrying which of the three outcomes it belongs to', () => {
    const src = lib();
    expect(src).toContain('DOOR_OUTCOME_AR[status]');
    for (const s of ['DELIVERED', 'PARTIALLY_DELIVERED', 'RETURNED']) {
      expect(src, `${s} بلا ترجمة`).toMatch(new RegExp(`${s}: '`));
    }
  });

  it('and the dialog stops calling the field optional', () => {
    const src = dialog();
    expect(src, 'ما زالت تقول «(اختيارية)»').not.toContain('ملاحظة (اختيارية)');
    expect(src).toContain('ملاحظة داخلية على الطلب');
    // And says where it goes, which is the part nobody could guess.
    expect(src).toContain('تُضاف باسمك إلى ملاحظات الطلب');
  });
});

describe('and the third control settles nothing', () => {
  it('exists beside the delivery and the transfer', () => {
    const src = screen();
    // 18/11 (R11d): the note is the kit's `Button` now, so the press is wrapped in a block — `onClick={() => void addNote(o)}`
    // became `onClick={() => { void addNote(o); }}` (the screen keeps its own busy flag, `noting`). The same handler, the same row.
    expect(src, 'لا زرّ للملاحظة').toMatch(/onClick=\{\(\) => \{ void addNote\(o\); \}\}/);
    expect(src).toContain('تحويل');
    // The door's own answers, beside it. They were one «تسجيل التسليم»
    // that opened a line list; they are «استلم», «رفض / ملغى» and the
    // partial case now, and the note still settles none of them.
    expect(src).toContain('استلم');
    expect(src).toContain('رفض / ملغى');
  });

  /**
   * THROUGH THE DOOR THAT ALREADY EXISTS.
   *
   * `POST /api/orders/:id/notes` is the immutable thread every screen reads.
   * A second place for notes to live is how two screens come to show
   * different histories of one order.
   */
  it('through the order notes door, not a new one of its own', () => {
    const src = screen();
    expect(src).toMatch(/`\/api\/orders\/\$\{row\.id\}\/notes`/);
    expect(src).toMatch(/kind: 'follow_up'/);
    expect(NOTE_KINDS).toContain('follow_up');
    // Nothing here touches an outcome.
    /**
     * Sliced to THIS function, not to the next symbol somebody happens to
     * have written below it: a new handler added in between used to land
     * inside the slice and fail a rule it has nothing to do with.
     */
    const at = src.indexOf('const addNote');
    const next = src.indexOf('\n  const ', at + 10);
    const body = src.slice(at, next === -1 ? src.length : next);
    expect(body, 'الملاحظة تُغيّر حالة الطلب').not.toContain('shippingStatus');
    expect(body, 'الملاحظة تسجّل تسليماً').not.toContain('tracking/deliver');
  });

  it('and says so in the dialog, so nobody expects it to', () => {
    expect(screen()).toContain('لا تُغيّر حالة الطلب ولا تُسجّل تسليماً');
  });

  it('refusing an empty one rather than writing a blank', () => {
    const src = screen();
    expect(src).toMatch(/if \(!body\) return;/);
    // The door has its own floor too, so a one-character note is refused there.
    expect(notesDoor()).toContain('الملاحظة قصيرة جدًا');
  });
});
