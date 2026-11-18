// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * «الإشكالات» ON THE KIT (18/11, request R8g).
 *
 * The screen moved onto the shared parts: the frame (`PageShell`), the button (`Button`) and the surface (`Card`). Nothing it
 * does was meant to move with it. This file holds that, press by press: the same presses, drawn for the same keys, sending
 * the same requests in the same order — and the negatives (no key, no button; an empty reason, no request; a press while the
 * save is in the air, refused).
 */

const { api, patch, toastFailed, user, phone } = vi.hoisted(() => ({
  api: vi.fn(),
  patch: vi.fn(),
  toastFailed: vi.fn(),
  user: { current: { id: 'u1', role: 'CUSTOM', permissions: [] as string[], status: 'ACTIVE' } as Record<string, unknown> },
  phone: { value: true },
}));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: user.current, locale: 'ar', isRtl: true }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: toastFailed, done: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('next/navigation', () => ({ usePathname: () => '/confirmation/issues', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/orders/OrderRef', () => ({ OrderRef: ({ number }: { number: string }) => <span>{number}</span> }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryOffer: () => <i data-testid="history" /> }));
vi.mock('@/components/orders/useOrderPatch', () => ({ useOrderPatch: () => patch }));
vi.mock('@/hooks/useRegions', () => ({ useRegions: () => ({ regions: [{ id: 'r1', name: 'المحافظة أ' }, { id: 'r2', name: 'المحافظة ب' }], countryName: '' }) }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<unknown>) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, []);
  },
}));

import { ConfirmationIssuesScreen } from './ConfirmationIssuesScreen';
import { routeLabel } from '@/lib/route-registry';

const ISSUE = {
  id: 'i1', reason: 'WRONG_PHONE', note: null, status: 'OPEN', createdAt: '2026-10-20T10:00:00.000Z',
  order: {
    id: 'o1', orderNumber: 'ORD-77', createdAt: '2026-10-19T10:00:00.000Z', source: 'MANUAL', version: 4, quantity: 1,
    regionId: 'r1', region: { id: 'r1', name: 'المحافظة أ' }, product: { name: 'منتج' }, confirmationStatus: 'NEW',
    customer: { id: 'c1', fullName: 'عميل', phone: '0700000000', rawPhone: '0700000000', altPhone: null, city: 'مدينة', address: 'عنوان' },
    moderator: null,
  },
};

const BOTH = ['confirmation.issues', 'confirmation.issues_correct', 'orders.cancel'];
const holding = (...keys: string[]) => {
  user.current = { id: 'u1', role: 'CUSTOM', permissions: keys, status: 'ACTIVE' };
};

/** Every request the screen sent, as [url, method, body]. */
const sent = () =>
  api.mock.calls.map(([url, init]) => [
    String(url),
    (init as RequestInit | undefined)?.method ?? 'GET',
    (init as RequestInit | undefined)?.body ? JSON.parse(String((init as RequestInit).body)) : null,
  ]);

const draw = async () => {
  render(<ConfirmationIssuesScreen />);
  await screen.findByText('ORD-77');
};
const press = (name: RegExp) => fireEvent.click(screen.getByRole('button', { name }));

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = true;
  holding(...BOTH);
  api.mockImplementation(async (url: string) => (url === '/api/confirmation/issues' ? { issues: [ISSUE] } : { ok: true }));
  patch.mockResolvedValue({ ok: true, json: async () => ({}) });
});
afterEach(cleanup);

describe('«الإشكالات» on the kit — the frame', () => {
  it('one h1, the registry’s name, inside the medium frame; the list is the one GET it always was', async () => {
    await draw();
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe(routeLabel('/confirmation/issues'));
    expect(h1s[0].closest('.max-w-4xl'), 'العرض مش medium').not.toBeNull();
    expect(sent()).toEqual([['/api/confirmation/issues', 'GET', null]]);
  });

  it('375 px: nothing in the screen asks for a fixed width wider than the phone', async () => {
    window.innerWidth = 375;
    const { container } = render(<ConfirmationIssuesScreen />);
    await screen.findByText('ORD-77');
    press(/صحّح البيانات/);
    // Built from pieces so the stylesheet scanner does not read these words as classes to ship.
    const wide = new RegExp(['w-' + 'screen', 'min-w-' + '\\[', 'w-' + '\\[\\d{3,}', 'whitespace-' + 'nowrap', 'overflow-x-' + 'scroll'].join('|'));
    const offenders = [...container.querySelectorAll('*')].filter((el) => wide.test(el.getAttribute('class') ?? ''));
    expect(offenders.map((el) => el.getAttribute('class'))).toEqual([]);
  });

  it('every press is the kit’s button — the source has no hand-written <button left', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/screens/ConfirmationIssuesScreen.tsx'), 'utf8');
    expect(src.match(/<button(?=[\s>/])/g) ?? []).toEqual([]);
    expect(src).toMatch(/import \{ Button \} from '@\/components\/ui\/Button';/);
    expect(src).toMatch(/import \{ Card \} from '@\/components\/ui\/Card';/);
  });
});

describe('«الإشكالات» on the kit — the gates', () => {
  it.each([
    ['both keys', BOTH, true, true],
    ['the correction only', ['confirmation.issues', 'confirmation.issues_correct'], true, false],
    ['the cancel only', ['confirmation.issues', 'orders.cancel'], false, true],
    ['NEGATIVE: the list only', ['confirmation.issues'], false, false],
  ] as const)('%s', async (_name, keys, correct, voids) => {
    holding(...keys);
    await draw();
    expect(!!screen.queryByRole('button', { name: /صحّح البيانات/ })).toBe(correct);
    expect(!!screen.queryByRole('button', { name: /إبطال الطلب/ })).toBe(voids);
  });
});

describe('«الإشكالات» on the kit — each press, what it sends', () => {
  it('«صحّح البيانات» opens the fields with the flagged one marked, and sends nothing', async () => {
    await draw();
    press(/صحّح البيانات/);
    expect(screen.getByDisplayValue('0700000000')).toBeTruthy();
    expect(screen.getByRole('button', { name: /احفظ التصحيح/ })).toBeTruthy();
    expect(sent()).toHaveLength(1);
    expect(patch).not.toHaveBeenCalled();
  });

  it('«احفظ التصحيح» saves the ORDER first (version guard), then closes the issue with what changed', async () => {
    await draw();
    press(/صحّح البيانات/);
    fireEvent.change(screen.getByDisplayValue('0700000000'), { target: { value: '0711111111' } });
    press(/احفظ التصحيح/);
    await waitFor(() => expect(sent().filter(([, m]) => m === 'PATCH')).toHaveLength(1));
    expect(patch).toHaveBeenCalledWith('o1', {
      expectedVersion: 4,
      customerName: 'عميل',
      customerPhone: '0711111111',
      customerAddress: 'عنوان',
      regionId: 'r1',
    });
    const [url, , body] = sent().find(([, m]) => m === 'PATCH')!;
    expect(url).toBe('/api/confirmation/issues/i1');
    expect(body).toEqual({ action: 'correct', note: 'رقم الهاتف: 0700000000 ← 0711111111' });
    expect(patch.mock.invocationCallOrder[0]).toBeLessThan(api.mock.invocationCallOrder[1]);
  });

  it('NEGATIVE: nothing changed — no save, no close, a sentence instead', async () => {
    await draw();
    press(/صحّح البيانات/);
    press(/احفظ التصحيح/);
    expect(toastFailed).toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    expect(sent()).toHaveLength(1);
  });

  it('NEGATIVE: the order refuses the save — the issue is NOT closed', async () => {
    patch.mockResolvedValue({ ok: false, json: async () => ({ errorAr: 'رقم غير صالح' }) });
    await draw();
    press(/صحّح البيانات/);
    fireEvent.change(screen.getByDisplayValue('0700000000'), { target: { value: '1' } });
    press(/احفظ التصحيح/);
    await waitFor(() => expect(toastFailed).toHaveBeenCalledWith('رقم غير صالح'));
    expect(sent().filter(([, m]) => m === 'PATCH')).toEqual([]);
  });

  it('NEGATIVE: while the save is in the air, the save press is disabled and says so', async () => {
    let release: (v: unknown) => void = () => {};
    patch.mockReturnValue(new Promise((r) => (release = r)));
    await draw();
    press(/صحّح البيانات/);
    fireEvent.change(screen.getByDisplayValue('0700000000'), { target: { value: '0722222222' } });
    press(/احفظ التصحيح/);
    const saving = await screen.findByRole('button', { name: /جارٍ الحفظ/ });
    expect((saving as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(saving);
    expect(patch).toHaveBeenCalledTimes(1);
    release({ ok: true, json: async () => ({}) });
    await waitFor(() => expect(sent().filter(([, m]) => m === 'PATCH')).toHaveLength(1));
  });

  it('«إلغاء» closes the fields and sends nothing', async () => {
    await draw();
    press(/صحّح البيانات/);
    press(/^إلغاء$/);
    expect(screen.queryByRole('button', { name: /احفظ التصحيح/ })).toBeNull();
    expect(screen.getByRole('button', { name: /صحّح البيانات/ })).toBeTruthy();
    expect(sent()).toHaveLength(1);
  });

  it('«إبطال الطلب» opens the reason, and «تأكيد الإبطال» sends the void with it', async () => {
    await draw();
    press(/إبطال الطلب/);
    const box = screen.getByText('سبب الإبطال').closest('label')!;
    fireEvent.change(within(box).getByRole('textbox'), { target: { value: '  مكرر  ' } });
    press(/تأكيد الإبطال/);
    await waitFor(() => expect(sent().filter(([, m]) => m === 'PATCH')).toHaveLength(1));
    expect(sent().find(([, m]) => m === 'PATCH')).toEqual(['/api/confirmation/issues/i1', 'PATCH', { action: 'void', note: 'مكرر' }]);
    expect(patch).not.toHaveBeenCalled();
  });

  it('NEGATIVE: «تأكيد الإبطال» with no reason sends nothing', async () => {
    await draw();
    press(/إبطال الطلب/);
    press(/تأكيد الإبطال/);
    expect(toastFailed).toHaveBeenCalledWith('سبب الإبطال مطلوب.');
    expect(sent()).toHaveLength(1);
  });

  it('«تراجع» closes the reason and sends nothing', async () => {
    await draw();
    press(/إبطال الطلب/);
    press(/^تراجع$/);
    expect(screen.queryByText('سبب الإبطال')).toBeNull();
    expect(screen.getByRole('button', { name: /إبطال الطلب/ })).toBeTruthy();
    expect(sent()).toHaveLength(1);
  });

  it('the desk draws the same presses (no phone/desktop split was added)', async () => {
    phone.value = false;
    await draw();
    expect(screen.getByRole('button', { name: /صحّح البيانات/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /إبطال الطلب/ })).toBeTruthy();
  });
});
