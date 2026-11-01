import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from './guard-source';
import { ALL_CATALOG_KEYS } from './permission-catalog';

/**
 * «الطباعة في خانة الطلبات غير موجودة اختفت».
 *
 * It had not been removed. It lived in the bulk bar — and the bulk bar
 * appears only once a row is ticked, so a screen opened fresh had no print
 * control anywhere on it. Measured first, because the other explanation
 * was a permission: `ops.labels` is held by the owner, the manager, the
 * shipping manager and the warehouse, so that was not it.
 *
 * The act it was missing is the common one: one parcel, one waybill, from
 * the row. Reaching that through a checkbox built for batches is a step
 * for nothing, and a screen whose only print button is conditional on a
 * selection is a screen where printing looks deleted.
 */

const screen = () => stripComments(repoFile('src/components/screens/OrdersScreen.tsx'));

describe('printing a waybill', () => {
  it('is reachable from the row itself, not only from the bulk bar', () => {
    const src = screen();
    expect(src).toMatch(/handlePrintLabels\('print', \[order\.id\]\)/);
    // And the bulk path stays for a stack of them.
    expect(src).toMatch(/handlePrintLabels\('print'\)/);
  });

  it('and the handler takes the row it was given, not the ticked set', () => {
    const src = screen();
    expect(src).toMatch(/const handlePrintLabels = async \(mode: 'print' \| 'pdf' = 'print', only\?: string\[\]\)/);
    expect(src).toMatch(/const ids = only \?\? \[\.\.\.selected\]/);
    // The request carries that list — not `selected` again, which is the
    // bug this shape exists to make impossible.
    expect(src).toMatch(/openWaybills\(\{ orderIds: ids/);
    expect(src, 'الطلبُ يطبع المحدَّد بدل الصفّ').not.toMatch(/orderIds: \[\.\.\.selected\]/);
  });

  it('and appears only where it can actually produce one', () => {
    const src = screen();
    // A waybill needs a confirmed order; a button that answers with a
    // refusal is worse than no button. Whoever holds the owner's key
    // (`ops.labels_any`) prints any order in any state, so for her every row
    // can produce one — and for nobody else is the button drawn on an
    // unconfirmed row.
    expect(src).toMatch(/canPrint && \(canPrintAny \|\| order\.confirmationStatus === 'CONFIRMED'\) &&/);
    expect(src).toMatch(/const canPrintAny = userCan\(currentUser, 'ops\.labels_any'\)/);
    expect(ALL_CATALOG_KEYS.has('ops.labels_any'), 'مفتاح المالك غير قابل للمنح').toBe(true);
  });

  it('and the permission behind it is one somebody can be granted', () => {
    expect(ALL_CATALOG_KEYS.has('ops.labels'), 'صلاحية الطباعة غير قابلة للمنح').toBe(true);
    expect(screen()).toMatch(/userCan\(currentUser, 'ops\.labels'\)/);
  });
});
