/**
 * «الطلب من المعاينة طلب حقيقي» — said beside the order form, and only to the
 * seller who came in through «المعاينة الحقيقية».
 *
 * The preview draws the shop's real form (the one the order door enforces),
 * and the door does not know who is pressing: an order placed here is an
 * order, with a number, in the list, for somebody to call. Saying so where
 * the button is, is the smaller safe change — the form and the door are not
 * touched. A customer never sees this: the shell and the pages draw it only
 * for `store.quiet`, which `getShopView` sets for the preview door alone.
 */
export function PreviewOrderNote() {
  return (
    <p
      role="note"
      style={{
        margin: '0 0 12px', padding: '8px 12px', borderRadius: 8, fontSize: 13, fontWeight: 700, lineHeight: 1.6,
        background: 'var(--store-accent-tint)', color: 'var(--store-text)', border: '1px dashed var(--store-border)',
      }}
    >
      الطلب من المعاينة طلب حقيقي — بيوصل لقائمة الطلبات متل أي طلب.
    </p>
  );
}
