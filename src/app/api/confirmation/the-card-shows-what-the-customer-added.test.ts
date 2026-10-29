import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from '@/lib/guard-source';

/**
 * ط25 — THE AGENT'S CARD SHOWS WHAT THE CUSTOMER ADDED AFTER ORDERING.
 *
 * The card's total already carried the add-on (it is on the order's total), but the card listed only the lines, so the
 * total did not add up and the agent on the phone read the wrong goods. «زيادة بعد الطلب: شامبو ×1 (15)» is one line
 * under the lines, in the same words the order dialog and the history use.
 *
 * «اي قرار بعد الان اتخذو دون الرجوع الي» — decided: only the four fields the line needs are read (never the
 * company or the order ids), and a response without the field (an older server) still renders.
 */

const mine = () => stripComments(repoFile('src/app/api/confirmation/mine/route.ts'));
const pull = () => stripComments(repoFile('src/app/api/confirmation/pull/route.ts'));
const screen = () => stripComments(repoFile('src/components/screens/ConfirmationMineScreen.tsx'));

describe('the doors', () => {
  it('both the desk and the pull read the add-ons, and only what the line needs', () => {
    for (const src of [mine(), pull()]) {
      expect(src).toContain('addOns: { select: { id: true, productName: true, quantity: true, total: true } }');
      expect(src).not.toMatch(/addOns: \{ select: \{[^}]*companyId/);
    }
  });
});

describe('the card', () => {
  it('writes the line with the shared words, the product, the quantity and the total', () => {
    const s = screen();
    expect(s).toContain("import { POST_ORDER_ADDITION_AR } from '@/lib/post-order-offer-copy';");
    expect(s).toContain('{POST_ORDER_ADDITION_AR}: {a.productName} ×{a.quantity} ({a.total})');
  });

  it('NEGATIVE: the field is optional, so a response from before it existed still draws', () => {
    expect(screen()).toContain('addOns?: {');
    expect(screen()).toContain('order.addOns?.map(');
  });
});
