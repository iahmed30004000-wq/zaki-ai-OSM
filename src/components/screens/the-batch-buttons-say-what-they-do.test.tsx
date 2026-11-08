// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

/**
 * «وظيفة كل زر ومتى بضغطو؟ وشو بيعمل؟» (the owner, 8/11) — the buttons of a shipping batch, said on the card itself.
 *
 *   · the fold lists ONLY the presses this card has — the same facts that decide whether each button is drawn decide which are
 *     described, so the help cannot describe a button that is not there, nor miss one that is. That includes the list of the
 *     batch's parcels and the presses on each parcel: they are drawn from the very list the help names them from;
 *   · each sentence is what the code does, held here by what the code ANSWERS where it can be called (a postponement after the
 *     handover is refused; only a cancellation becomes a request) and not only by the words: the handover cannot be undone,
 *     «خرج للتوصيل لكل الدفعة» counts the parcels at «مشحون», sends nothing to the customer and leaves a refused parcel named at
 *     «مشحون», a paste is refused for a connected courier before the dispatch, and a courier connected by API moves a parcel
 *     along by itself.
 */
const { apiJson, held, phone } = vi.hoisted(() => ({ apiJson: vi.fn(), held: new Set<string>(), phone: { value: false } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/ops/batches',
}));
vi.mock('@/components/ui/Confirm', () => ({ useAsk: () => async () => null, useConfirm: () => async () => true, useTell: () => vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn() }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/hooks/useCan', () => ({ useCan: (k: string) => held.has(k) }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: null }) }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<void>) => {
    React.useEffect(() => { void load(); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  },
}));
vi.mock('@/components/labels/LabelSize', () => ({ useLabelSize: () => ({ dims: { width: 100, height: 150 } }), LabelSizePicker: () => null }));
vi.mock('@/components/labels/openWaybills', () => ({ BLOCKED_WAYBILLS: 'x', describeRefused: () => '', openWaybills: vi.fn(), WaybillError: class extends Error {} }));
vi.mock('@/components/scan/ScanButton', () => ({ ScanSheet: () => null }));
vi.mock('@/components/orders/OrderLink', () => ({ OrderLink: ({ number }: { number: string }) => <span>{number}</span> }));

import { ShippingBatchesScreen } from './ShippingBatchesScreen';
import { batchHelpItems, LEAVE_PRESSES, type BatchHelpFacts } from './BatchButtonsHelp';
import { carryOut } from '@/lib/change-request-intent';

const WAIT = { timeout: 8000 };
const SUMMARY = 'شو بيعمل كل زر ومتى بتضغطو؟';
const PARCELS = 'طرود الدفعة';

const batch = (over: Record<string, unknown> = {}, provider: Record<string, unknown> = {}) => ({
  id: 'b1', batchNumber: 'BATCH-2026-0001', status: 'READY',
  provider: { id: 'dp1', name: 'الباشا', code: 'BASHA', kind: 'COMPANY', apiEnabled: true, ...provider },
  creator: { id: 'u1', name: 'Qabas' }, createdAt: '2026-11-01T10:00:00.000Z', shippedAt: null, notes: null,
  _count: { orders: 51 }, courierCityGap: null, shippedCount: 0, ...over,
});

/** What `GET /api/shipping-batches/:id` answers when the list of a batch's parcels is opened. */
const parcelsPayload = (over: Record<string, unknown> = {}) => ({
  batch: {
    orders: [{ id: 'o1', orderNumber: 'ORD-2026-0001', trackingNumber: null, version: 3, customer: { fullName: 'سلمى', phone: null }, items: [] }],
  },
  canEditInBatch: true,
  currency: null,
  ...over,
});

const mountWith = async (b: ReturnType<typeof batch>, keys: string[] = [], parcels: Record<string, unknown> = parcelsPayload()) => {
  held.clear();
  keys.forEach((k) => held.add(k));
  apiJson.mockImplementation(async (url: string) =>
    url.startsWith('/api/shipping-batches/b1') ? parcels : { batches: [b], pagination: { total: 1 } });
  render(<ShippingBatchesScreen />);
  await screen.findByText(b.batchNumber, undefined, WAIT);
};
const card = () => screen.getByText('BATCH-2026-0001').closest('li') as HTMLElement;
const help = () => within(card()).getByText(SUMMARY).closest('details') as HTMLElement;
const helpNames = () => Array.from(help().querySelectorAll('li')).map((li) => li.firstElementChild!.textContent!);
const helpItem = (name: string) => Array.from(help().querySelectorAll('li')).find((li) => li.firstElementChild!.textContent === name)!;
const buttons = () => Array.from(card().querySelectorAll('button')).map((b) => (b.textContent ?? '').trim());

/** Opens the batch's parcels list the way a person does, and waits for the parcel to be drawn. */
const openParcels = async () => {
  fireEvent.click(within(card()).getByText(/طرود الدفعة وتفاصيلها|طرود الدفعة — ابحث عن طلب/));
  await within(card()).findByText('ORD-2026-0001', undefined, WAIT);
};
/** The presses drawn on a parcel row (the copy buttons of the order number are not presses of the batch). */
const parcelPresses = () => {
  // The card sits in the page's own divided list, so the parcels list is found INSIDE the card, not by a selector that could climb out.
  const list = Array.from(card().querySelectorAll('ul')).find((u) => u.className.includes('divide-y'));
  return list
    ? Array.from(list.querySelectorAll('button'))
        .map((b) => (b.textContent ?? '').trim())
        .filter((t) => t && !t.startsWith('ORD-'))
    : [];
};

/** The facts of a card, as the screen builds them. */
const facts = (over: Partial<BatchHelpFacts> = {}): BatchHelpFacts => ({
  dispatch: true, paste: true, ship: true, out: 51, courierSendsStatus: true, xlsx: false, parcels: true, leave: true, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
});
afterEach(cleanup);

describe('the help lists only the presses the card has', () => {
  it('a ready batch for a courier connected by API: the dispatch, the paper, the check, the handover and the parcels — and no «خرج للتوصيل»', async () => {
    await mountWith(batch(), ['ops.batches', 'orders.change_status']);
    expect(helpNames()).toEqual([
      'رحّل إلى الشركة واجلب الباركود',
      'طباعة بوالص الدفعة · PDF · CSV',
      'تحقّق من الطرود',
      'إغلاق الشحنة — سُلّمت للشركة',
      PARCELS,
    ]);
  });

  it('a manual courier has no dispatch and says so; the paste is there when the person may ship', async () => {
    await mountWith(batch({}, { apiEnabled: false }), ['ops.ship']);
    expect(helpNames()).toEqual(['لصق الباركودات', 'طباعة بوالص الدفعة · PDF · CSV', 'تحقّق من الطرود', 'إغلاق الشحنة — سُلّمت للشركة', PARCELS]);
  });

  it('a handed-over batch with parcels still at «مشحون» gets the out-for-delivery press, with its count, and no handover', async () => {
    await mountWith(batch({ status: 'SHIPPED', shippedCount: 51 }), ['ops.batches', 'orders.change_status']);
    expect(helpNames()).toEqual(['طباعة بوالص الدفعة · PDF · CSV', 'تحقّق من الطرود', 'خرج للتوصيل لكل الدفعة (51)', PARCELS]);
  });

  it('without the keys that draw the out-for-delivery press, it is not described either', async () => {
    await mountWith(batch({ status: 'SHIPPED', shippedCount: 51 }), ['ops.batches']);
    expect(buttons().some((t) => t.includes('خرج للتوصيل لكل الدفعة'))).toBe(false);
    expect(helpNames().some((n) => n.includes('خرج للتوصيل'))).toBe(false);
  });

  it('with the address-book key the Excel file is drawn and described', async () => {
    await mountWith(batch(), ['ops.batches', 'customers.view']);
    expect(buttons()).toContain('إكسل');
    expect(helpNames()).toContain('طباعة بوالص الدفعة · PDF · CSV · إكسل');
  });

  it('every stage press drawn on the card has its own sentence, and every sentence is for a press that is drawn', async () => {
    await mountWith(batch({ status: 'READY', shippedCount: 0 }), ['ops.batches', 'orders.change_status', 'ops.ship']);
    const drawn = buttons();
    for (const stage of ['رحّل إلى الشركة واجلب الباركود', 'لصق الباركودات', 'إغلاق الشحنة — سُلّمت للشركة', PARCELS]) {
      expect(drawn.some((t) => t.includes(stage)), stage).toBe(true);
      expect(helpNames().some((n) => n.includes(stage)), stage).toBe(true);
    }
    for (const name of helpNames()) {
      for (const part of name.split(' · ')) {
        const caption = part.replace(/ \(\d+\)$/, '');
        expect(drawn.some((t) => t.includes(caption)), caption).toBe(true);
      }
    }
  });

  it('a batch without a parcel has no list to open, and no sentence about one', async () => {
    await mountWith(batch({ _count: { orders: 0 } }), ['ops.batches', 'orders.change_status']);
    expect(buttons().some((t) => t.includes(PARCELS))).toBe(false);
    expect(helpNames()).not.toContain(PARCELS);
  });

  it('on a phone the same fold is there, once', async () => {
    phone.value = true;
    await mountWith(batch(), ['ops.batches', 'orders.change_status']);
    expect(within(card()).getAllByText(SUMMARY)).toHaveLength(1);
  });

  it('the fold starts closed: a screen of forty batches is not forty paragraphs', async () => {
    await mountWith(batch(), ['ops.batches']);
    expect((help() as HTMLDetailsElement).open).toBe(false);
  });
});

describe('the parcels list: the presses drawn on a parcel are the presses the help names', () => {
  it('a ready batch: «عدّل» and the three ways off the trolley are drawn on a parcel, and every one is in the help — in both directions', async () => {
    await mountWith(batch(), ['ops.batches']);
    await openParcels();
    const drawn = parcelPresses();
    expect(drawn).toEqual(['عدّل', ...LEAVE_PRESSES.map(([, label]) => label)]);
    expect(drawn).toEqual(['عدّل', 'ألغِ', 'أعِده للمتابعة', 'أجّل الشحن']);
    // «شو بيعمل:» of the parcels sentence — the second line of the item — names exactly the presses that are drawn.
    const says = helpItem(PARCELS).querySelectorAll('span.block')[1].textContent!;
    const named = Array.from(says.matchAll(/«([^»]+)»/g)).map((m) => m[1]);
    expect([...named].sort()).toEqual([...drawn].sort());
  });

  it('a handed-over batch: the list is for searching only — no press is drawn on a parcel, and the help says so', async () => {
    await mountWith(batch({ status: 'SHIPPED', shippedCount: 0 }), ['ops.batches'], parcelsPayload({ canEditInBatch: false }));
    await openParcels();
    expect(parcelPresses()).toEqual([]);
    const said = helpItem(PARCELS).textContent!;
    expect(said).toContain('للبحث بس');
    for (const [, label] of LEAVE_PRESSES) expect(said, label).not.toContain(label);
    expect(said).not.toContain('«عدّل»');
  });

  it('the sentence of each way off the trolley is what the code does — the dialog’s own wording is not trusted where it says more', () => {
    const said = (key: string) => batchHelpItems(facts()).find((i) => i.key === 'parcels')!.does.split('؛').find((s) => s.includes(key))!;
    expect(said('«ألغِ»')).toContain('بيلغي الطلب');
    expect(said('«ألغِ»')).toContain('بتكتب السبب');
    expect(said('«أعِده للمتابعة»')).toContain('لفريق التأكيد');
    expect(said('«أجّل الشحن»')).toContain('مؤكَّد');
    // The hold keeps the GOODS. The waybill is kept only for a manual courier or a parcel with no barcode: a parcel already sent to a
    // connected courier is cancelled there, and its barcode and printed waybill are cleared (`holdFromTrolley`, order-cancel.ts) —
    // so the sentence must not promise «وبوليصته محفوظتين» to everyone.
    expect(said('«أجّل الشحن»')).toContain('بضاعته محفوظة');
    expect(said('«أجّل الشحن»')).toContain('بيلغيه عندها');
    expect(said('«أجّل الشحن»')).toContain('بيمسح باركوده وبوليصته');
    expect(said('«أجّل الشحن»')).not.toContain('بوليصته محفوظتين');
    expect(batchHelpItems(facts()).find((i) => i.key === 'parcels')!.does).toContain('ما بيغيّر سعراً ولا خصماً');
  });
});

describe('what each sentence says is what the code does', () => {
  const item = (key: string, f: BatchHelpFacts = facts()) => batchHelpItems(f).find((i) => i.key === key)!;

  it('the handover says it cannot be undone, and what it refuses', () => {
    const ship = item('ship');
    expect(ship.undo).toContain('ما بيرجع');
    expect(ship.undo).toContain('طلب تغيير');
    expect(ship.does).toContain('مشحون');
    for (const refusal of ['فاضية', 'إلغاء أو تأجيل', 'تغيّر لحظتها', 'بلا باركود']) expect(ship.does, refusal).toContain(refusal);
  });

  it('after the handover a cancellation becomes a request to the courier and a postponement is REFUSED — the help says exactly that', () => {
    // What the code answers, called, so that a change of the rule fails here and not on the owner’s screen.
    const handedOver = { handedToCourier: true, onOpenTrolley: false };
    expect(carryOut('CANCEL', handedOver).kind).toBe('CANCEL_VIA_COURIER');
    expect(carryOut('POSTPONE', handedOver).kind).toBe('REFUSED');
    const undo = item('ship').undo!;
    expect(undo).toContain('الإلغاء بيصير طلب تغيير');
    expect(undo).toContain('تبلّغ فيه شركة الشحن');
    expect(undo).toContain('التأجيل ما بيصير');
    expect(undo).toContain('اطلب الإلغاء');
    expect(undo).not.toContain('الإلغاء والتأجيل بيصيروا');
  });

  it('«خرج للتوصيل» counts the parcels at «مشحون», sends nothing to the customer, and cannot be undone', () => {
    const out = item('out');
    expect(out.name).toBe('خرج للتوصيل لكل الدفعة (51)');
    expect(out.does).toContain('51 = عدد طرود الدفعة اللي حالتها «مشحون»');
    expect(out.does).toContain('ما بيبعت شي للزبون');
    expect(out.does).toContain('ولا بيحرّك مصاري');
    expect(out.undo).toContain('ما بيرجع');
  });

  it('«خرج للتوصيل» does not say it moves ALL the parcels: a refused parcel is named with its reason and stays at «مشحون»', () => {
    const does = item('out').does;
    expect(does).toContain('بينقل كل طرد بيسمح طلبه');
    expect(does).toContain('بينذكر بالاسم مع السبب');
    expect(does).toContain('بيضل «مشحون»');
    expect(does).not.toContain('بينقلها كلها');
  });

  it('for a courier connected by API it says the courier moves the parcel itself; for a manual one it says this press saves a press per parcel', () => {
    expect(item('out', facts({ courierSendsStatus: true })).when).toContain('بتحرّك كل طرد لحالها');
    expect(item('out', facts({ courierSendsStatus: false })).when).toContain('بدل ضغطة لكل طرد');
  });

  it('no «خرج للتوصيل» sentence without parcels at «مشحون»', () => {
    expect(batchHelpItems(facts({ out: 0 })).some((i) => i.key === 'out')).toBe(false);
    expect(batchHelpItems(facts({ out: null })).some((i) => i.key === 'out')).toBe(false);
  });

  it('the dispatch says it is for a courier connected by API, that a parcel with a barcode is skipped, and that a parcel that was not sent shows with its reason', () => {
    const d = item('dispatch');
    expect(d.when).toContain('مربوطة بنظامها');
    expect(d.does).toContain('بيتخطّاه');
    expect(d.does).toContain('بنتيجة الترحيل مع سببه');
    expect(d.does).not.toContain('بيبعت كل طرد');
  });

  it('the paste is said to be refused for a connected courier before the dispatch — the very state in which both presses are drawn', async () => {
    await mountWith(batch(), ['ops.batches', 'orders.change_status', 'ops.ship']);
    // Both are drawn on one ready card of a connected courier…
    expect(buttons()).toContain('رحّل إلى الشركة واجلب الباركود');
    expect(buttons()).toContain('لصق الباركودات');
    // …and the server refuses the second (`DISPATCH_FIRST`, 409), so the help must not offer it as a way to get barcodes.
    const paste = helpItem('لصق الباركودات').textContent!;
    expect(paste).toContain('مش هلّق');
    expect(paste).toContain('بيرفض');
    expect(paste).toContain('رحّل إلى الشركة');
    expect(paste).toContain('اللصق بعد التسليم');
  });

  it('the paste says what it is for in the other two states: a handed-over batch of a connected courier, and a manual courier', () => {
    expect(item('paste', facts({ dispatch: false, courierSendsStatus: true })).when).toContain('سُلّمت قبل ما ترحّلها');
    expect(item('paste', facts({ dispatch: false, courierSendsStatus: true })).when).not.toContain('مش هلّق');
    expect(item('paste', facts({ dispatch: false, courierSendsStatus: false })).when).toContain('لشركة يدوية');
    expect(item('paste', facts({ dispatch: false, courierSendsStatus: false })).when).not.toContain('مش هلّق');
    expect(item('paste').does).toContain('بيتحقّق منها أول وبعدين بيكتبها');
  });

  it('the paper line says a saved PDF does not mark the orders printed — the screen’s own tooltip says it', () => {
    expect(item('paper').does).toContain('ما بيعلّم الطلبات مطبوعة');
  });
});
