// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «طلبات التعديل» WEARS THE KIT (R16e, 18/11)
 *
 * The frame is `PageShell` with the registry's name; the two halves are the kit's pair (`Segmented`) with each half's
 * count on its option; every card is a `Card`; every press is a kit `Button`, none of which may submit anything.
 * What each card offers depends on two things only — which half it is in and whether the reader raised it — and that
 * table is read off the rendered screen here. (The screen has no `can(` line of its own: who may open it and decide is
 * the route's and the door's question, unchanged by this request.)
 * Whether the presses still SEND what they sent is the differential beside this file.
 * ═══════════════════════════════════════════════════════════════════════
 */

const h = vi.hoisted(() => ({ pending: [] as unknown[], awaiting: [] as unknown[] }));

vi.mock('@/lib/api-client', () => ({
  apiJson: async (url: string) =>
    url.includes('status=PENDING') ? { requests: h.pending } : url.includes('status=AWAITING_APPLY') ? { requests: h.awaiting } : { requests: [] },
  apiFetch: async () => ({ ok: true, json: async () => ({}) }),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/control/change-requests' }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => false }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn() }) }));
vi.mock('@/components/ui/Confirm', () => ({
  useConfirm: () => vi.fn(async () => false),
  useAsk: () => vi.fn(async () => null),
  useTell: () => vi.fn(),
}));

import { ChangeRequestsScreen } from './ChangeRequestsScreen';
import { routeLabel } from '@/lib/route-registry';
import { repoFile, stripComments } from '@/lib/guard-source';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'cr-1',
  reason: 'سبب تجربة',
  status: 'PENDING',
  blocking: false,
  changedDuringReview: false,
  createdAt: '2026-11-01T10:00:00.000Z',
  slaDueAt: null,
  overdue: false,
  decisionNote: null,
  requestedByName: 'موظفة تجربة باسم عربي طويل جداً حتى يلتف على الهاتف',
  requestedRole: 'CONFIRMATION_AGENT',
  isMine: false,
  intent: 'EDIT',
  postponeUntil: null,
  cancelReason: null,
  carryOut: { kind: 'EDIT_ORDER' },
  changes: { customerName: { from: 'قديم', to: 'جديد' } },
  order: {
    id: 'o1',
    orderNumber: 'TST-0001',
    confirmationStatus: 'CONFIRMED',
    shippingStatus: 'PACKING',
    version: 2,
    customer: { fullName: 'زبون تجربة', phone: '0900000000' },
  },
  ...over,
});

const ready = async () => {
  render(<ChangeRequestsScreen />);
  await screen.findByRole('radiogroup');
};
const names = () => screen.getAllByRole('button').map((b) => (b.textContent ?? '').trim());
const SRC = () => stripComments(repoFile('src/components/screens/ChangeRequestsScreen.tsx'));

beforeEach(() => {
  h.pending = [];
  h.awaiting = [];
});
afterEach(cleanup);

describe('the frame', () => {
  it('one heading, the registry’s name, drawn by the frame', async () => {
    h.pending = [row()];
    await ready();
    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0].textContent).toBe(routeLabel('/control/change-requests'));
    expect(SRC()).toMatch(/<PageShell\s+title=\{routeLabel\('\/control\/change-requests'\)\}/);
    expect(SRC()).not.toMatch(/<PageHeader/);
  });

  it('the two halves are one named pair of radios, each with its count, and the pressed one is checked', async () => {
    h.pending = [row()];
    h.awaiting = [row({ id: 'cr-2', status: 'APPROVED' }), row({ id: 'cr-3', status: 'APPROVED' })];
    await ready();
    const bar = screen.getByRole('radiogroup', { name: 'أيّ الطلبات' });
    const radios = within(bar).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['بانتظار القرار1', 'بانتظار التطبيق2']);
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    fireEvent.click(radios[1]);
    expect(within(bar).getAllByRole('radio').map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(screen.getByText('طلبات اعتُمدت ولسا ما انكتبت على الطلب — اضغط التنفيذ.')).toBeTruthy();
  });

  it('NEGATIVE: an empty half shows its zero, not nothing', async () => {
    h.pending = [row()];
    await ready();
    expect(screen.getByRole('radio', { name: /بانتظار التطبيق/ }).textContent).toBe('بانتظار التطبيق0');
  });

  it('no raw button, no raw surface, no small body text left in the screen', () => {
    const src = SRC();
    expect(src).not.toMatch(/<button[\s>]/);
    expect(src).not.toMatch(/<article[\s>]/);
    expect(src).not.toMatch(/\btext-xs\b/);
    expect(src.match(/<Card[\s>]/g)).toHaveLength(2);
    expect(src.match(/<Segmented[\s>]/g)).toHaveLength(1);
  });
});

describe('every press is a kit button that submits nothing', () => {
  it('each kit button in the source says type="button"', () => {
    // From the tag's name to its first `>` (an arrow's, at the latest): `type` is written first on each, so it is inside.
    const tags = SRC().match(/<Button\b[^>]*>/g) ?? [];
    expect(tags.length).toBe(5);
    for (const t of tags) expect(t, t).toMatch(/type="button"/);
  });

  it('and so does every button drawn, in both halves, on her row and on a colleague’s', async () => {
    h.pending = [row(), row({ id: 'cr-m', isMine: true })];
    h.awaiting = [row({ id: 'cr-a', status: 'APPROVED' }), row({ id: 'cr-am', status: 'APPROVED', isMine: true })];
    await ready();
    for (const b of screen.getAllByRole('button')) expect(b.getAttribute('type'), b.textContent ?? '').toBe('button');
    fireEvent.click(screen.getByRole('radio', { name: /بانتظار التطبيق/ }));
    for (const b of screen.getAllByRole('button')) expect(b.getAttribute('type'), b.textContent ?? '').toBe('button');
  });
});

describe('what each card offers — the half and whose request it is, nothing else', () => {
  it('pending, a colleague’s: the decision, and no withdrawal', async () => {
    h.pending = [row()];
    await ready();
    expect(names()).toContain('مراجعة واتخاذ القرار');
    expect(names().some((n) => n.includes('اسحب طلبي'))).toBe(false);
  });

  it('NEGATIVE: pending, her own: the withdrawal, and never the decision', async () => {
    h.pending = [row({ isMine: true })];
    await ready();
    expect(names().some((n) => n.includes('اسحب طلبي'))).toBe(true);
    expect(names()).not.toContain('مراجعة واتخاذ القرار');
  });

  it('awaiting, a colleague’s: carry it out, and take the approval back', async () => {
    h.awaiting = [row({ status: 'APPROVED' })];
    await ready();
    expect(names()).toContain('طبّق التعديل على الطلب');
    expect(names().some((n) => n.includes('تراجع عن الموافقة'))).toBe(true);
    expect(names()).not.toContain('مراجعة واتخاذ القرار');
  });

  it('NEGATIVE: awaiting, her own: carry it out, but never take back a decision on her own request', async () => {
    h.awaiting = [row({ status: 'APPROVED', isMine: true })];
    await ready();
    expect(names()).toContain('طبّق التعديل على الطلب');
    expect(names().some((n) => n.includes('تراجع عن الموافقة'))).toBe(false);
  });

  it('the button names the act: cancel, courier, postpone', async () => {
    h.awaiting = [
      row({ id: 'c1', status: 'APPROVED', intent: 'CANCEL', cancelReason: 'CUSTOMER_CHANGED_MIND', carryOut: { kind: 'CANCEL_ORDER' }, changes: {} }),
      row({ id: 'c2', status: 'APPROVED', intent: 'CANCEL', cancelReason: 'CUSTOMER_CHANGED_MIND', carryOut: { kind: 'CANCEL_VIA_COURIER' }, changes: {} }),
      row({ id: 'c3', status: 'APPROVED', intent: 'POSTPONE', postponeUntil: '2026-11-30', carryOut: { kind: 'HOLD_SHIPMENT' }, changes: {} }),
    ];
    await ready();
    expect(names()).toEqual(expect.arrayContaining(['ألغِ الطلب', 'أبلغ شركة الشحن بالإلغاء', 'أجّل الشحن']));
  });

  it('NEGATIVE: a carry-out the server refuses is drawn shut, with its reason as the button’s title', async () => {
    h.awaiting = [row({ status: 'APPROVED', carryOut: { kind: 'REFUSED', reason: 'الدفعة مفتوحة' } })];
    await ready();
    const carry = screen.getByRole('button', { name: 'نفِّذ القرار' }) as HTMLButtonElement;
    expect(carry.disabled).toBe(true);
    expect(carry.title).toBe('الدفعة مفتوحة');
  });
});

describe('a phone (375 px): nothing wider than the screen', () => {
  it('no fixed width in the screen, the rows wrap, and a long name stays on its card', async () => {
    expect(SRC()).not.toMatch(/\b(min-)?w-\[\d/);
    h.pending = [row({ blocking: true, overdue: true, changedDuringReview: true })];
    await ready();
    // The card's header and footer wrap rather than push the page sideways.
    const header = screen.getByText('TST-0001').closest('header')!;
    expect(header.className.split(' ')).toContain('flex-wrap');
    const footer = screen.getByRole('button', { name: 'مراجعة واتخاذ القرار' }).closest('footer')!;
    expect(footer.className.split(' ')).toContain('flex-wrap');
    // The pair never grows past its row.
    expect(screen.getByRole('radiogroup').className.split(' ')).toContain('max-w-full');
    expect(screen.getByText(/موظفة تجربة باسم عربي طويل/).closest('header')).toBe(header);
  });
});
