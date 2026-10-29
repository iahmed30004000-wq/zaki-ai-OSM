import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from './guard-source';

/**
 * THE TWO BUTTONS AND THE NOTES REACH THE SCREEN WHERE THE DIFFERENCE IS.
 *
 * «حط زر أشاهد التعليقات الداخلية، وزر ترحيل على اعتماد… بس بضل الطلب
 * معلّم.» A rule that decides what a resolution means changes nothing while
 * the row still shows two numbers and no way to answer them.
 */

const route = () => stripComments(repoFile('src/app/api/finance/statements/[id]/matches/[matchId]/resolve/route.ts'));
const screen = () => stripComments(repoFile('src/components/screens/finance/MatchingScreen.tsx'));
const actions = () => stripComments(repoFile('src/components/screens/finance/DifferenceActions.tsx'));

describe('the route that records which figure stands', () => {
  it('refuses to record a reason on a line that matched', () => {
    const src = route();
    expect(src.length).toBeGreaterThan(500);
    expect(src).toMatch(/if \(!isDifference\(match\)\)/);
    expect(src).toContain("code: 'NOT_A_DIFFERENCE'");
  });

  /**
   * AND IT MOVES NO MONEY. A resolution records WHY two figures differ; the
   * money is moved by the receipt and the approval, each with its own
   * permission and its own audit. A wallet write from here would be a
   * second money path into settlement, reached from a button whose label
   * says «record the reason».
   */
  it('and writes no money anywhere', () => {
    const src = route();
    for (const forbidden of ['walletMovement', 'financialTransaction', 'settlementStatus', 'collectedAmount']) {
      expect(src, `${forbidden} في مسار تسجيل السبب`).not.toContain(forbidden);
    }
  });

  it('writes the decision back to the order, where the discount was written', () => {
    const src = route();
    expect(src).toMatch(/tx\.orderNote\.create\(\{/);
    expect(src).toMatch(/kind: 'internal'/);
    expect(src).toMatch(/action: 'SETTLEMENT_DIFFERENCE_RESOLVED'/);
  });

  it('and is asked for the settlement permission, not merely a login', () => {
    expect(route()).toContain("requirePermission('settlement.review')");
  });
});

describe('the screen', () => {
  /*
   * REWRITTEN (كلمات الشركة والأصفار). It said «offers the actions on every difference queue» and counted
   * `resolvable` at least four times — three queues carried «رقمنا / رقمهم». Only «فرق في المبلغ» has two
   * figures to choose between; the other two have one figure each, and answering them with a choice of
   * figures recorded nothing true and counted them in the per-person tally. «في الكشف وليس عندنا» now
   * shows the company's reason, and «طلبات لم يذكرها أي كشف» (the old «مسلَّم عندنا وليس في الكشف»)
   * offers three actions on the order instead.
   */
  it('offers رقمنا / رقمهم on «فرق في المبلغ» only — not on the matched, not on the two missing queues', () => {
    const src = screen();
    expect(src.length).toBeGreaterThan(2000);
    const queueOf = (title: string) => {
      const at = src.indexOf(`title="${title}"`);
      expect(at, title).toBeGreaterThan(0);
      return src.slice(at, src.indexOf('/>', at));
    };
    expect(queueOf('فرق في المبلغ')).toContain('resolvable');
    for (const title of ['مطابق', 'في الكشف وليس عندنا', 'طلبات لم يذكرها أي كشف']) {
      expect(queueOf(title), `${title}: صار فيه رقمنا/رقمهم`).not.toContain('resolvable');
    }
    // And the third queue carries its own actions, on the order.
    expect(queueOf('طلبات لم يذكرها أي كشف')).toContain('unmentioned');
    expect(src).toContain('<NotMentionedActions');
  });

  it('the old name of the fourth queue is gone, and the new one is on the screen', () => {
    const src = screen();
    expect(src).not.toContain('مسلَّم عندنا وليس في الكشف');
    expect(src).toContain('طلبات لم يذكرها أي كشف');
  });

  it('shows the company’s own reason — its word and its whole row — and the order’s outcome word', () => {
    const src = screen();
    expect(src).toContain('سبب الشركة بكلامها');
    expect(src).toMatch(/statementLine\?\.rawRow/);
    expect(src).toContain('m.courierWord');
    expect(src).toContain('m.orderOutcome');
  });

  it('and redraws the queue after an answer, so the chip is the saved one', () => {
    expect(screen()).toMatch(/onResolved=\{\(\) => void load\(selected!\)\}/);
  });

  it('carries the resolution down from the API rather than guessing it', () => {
    expect(screen()).toMatch(/resolution: string \| null;/);
    expect(screen()).toMatch(/resolution=\{m\.resolution\}/);
  });
});

describe('the actions themselves', () => {
  it('show both answers, each with what it does to the money', () => {
    const src = actions();
    expect(src).toMatch(/RESOLUTIONS\.map/);
    expect(src).toMatch(/title=\{RESOLUTION_MEANING\[r\]\}/);
  });

  it('and the notes button reads the order’s own notes, internal only', () => {
    /*
     * The button and its modal moved to `OrderNotesPeek` on 2026-10-02, so the
     * returns desk could have them too — the contract surfaces notes in four
     * places and that was the one with an input and no way to read. This
     * screen now says WHICH kinds it wants, and the shared component is what
     * fetches; both halves are still checked, in their new homes.
     */
    const src = actions();
    expect(src).toMatch(/<OrderNotesPeek/);
    expect(src).toMatch(/kinds=\{INTERNAL_ONLY\}/);
    expect(src).toMatch(/const INTERNAL_ONLY = \['internal'\] as const;/);

    const peek = repoFile('src/components/orders/OrderNotesPeek.tsx');
    expect(peek).toMatch(/\/api\/orders\/\$\{orderId\}\/notes/);
    // The filter is the component's, and it must honour the kinds it is given
    // rather than showing everything when a screen asked for one kind.
    expect(peek).toMatch(/kinds \? \(notes \?\? \[\]\)\.filter\(\(n\) => kinds\.includes\(n\.kind\)\) : \(notes \?\? \[\]\)/);
  });

  /**
   * «بس بضل الطلب معلّم» — answering does not remove the row from the
   * difference queue, and the chip is not a green tick that says it never
   * happened.
   */
  it('and an answered row keeps its place, with the answer shown on it', () => {
    const src = actions();
    expect(src).toMatch(/if \(resolution\) \{/);
    expect(src).toMatch(/RESOLUTION_AR\[resolution as Resolution\]/);
    expect(src, 'الصفّ يختفي بعد البتّ').not.toMatch(/return null;/);
  });
});
