// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import React from 'react';

/**
 * «وظيفة كل زر ومتى بضغطو؟ وشو بيعمل؟» (the owner, 8/11) — the buttons of a shipping batch, said on the card itself.
 *
 *   · the fold lists ONLY the presses this card has — the same facts that decide whether each button is drawn decide which are
 *     described, so the help cannot describe a button that is not there, nor miss one that is;
 *   · each sentence is what the code does: the handover cannot be undone, «خرج للتوصيل لكل الدفعة» counts the parcels at
 *     «مشحون» and sends nothing to the customer, and a courier connected by API moves a parcel along by itself.
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
import { batchHelpItems, type BatchHelpFacts } from './BatchButtonsHelp';

const WAIT = { timeout: 8000 };
const SUMMARY = 'شو بيعمل كل زر ومتى بتضغطو؟';

const batch = (over: Record<string, unknown> = {}, provider: Record<string, unknown> = {}) => ({
  id: 'b1', batchNumber: 'BATCH-2026-0001', status: 'READY',
  provider: { id: 'dp1', name: 'الباشا', code: 'BASHA', kind: 'COMPANY', apiEnabled: true, ...provider },
  creator: { id: 'u1', name: 'Qabas' }, createdAt: '2026-11-01T10:00:00.000Z', shippedAt: null, notes: null,
  _count: { orders: 51 }, courierCityGap: null, shippedCount: 0, ...over,
});

const mountWith = async (b: ReturnType<typeof batch>, keys: string[] = []) => {
  held.clear();
  keys.forEach((k) => held.add(k));
  apiJson.mockImplementation(async () => ({ batches: [b], pagination: { total: 1 } }));
  render(<ShippingBatchesScreen />);
  await screen.findByText(b.batchNumber, undefined, WAIT);
};
const card = () => screen.getByText('BATCH-2026-0001').closest('li') as HTMLElement;
const help = () => within(card()).getByText(SUMMARY).closest('details') as HTMLElement;
const helpNames = () => Array.from(help().querySelectorAll('li')).map((li) => li.firstElementChild!.textContent!);
const buttons = () => Array.from(card().querySelectorAll('button')).map((b) => (b.textContent ?? '').trim());

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
});
afterEach(cleanup);

describe('the help lists only the presses the card has', () => {
  it('a ready batch for a courier connected by API: the dispatch, the paper, the check and the handover — and no «خرج للتوصيل»', async () => {
    await mountWith(batch(), ['ops.batches', 'orders.change_status']);
    expect(helpNames()).toEqual([
      'رحّل إلى الشركة واجلب الباركود',
      'طباعة بوالص الدفعة · PDF · CSV',
      'تحقّق من الطرود',
      'إغلاق الشحنة — سُلّمت للشركة',
    ]);
  });

  it('a manual courier has no dispatch and says so; the paste is there when the person may ship', async () => {
    await mountWith(batch({}, { apiEnabled: false }), ['ops.ship']);
    expect(helpNames()).toEqual(['لصق الباركودات', 'طباعة بوالص الدفعة · PDF · CSV', 'تحقّق من الطرود', 'إغلاق الشحنة — سُلّمت للشركة']);
  });

  it('a handed-over batch with parcels still at «مشحون» gets the out-for-delivery press, with its count, and no handover', async () => {
    await mountWith(batch({ status: 'SHIPPED', shippedCount: 51 }), ['ops.batches', 'orders.change_status']);
    expect(helpNames()).toEqual(['طباعة بوالص الدفعة · PDF · CSV', 'تحقّق من الطرود', 'خرج للتوصيل لكل الدفعة (51)']);
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
    for (const stage of ['رحّل إلى الشركة واجلب الباركود', 'لصق الباركودات', 'إغلاق الشحنة — سُلّمت للشركة']) {
      expect(drawn.some((t) => t.includes(stage)), stage).toBe(true);
      expect(helpNames(), stage).toContain(stage);
    }
    for (const name of helpNames()) {
      for (const part of name.split(' · ')) {
        const caption = part.replace(/ \(\d+\)$/, '');
        expect(drawn.some((t) => t.includes(caption)), caption).toBe(true);
      }
    }
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

describe('what each sentence says is what the code does', () => {
  const facts = (over: Partial<BatchHelpFacts> = {}): BatchHelpFacts => ({
    dispatch: true, paste: true, ship: true, out: 51, courierSendsStatus: true, xlsx: false, ...over,
  });
  const item = (key: string, f: BatchHelpFacts = facts()) => batchHelpItems(f).find((i) => i.key === key)!;

  it('the handover says it cannot be undone, and what it refuses', () => {
    const ship = item('ship');
    expect(ship.undo).toContain('ما بيرجع');
    expect(ship.undo).toContain('طلب تغيير');
    expect(ship.does).toContain('مشحون');
    for (const refusal of ['فاضية', 'إلغاء أو تأجيل', 'تغيّر لحظتها', 'بلا باركود']) expect(ship.does, refusal).toContain(refusal);
  });

  it('«خرج للتوصيل» counts the parcels at «مشحون», sends nothing to the customer, and cannot be undone', () => {
    const out = item('out');
    expect(out.name).toBe('خرج للتوصيل لكل الدفعة (51)');
    expect(out.does).toContain('51 = عدد طرود الدفعة اللي حالتها «مشحون»');
    expect(out.does).toContain('ما بيبعت شي للزبون');
    expect(out.does).toContain('ولا بيحرّك مصاري');
    expect(out.undo).toContain('ما بيرجع');
  });

  it('for a courier connected by API it says the courier moves the parcel itself; for a manual one it says this press saves a press per parcel', () => {
    expect(item('out', facts({ courierSendsStatus: true })).when).toContain('بتحرّك كل طرد لحالها');
    expect(item('out', facts({ courierSendsStatus: false })).when).toContain('بدل ضغطة لكل طرد');
  });

  it('no «خرج للتوصيل» sentence without parcels at «مشحون»', () => {
    expect(batchHelpItems(facts({ out: 0 })).some((i) => i.key === 'out')).toBe(false);
    expect(batchHelpItems(facts({ out: null })).some((i) => i.key === 'out')).toBe(false);
  });

  it('the dispatch says it is for a courier connected by API and that a parcel with a barcode is skipped', () => {
    const d = item('dispatch');
    expect(d.when).toContain('مربوطة بنظامها');
    expect(d.does).toContain('بيتخطّاه');
  });

  it('the paper line says a saved PDF does not mark the orders printed — the screen’s own tooltip says it', () => {
    expect(item('paper').does).toContain('ما بيعلّم الطلبات مطبوعة');
  });
});
