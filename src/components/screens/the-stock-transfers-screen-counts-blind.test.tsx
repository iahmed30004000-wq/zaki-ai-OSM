// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * «نقل البضاعة» (warehouse plan W3b) — the screen of W3a's four doors.
 *
 * DEFINITION OF DONE it pins:
 *  1. Every state of a transfer is drawn with its word and its press: on the road, received, received short (waiting for its
 *     approval, then approved), cancelled; the empty list, the load failure, a store with fewer than two warehouses.
 *  2. THE RECEIVER COUNTS BLIND (the row's blocker): the list says «العدد مخفي» where the door sent no figure, and the
 *     receive dialog shows no sent quantity before the press — even when the row it was opened from carries one. Only the
 *     door's answer after «استلمت» shows sent · counted · difference.
 *  3. Each press asks its own key: send and cancel `inventory.transfer`, receive `inventory.transfer_receive`, the
 *     difference `inventory.difference_approve`; the sender is not offered the receipt, nor the sender or receiver the
 *     approval; a viewer (`inventory.view` only) sees the list and no press.
 *  4. The kind is said BEFORE the press, from the two ends (`readStockTransfer`); another country is «لسا مش مبني» and the
 *     press stays shut; the same warehouse twice is refused in the door's own sentence.
 *  5. Every refusal is the door's Arabic sentence, printed as it came.
 */

const { api, user } = vi.hoisted(() => ({
  api: vi.fn(),
  user: { current: { id: 'u-me', name: 'سارة', role: 'CUSTOM', permissions: [] as string[], status: 'ACTIVE' } as Record<string, unknown> },
}));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ t: { cancel: 'إلغاء' }, locale: 'ar', currentUser: user.current }) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/inventory/transfers', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/shell/ScreenGuide', () => ({ GuideButton: () => null }));
vi.mock('@/hooks/useLiveRefresh', async () => {
  const R = await import('react');
  return { useLiveRefresh: (load: () => unknown) => R.useEffect(() => void load(), []) };
});
vi.mock('@/hooks/useProducts', () => ({
  useProducts: () => ({
    loading: false,
    products: [
      { id: 'p1', name: 'كريم اليدين', sku: 'K-1' },
      { id: 'p2', name: 'صابون الزيت', sku: 'S-2' },
    ],
  }),
}));

import { StockTransfersScreen } from './StockTransfersScreen';
import { NOT_BUILT_AR } from '@/lib/stock-transfer-kind';
import { findRoute, NAV } from '@/lib/route-registry';
import { GUIDE_TEXTS } from '@/lib/route-guide-texts';
import { GUIDED_PATHS } from '@/lib/route-guide';

const W = [
  { id: 'wA', name: 'مخزن الشمال', countryId: 'k1' },
  { id: 'wB', name: 'مخزن الجنوب', countryId: 'k1' },
  { id: 'wJ', name: 'مخزن عمّان', countryId: 'k2' },
];

type T = Record<string, unknown>;
const transfer = (over: T = {}): T => ({
  id: 't1',
  kind: 'INTERNAL',
  kindAr: 'نقل داخل المتجر',
  status: 'SENT',
  statusAr: 'بالطريق',
  blind: true,
  note: null,
  fromName: 'مخزن الشمال',
  toName: 'مخزن الجنوب',
  sentById: 'u-other',
  sentByName: 'رنا',
  sentAt: '2026-11-20T08:00:00.000Z',
  receivedById: null,
  receivedByName: null,
  receivedAt: null,
  cancelledByName: null,
  cancelReason: null,
  differenceType: null,
  differenceReason: null,
  differenceApprovedAt: null,
  differenceApprovedByName: null,
  lines: [{ productId: 'p1', productName: 'كريم اليدين', quantitySent: null, quantityReceived: null, difference: null }],
  ...over,
});

let list: { warehouses: T[]; transfers: T[] };
let onPost: (url: string, body: T) => unknown;
const posts = () => api.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST').map(([u, init]) => [u, JSON.parse((init as RequestInit).body as string)]);

const as = (...keys: string[]) => {
  user.current = { ...user.current, permissions: ['inventory.view', ...keys] };
};

beforeEach(() => {
  api.mockReset();
  as();
  list = { warehouses: W.slice(0, 2), transfers: [transfer()] };
  onPost = () => ({ transfer: {}, replay: false });
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return onPost(url, JSON.parse(init.body as string));
    if (url === '/api/inventory/transfers') return list;
    throw new Error(`unexpected ${url}`);
  });
});
afterEach(() => cleanup());

const mount = async () => {
  render(<StockTransfersScreen />);
  await waitFor(() => expect(api).toHaveBeenCalledWith('/api/inventory/transfers'));
};
const refuse = (sentence: string) => () => {
  throw new Error(sentence);
};
const btn = (name: string) => screen.queryAllByRole('button', { name })[0] ?? null;
/** The list is drawn twice by the kit's `Rows` (a table on a desk, cards on a phone): the list's questions are asked of the table. */
const table = async () => within((await waitFor(() => { const t = document.querySelector('table'); if (!t) throw new Error('no table'); return t; })) as HTMLElement);

describe('the list: every state with its word', () => {
  it('on the road · received · short and waiting · short and approved · cancelled — each with its chip and its line', async () => {
    as('inventory.transfer', 'inventory.transfer_receive', 'inventory.difference_approve');
    list.transfers = [
      transfer({ id: 'a' }),
      transfer({
        id: 'b', status: 'RECEIVED', statusAr: 'مستلم', blind: false, receivedById: 'u-x', receivedByName: 'هالة',
        lines: [{ productId: 'p1', productName: 'كريم اليدين', quantitySent: 4, quantityReceived: 4, difference: 0 }],
      }),
      transfer({
        id: 'c', status: 'RECEIVED_WITH_DIFFERENCE', statusAr: 'مستلم بفرق', blind: false, receivedById: 'u-x',
        lines: [{ productId: 'p2', productName: 'صابون الزيت', quantitySent: 9, quantityReceived: 6, difference: 3 }],
      }),
      transfer({
        id: 'd', status: 'RECEIVED_WITH_DIFFERENCE', statusAr: 'مستلم بفرق', blind: false, receivedById: 'u-x',
        differenceApprovedAt: '2026-11-20T10:00:00.000Z', differenceType: 'DAMAGE', differenceApprovedByName: 'منى',
        lines: [{ productId: 'p2', productName: 'صابون الزيت', quantitySent: 5, quantityReceived: 4, difference: 1 }],
      }),
      transfer({ id: 'e', status: 'CANCELLED', statusAr: 'ملغى', blind: false, cancelReason: 'غلط بالمخزن', cancelledByName: 'رنا' }),
    ];
    await mount();
    const t = await table();
    for (const w of ['بالطريق', 'مستلم', 'ملغى']) expect(t.getByText(w)).toBeTruthy();
    expect(t.getAllByText('مستلم بفرق')).toHaveLength(2);
    expect(t.getByText('الفرق بدو اعتماد شخص تالت')).toBeTruthy();
    expect(t.getByText(/انعتمد الفرق \(تالف\) — منى/)).toBeTruthy();
    expect(t.getByText('السبب: غلط بالمخزن')).toBeTruthy();
    // The short lines say the server's difference — 3 and 1 — and nothing the screen subtracted.
    expect(t.getAllByText(/ناقص/).map((n) => n.textContent)).toEqual([' · ناقص 3', ' · ناقص 1']);
    // The filter counts rows, and the «waiting» chip finds only the unapproved short one.
    const filter = screen.getByRole('radiogroup', { name: 'أي نقلات' });
    fireEvent.click(within(filter).getByRole('radio', { name: /فرق بدو اعتماد/ }));
    const after = await table();
    expect(after.getAllByRole('button', { name: 'اعتمد الفرق' })).toHaveLength(1);
    expect(after.queryByText('السبب: غلط بالمخزن')).toBeNull();
  });

  it('empty: a sentence, not a blank page', async () => {
    list.transfers = [];
    await mount();
    expect(await screen.findByText('ما في نقلات لسا')).toBeTruthy();
  });

  it('a load refused: the door’s sentence and a retry', async () => {
    api.mockImplementation(refuse('ما عندك صلاحية تشوف المخزون.'));
    await mount();
    expect(await screen.findByText('ما عندك صلاحية تشوف المخزون.')).toBeTruthy();
  });

  it('fewer than two warehouses: says where they are made, and no «نقل جديد»', async () => {
    as('inventory.transfer');
    list = { warehouses: W.slice(0, 1), transfers: [] };
    await mount();
    expect(await screen.findByText(/لازم يكون في مخزنين شغّالين/)).toBeTruthy();
    expect(btn('نقل جديد')).toBeNull();
  });
});

describe('each press asks its own key', () => {
  it('NEGATIVE: a viewer sees the list and no press at all; the send and receive keys are not the approval key', async () => {
    list.transfers.push(
      transfer({ id: 'short', status: 'RECEIVED_WITH_DIFFERENCE', statusAr: 'مستلم بفرق', blind: false, receivedById: 'u-x', lines: [{ productId: 'p1', productName: 'كريم اليدين', quantitySent: 5, quantityReceived: 3, difference: 2 }] })
    );
    for (const keys of [[], ['inventory.transfer', 'inventory.transfer_receive']]) {
      as(...keys);
      await mount();
      await table();
      expect(btn('اعتمد الفرق'), keys.join()).toBeNull();
      if (keys.length === 0) for (const name of ['نقل جديد', 'استلم', 'إلغاء']) expect(btn(name), name).toBeNull();
      cleanup();
    }
  });

  it('the send key: «نقل جديد» and «إلغاء», never «استلم»', async () => {
    as('inventory.transfer');
    await mount();
    expect(await screen.findByRole('button', { name: 'نقل جديد' })).toBeTruthy();
    expect(btn('إلغاء')).toBeTruthy();
    expect(btn('استلم')).toBeNull();
  });

  it('NEGATIVE: the sender holding the receive key is not offered her own transfer — she is told someone else receives it', async () => {
    as('inventory.transfer_receive');
    list.transfers = [transfer({ sentById: 'u-me', blind: false, lines: [{ productId: 'p1', productName: 'كريم اليدين', quantitySent: 7, quantityReceived: null, difference: null }] })];
    await mount();
    expect((await table()).getByText('بيستلمه حدا غيرك')).toBeTruthy();
    expect(btn('استلم')).toBeNull();
  });

  it('NEGATIVE: the approval is offered to a third person only — not to the receiver, not to the sender', async () => {
    as('inventory.difference_approve');
    const short = (over: T) =>
      transfer({ status: 'RECEIVED_WITH_DIFFERENCE', statusAr: 'مستلم بفرق', blind: false, receivedById: 'u-x', lines: [{ productId: 'p1', productName: 'كريم اليدين', quantitySent: 5, quantityReceived: 3, difference: 2 }], ...over });
    list.transfers = [short({ id: 'mine-received', receivedById: 'u-me' }), short({ id: 'mine-sent', sentById: 'u-me' })];
    await mount();
    await table();
    expect(btn('اعتمد الفرق')).toBeNull();
    cleanup();
    list.transfers = [short({ id: 'third' })];
    await mount();
    expect((await table()).getByRole('button', { name: 'اعتمد الفرق' })).toBeTruthy();
  });
});

describe('the receiver counts blind (the blocker)', () => {
  it('the list says the figure is hidden where the door sent none', async () => {
    as('inventory.transfer_receive');
    await mount();
    expect((await table()).getByText('العدد مخفي لحد ما ينعدّ')).toBeTruthy();
  });

  it('NEGATIVE: the dialog shows no sent quantity before the press — even from a row that carries one; after the press, the door’s three figures', async () => {
    as('inventory.transfer_receive');
    // A row that DOES carry the sent figure (37): the dialog must still not show it before she types.
    list.transfers = [transfer({ blind: false, lines: [{ productId: 'p1', productName: 'كريم اليدين', quantitySent: 37, quantityReceived: null, difference: null }] })];
    onPost = () => ({
      transfer: { status: 'RECEIVED_WITH_DIFFERENCE', statusAr: 'مستلم بفرق', lines: [{ productId: 'p1', quantitySent: 37, quantityReceived: 30, difference: 7 }] },
      replay: false,
    });
    await mount();
    fireEvent.click((await table()).getByRole('button', { name: 'استلم' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).not.toMatch(/37/);
    // Not in any attribute either — a placeholder, an aria-label, a title, a value, a data-* (20/11, review).
    // (An icon's drawing — an svg path's `d` — is not words, and its coordinates are full of digits.)
    const attributes = () =>
      [dialog, ...dialog.querySelectorAll('*')].flatMap((el) => [...el.attributes].filter((a) => a.name !== 'd').map((a) => `${a.name}=${a.value}`));
    expect(attributes().filter((a) => a.includes('37'))).toEqual([]);
    expect(dialog.textContent).toContain('الكمية المبعوتة بتبين بعد ما تضغط');
    const press = within(dialog).getByRole('button', { name: 'استلمت' }) as HTMLButtonElement;
    expect(press.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('عدد «كريم اليدين» اللي وصل'), { target: { value: '30' } });
    expect(dialog.textContent).not.toMatch(/37/);
    expect(attributes().filter((a) => a.includes('37'))).toEqual([]);
    expect(press.disabled).toBe(false);
    fireEvent.click(press);
    expect(await screen.findByText('انستلم النقل')).toBeTruthy();
    expect(posts()).toEqual([['/api/inventory/transfers/t1/receive', { lines: [{ productId: 'p1', quantity: 30 }] }]]);
    const figures = document.querySelector('[data-figures="p1"]')!.textContent!;
    expect(figures).toMatch(/انبعت\s*37/);
    expect(figures).toMatch(/انعدّ\s*30/);
    expect(figures).toMatch(/الفرق\s*7/);
    expect(screen.getByText(/الناقص بيضل بالطريق/)).toBeTruthy();
  });

  it('a count that is not a whole number keeps the press shut; zero is a count', async () => {
    as('inventory.transfer_receive');
    await mount();
    fireEvent.click((await table()).getByRole('button', { name: 'استلم' }));
    const dialog = await screen.findByRole('dialog');
    const box = within(dialog).getByLabelText('عدد «كريم اليدين» اللي وصل');
    const press = within(dialog).getByRole('button', { name: 'استلمت' }) as HTMLButtonElement;
    fireEvent.change(box, { target: { value: '2.5' } });
    expect(press.disabled).toBe(true);
    expect(within(dialog).getByText('العدد لازم يكون رقم صحيح من صفر وطالع.')).toBeTruthy();
    fireEvent.change(box, { target: { value: '0' } });
    expect(press.disabled).toBe(false);
  });

  it('the source pins it: before its answer, the receive dialog never reads a sent quantity', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/screens/StockTransfersScreen.tsx'), 'utf8').replace(/\r\n/g, '\n');
    const start = src.indexOf('export function ReceiveDialog');
    const before = src.slice(start, src.indexOf('if (answer) {', start));
    const after = src.slice(src.indexOf('if (answer) {', start), src.indexOf('/* ─', start));
    // Comments may name it; code may not.
    const code = before.replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('quantitySent');
    expect(code).not.toContain('difference');
    expect(after).toContain('quantitySent');
  });

  it('every refusal of the receipt is the door’s sentence', async () => {
    as('inventory.transfer_receive');
    for (const sentence of [
      'إنت اللي بعتّ هالنقل، فما بتستلمه. لازم حدا تاني يعدّ ويستلم.',
      'العدد أكتر من اللي انبعت. عدّ كمان مرة، والزيادة بتنكتب من الجرد مش من هون.',
      'هالنقل انستلم من قبل. حدّث الصفحة.',
      'ما إلك وصول على المخزن اللي واصل عليه النقل.',
    ]) {
      onPost = refuse(sentence);
      await mount();
      fireEvent.click((await table()).getByRole('button', { name: 'استلم' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText('عدد «كريم اليدين» اللي وصل'), { target: { value: '3' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'استلمت' }));
      expect(await within(dialog).findByText(sentence)).toBeTruthy();
      cleanup();
      api.mockClear();
    }
  });
});

describe('cancel and the difference', () => {
  it('cancel: a reason of three letters opens the press; the door is told the reason; a refusal is its sentence', async () => {
    as('inventory.transfer');
    await mount();
    fireEvent.click((await table()).getByRole('button', { name: 'إلغاء' }));
    const dialog = await screen.findByRole('dialog');
    const press = within(dialog).getByRole('button', { name: 'ألغِ النقل' }) as HTMLButtonElement;
    expect(press.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/سبب الإلغاء/), { target: { value: 'غلط بالكمية' } });
    onPost = refuse('هالنقل انستلم، فما بينلغى. لترجّع البضاعة اعمل نقل معاكس.');
    fireEvent.click(press);
    expect(await within(dialog).findByText('هالنقل انستلم، فما بينلغى. لترجّع البضاعة اعمل نقل معاكس.')).toBeTruthy();
    onPost = () => ({ transfer: {}, replay: false });
    fireEvent.click(press);
    expect(await screen.findByText('انلغى النقل — البضاعة رجعت لمخزنها.')).toBeTruthy();
    expect(posts().at(-1)).toEqual(['/api/inventory/transfers/t1/cancel', { reason: 'غلط بالكمية' }]);
  });

  it('the difference: lost or damaged, with a reason; the third-hand refusals are the door’s sentences', async () => {
    as('inventory.difference_approve');
    list.transfers = [
      transfer({ status: 'RECEIVED_WITH_DIFFERENCE', statusAr: 'مستلم بفرق', blind: false, receivedById: 'u-x', lines: [{ productId: 'p1', productName: 'كريم اليدين', quantitySent: 5, quantityReceived: 3, difference: 2 }] }),
    ];
    await mount();
    fireEvent.click((await table()).getByRole('button', { name: 'اعتمد الفرق' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'تالف' }));
    fireEvent.change(within(dialog).getByLabelText(/سبب الفرق/), { target: { value: 'انكسرت بالطريق' } });
    for (const sentence of ['إنت اللي استلمت هالنقل، فما بتعتمد فرقه. لازم شخص تالت.', 'فرق هالنقل انعتمد من قبل. حدّث الصفحة.']) {
      onPost = refuse(sentence);
      fireEvent.click(within(dialog).getByRole('button', { name: 'اعتمد الفرق' }));
      expect(await within(dialog).findByText(sentence)).toBeTruthy();
    }
    onPost = () => ({ transfer: {}, replay: false });
    fireEvent.click(within(dialog).getByRole('button', { name: 'اعتمد الفرق' }));
    expect(await screen.findByText('انعتمد الفرق.')).toBeTruthy();
    expect(posts().at(-1)).toEqual(['/api/inventory/transfers/t1/difference', { type: 'DAMAGE', reason: 'انكسرت بالطريق' }]);
  });
});

describe('the send form: the kind before the press', () => {
  const openForm = async () => {
    as('inventory.transfer');
    list.warehouses = W;
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'نقل جديد' }));
    return screen.findByRole('dialog');
  };
  const pick = (dialog: HTMLElement, group: string, name: string) =>
    fireEvent.click(within(within(dialog).getByRole('radiogroup', { name: group })).getByRole('radio', { name }));

  it('the same warehouse twice, another country, then two of this store: three sentences, one open press', async () => {
    const dialog = await openForm();
    const press = within(dialog).getByRole('button', { name: 'أرسل' }) as HTMLButtonElement;
    expect(within(dialog).getByText(/الشاشة بتقلّك شو نوع هالنقل/)).toBeTruthy();
    pick(dialog, 'من مخزن', 'مخزن الشمال');
    pick(dialog, 'إلى مخزن', 'مخزن الشمال');
    expect(within(dialog).getByText('المخزن اللي بتنقل منه هو نفسه اللي بتنقل عليه. اختار مخزن تاني.')).toBeTruthy();
    pick(dialog, 'إلى مخزن', 'مخزن عمّان');
    expect(dialog.querySelector('[data-kind]')!.getAttribute('data-kind')).toBe('BETWEEN_COUNTRIES');
    expect(dialog.textContent).toContain(NOT_BUILT_AR);
    pick(dialog, 'إلى مخزن', 'مخزن الجنوب');
    expect(dialog.querySelector('[data-kind]')!.getAttribute('data-kind')).toBe('INTERNAL');
    expect(dialog.textContent).toContain('من مخزن الشمال إلى مخزن الجنوب. نفس البضاعة ونفس الكلفة، بس المكان بيتغيّر.');
    // Still shut: no product, no quantity.
    expect(press.disabled).toBe(true);
  });

  it('a product and a quantity open it; the door gets the ends, the read kind, a client id; a refusal is its sentence and the same id goes again', async () => {
    const dialog = await openForm();
    pick(dialog, 'من مخزن', 'مخزن الشمال');
    pick(dialog, 'إلى مخزن', 'مخزن الجنوب');
    await userEvent.click(within(dialog).getByPlaceholderText(/ابحث/));
    await userEvent.click(within(dialog).getByText('صابون الزيت'));
    const qty = within(dialog).getByLabelText('كمية السطر 1');
    fireEvent.change(qty, { target: { value: '0' } });
    expect(within(dialog).getByText('الكمية لازم تكون رقم صحيح أكبر من صفر.')).toBeTruthy();
    fireEvent.change(qty, { target: { value: '6' } });
    const press = within(dialog).getByRole('button', { name: 'أرسل' }) as HTMLButtonElement;
    expect(press.disabled).toBe(false);
    // NEGATIVE: the same lines toward another country — «لسا مش مبني», and the press shuts again.
    pick(dialog, 'إلى مخزن', 'مخزن عمّان');
    expect(press.disabled).toBe(true);
    pick(dialog, 'إلى مخزن', 'مخزن الجنوب');
    expect(press.disabled).toBe(false);
    const short = 'ما في كفاية ببضاعة مخزن الشمال الحرّة: صابون الزيت (الحر 4، طالب 6).';
    onPost = refuse(short);
    fireEvent.click(press);
    expect(await within(dialog).findByText(short)).toBeTruthy();
    onPost = () => ({ transfer: {}, replay: false });
    fireEvent.click(press);
    expect(await screen.findByText('انبعت النقل — البضاعة صارت بالطريق.')).toBeTruthy();
    const [first, second] = posts();
    expect(first[0]).toBe('/api/inventory/transfers');
    expect(first[1]).toMatchObject({ fromWarehouseId: 'wA', toWarehouseId: 'wB', expectKind: 'INTERNAL', note: null, lines: [{ productId: 'p2', quantity: 6 }] });
    expect(first[1].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second[1].id).toBe(first[1].id);
  });

  it('the door’s other send refusals are printed as they came', async () => {
    for (const sentence of [
      'هالمتجر لسا ما توزّع على المخازن. وزّع الرصيد على المخازن أول، وبعدين انقل.',
      'نفس المنتج مكتوب بسطرين. اجمعهم بسطر واحد.',
      'تغيّر نوع النقل — هاد بين بلدين. راجعه وأعد المحاولة.',
      'المخزن اللي بتنقل عليه موقوف. شغّله أول، أو انقل على مخزن تاني.',
    ]) {
      const dialog = await openForm();
      pick(dialog, 'من مخزن', 'مخزن الشمال');
      pick(dialog, 'إلى مخزن', 'مخزن الجنوب');
      await userEvent.click(within(dialog).getByPlaceholderText(/ابحث/));
      await userEvent.click(within(dialog).getByText('كريم اليدين'));
      fireEvent.change(within(dialog).getByLabelText('كمية السطر 1'), { target: { value: '1' } });
      onPost = refuse(sentence);
      fireEvent.click(within(dialog).getByRole('button', { name: 'أرسل' }));
      expect(await within(dialog).findByText(sentence)).toBeTruthy();
      cleanup();
      api.mockClear();
    }
  });
});

describe('the movements tab draws the door’s blind line (20/11, review)', () => {
  it('a TRANSFER_OUT line with no figure says «مخفي» and the door’s reason — no number, no arrow', async () => {
    api.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/inventory/movements')) {
        return {
          movements: [
            { id: 'm1', type: 'TRANSFER_OUT', quantity: null, balanceAfter: 10, reason: 'العدد مخفي لحد ما ينستلم النقل', hiddenOnRoad: true, createdAt: '2026-11-20T08:00:00.000Z', product: { id: 'p1', name: 'كريم اليدين', sku: null }, batchNumber: null, createdByName: 'رنا' },
          ],
          types: [{ type: 'TRANSFER_OUT', count: 1 }],
          hasMore: false,
        };
      }
      throw new Error(`unexpected ${url}`);
    });
    const { InventoryMovementsScreen } = await import('./InventoryMovementsScreen');
    render(<InventoryMovementsScreen />);
    const t = await table();
    expect(t.getByText('مخفي')).toBeTruthy();
    expect(t.getByText('العدد مخفي لحد ما ينستلم النقل')).toBeTruthy();
    expect(t.getByText('نقل — طالع من مخزن')).toBeTruthy();
    expect(t.queryByText('NaN')).toBeNull();
  });
});

describe('the page and its place', () => {
  it('a tab of «المخزون والمنتجات» on inventory.view, guarded, with its guide', () => {
    expect(findRoute('/inventory/transfers')).toMatchObject({ label: 'نقل البضاعة', permissions: ['inventory.view'] });
    const inv = NAV.find((g) => g.key === 'inventory')!;
    // 20/11 (W6b): was `inv.routes.at(-1)` — «إخراج بضاعة» (`/inventory/exits`) is the last tab now, right after this one.
    expect(inv.routes.map((r) => r.path).slice(-2)).toEqual(['/inventory/transfers', '/inventory/exits']);
    expect(GUIDED_PATHS).toContain('/inventory/transfers');
    expect(GUIDE_TEXTS['/inventory/transfers']?.steps.join(' ')).toContain('استلم');
    const page = readFileSync(join(process.cwd(), 'src/app/(system)/(shell)/inventory/transfers/page.tsx'), 'utf8');
    expect(page).toContain("guardRoute('/inventory/transfers')");
  });

  it('a column as wide as the phone: no fixed width, no horizontal scroll, no nowrap of its own', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/screens/StockTransfersScreen.tsx'), 'utf8');
    expect(src).not.toMatch(/\bw-\[\d|min-w-\[|overflow-x|whitespace-nowrap|text-xs/);
  });
});
