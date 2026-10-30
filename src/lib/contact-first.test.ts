import { describe, expect, it } from 'vitest';
import {
  needsContactFirst,
  pullRefusal,
  CONTACT_FIRST_ACTIONS,
  CONTACT_FIRST_MESSAGE,
  CLAIM_CAPS,
  type OwnedCounts,
} from './confirmation-queue';
import { repoFile, stripComments } from './guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE CONTACT COMES FIRST — AND NO ORDER GETS STUCK.
 *
 * Measured on this installation: an agent pulled an order, pressed «تأجيل»
 * without ringing anybody, and could not pull again. The pull gate counts
 * held orders with no attempt, so it refused — with «سجّل محاولة اتصال على
 * طلبك الحالي», which named no order and linked nowhere. The order was
 * postponed, so «طلباتي» hid it until its date and «الطلبات المؤجلة»
 * listed it with no contact buttons. Nothing released it for ninety
 * business minutes.
 *
 * One press, an hour and a half of an agent's day, and every door locked.
 *
 * Two halves of one rule: the three buttons that dispose of a held order
 * do not open until she has tried to reach the customer, and a refusal
 * names the order it is about and opens it.
 * ═══════════════════════════════════════════════════════════════════════
 */

const counts = (over: Partial<OwnedCounts> = {}): OwnedCounts => ({
  total: 1,
  withoutAttempt: 0,
  untouched: null,
  ...over,
});

describe('a holder decides nothing before trying to reach the customer', () => {
  it.each([...CONTACT_FIRST_ACTIONS])('%s is refused on an untouched held order', (action) => {
    expect(needsContactFirst({ action, isHolder: true, hasAttempt: false })).toBe(true);
  });

  it.each([...CONTACT_FIRST_ACTIONS])('%s is allowed once an attempt exists', (action) => {
    expect(needsContactFirst({ action, isHolder: true, hasAttempt: true })).toBe(false);
  });

  it('«تأجيل» is bound like the rest — it is the one that caused this', () => {
    // Named on its own because it is the action that looks harmless. It
    // keeps the claim, hides the order, and blocks the next pull.
    expect(CONTACT_FIRST_ACTIONS).toContain('schedule_follow_up');
    expect(needsContactFirst({ action: 'schedule_follow_up', isHolder: true, hasAttempt: false })).toBe(true);
  });

  /**
   * THE ACTIONS THAT ARE NOT A DISPOSAL.
   *
   * `start` is picking the order up; `contact_result` is the recording of
   * the very attempt being demanded — binding it would be a door locked
   * with its own key inside. `resolve_follow_up` closes a follow-up that
   * an earlier attempt already created.
   */
  it.each(['start', 'contact_result', 'resolve_follow_up'])('%s is never bound', (action) => {
    expect(needsContactFirst({ action, isHolder: true, hasAttempt: false })).toBe(false);
  });

  it('and somebody who does not hold the order is not bound at all', () => {
    // A supervisor cancelling a fake order, or the owner closing something
    // from a report, never pulled anything and is not working a queue.
    for (const action of CONTACT_FIRST_ACTIONS) {
      expect(needsContactFirst({ action, isHolder: false, hasAttempt: false })).toBe(false);
    }
  });

  it('and the sentence names the way out, not just the refusal', () => {
    // «لا يرد» is a real attempt. An agent whose customer does not pick up
    // must not be stuck behind a rule that only accepts a conversation.
    expect(CONTACT_FIRST_MESSAGE).toContain('لا يرد');
  });
});

describe('a refused pull names the order it is about', () => {
  it('and carries its id, so the screen can open it', () => {
    const refusal = pullRefusal(
      counts({ withoutAttempt: 1, untouched: { id: 'o-77', orderNumber: 'ORD-2026-0077' } })
    );
    expect(refusal?.code).toBe('UNTOUCHED_ORDER');
    expect(refusal).toMatchObject({ orderId: 'o-77', orderNumber: 'ORD-2026-0077' });
    expect(refusal?.message, 'الرفض لا يُسمّي الطلب').toContain('ORD-2026-0077');
  });

  it('and still refuses when it cannot name one, rather than letting the pull through', () => {
    // The gate is the rule; the name is the courtesy. A refusal that
    // disappeared because the lookup found nothing would hand the agent a
    // second untouched order.
    const refusal = pullRefusal(counts({ withoutAttempt: 1, untouched: null }));
    expect(refusal?.code).toBe('UNTOUCHED_ORDER');
    expect(refusal).toMatchObject({ orderId: null });
  });

  it('and the caps still answer first — they are the harder ceiling', () => {
    expect(pullRefusal(counts({ total: CLAIM_CAPS.total, withoutAttempt: 1 }))?.code).toBe('CAP_TOTAL');
    expect(
      pullRefusal(counts({ withoutAttempt: CLAIM_CAPS.withoutAttempt }))?.code
    ).toBe('CAP_WITHOUT_ATTEMPT');
  });

  it('and nothing is refused when she holds nothing untouched', () => {
    expect(pullRefusal(counts())).toBeNull();
  });
});

describe('the rule is kept where it cannot be walked around', () => {
  const route = () => stripComments(repoFile('src/app/api/orders/[id]/confirmation/route.ts'));

  it('the server asks before the action switch, not inside one case', () => {
    /*
     * Before the switch on purpose: a guard written into `confirm` alone
     * leaves «تأجيل» open, and «تأجيل» is the one that cost the day.
     */
    const src = route();
    expect(src).toMatch(/needsContactFirst\(\{/);
    expect(src).toMatch(/code: 'CONTACT_FIRST'/);
    expect(
      src.indexOf('needsContactFirst'),
      'الحارس بعد توزيع الإجراءات — فمنفذٌ واحدٌ يكفي لتجاوزه'
    ).toBeLessThan(src.indexOf("switch (action)"));
  });

  it('and it asks whether this user HOLDS the order, not whether he may edit it', () => {
    expect(route()).toMatch(/isHolder: order\.claimedById === user\.id/);
  });

  it('and it answers 409, so the screen can tell the two refusals apart', () => {
    // 403 would read as «you are not allowed», which is wrong: she is
    // allowed, she has not done the thing yet.
    expect(route()).toMatch(/code: 'CONTACT_FIRST',\s*\},\s*\{ status: 409 \}/);
  });
});

describe('the screen says it before she presses, not after', () => {
  const screen = () => stripComments(repoFile('src/components/screens/ConfirmationMineScreen.tsx'));

  it('the four actions are locked until an attempt exists', () => {
    const src = screen();
    /*
     * FOUR, NOT THREE — «افتح وعدّل» joined them.
     *
     * It used to be the way around the other three: an agent who had rung
     * nobody could open the order, change the quantity, the price or the
     * address, and save, while «تأكيد» and «تأجيل» and «ألغِ» were locked
     * behind this very rule. The owner's words: it opens after a contact
     * attempt too.
     */
    // `locked`, not `busy`: a button that looks like it is saving for ever
    // teaches her nothing.
    // CHANGED 30/10 (the owner: «٥ تمام») — was 4, now 3: «ألغِ» is no longer a locked button; it opens a dialog that
    // shuts only the reasons that need a word with the customer (and the server keeps the same line).
    expect((src.match(/locked=\{needsContact\(order\)\}/g) ?? []).length, 'ليست الثلاثة').toBe(3);
    expect(src, 'الحوار لا يعرف إن كان للطلب محاولة').toMatch(/hasAttempt=\{!needsContact\(dialog\.order\)\}/);
    expect(src).toMatch(/const needsContact = \(order: \{ _count: \{ contactAttempts: number \} \}\) =>\s*order\._count\.contactAttempts === 0/);
  });

  it('and a line under them says why', () => {
    expect(screen()).toContain('اتصل بالزبون أول — بعدها بتفتح الأزرار');
  });

  it('and the doors that are not a disposal stay open', () => {
    const src = screen();
    for (const open of ['إدخال إشكال', 'مساعدة']) {
      const at = src.indexOf(open);
      expect(at, `«${open}» غير موجود`).toBeGreaterThan(-1);
      // The 300 characters before the label hold that button's props.
      expect(src.slice(Math.max(0, at - 300), at), `«${open}» صار مقفولاً`).not.toMatch(/locked=\{/);
    }
  });

  it('and the pull panel opens the order the refusal names', () => {
    const q = stripComments(repoFile('src/components/confirmation/PullPanel.tsx'));
    expect(q).toMatch(/data\.refusal\?\.code === 'UNTOUCHED_ORDER' && data\.refusal\.orderId/);
    // On her own desk, where the order window opens through the work door — not
    // «الطلبات», which asks «عرض الطلبات» (see the-pull-panel.test.tsx for the press).
    expect(q).toMatch(/href=\{`\/confirmation\/mine\?open=\$\{encodeURIComponent\(data\.refusal\.orderId\)\}`\}/);
    expect(q, 'رجع الرابط لشاشة الطلبات').not.toMatch(/href=\{`\/orders\/\$\{data\.refusal\.orderId\}`\}/);
  });
});
