// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * THE SCREEN WHERE A «فرق تحصيل» IS DECIDED.
 *
 * A shortfall is named by what happens to it — «بانتظار قرار المالك أو المحاسب», «التفسير مقبول — على الشركة», «يُخصم» —
 * and carries the words the approval wrote («طلب · كشف · التفسير»). The one who decides can MOVE it to the person who
 * really collected the parcel; the box lists people to choose from and asks for no reason (the reason is fixed).
 */
const { api, toast } = vi.hoisted(() => ({ api: vi.fn(), toast: { failed: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u-acc', status: 'ACTIVE', role: 'ACCOUNTANT', permissions: ['penalties.view', 'penalties.decide'] } }),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
vi.mock('@/hooks/useLiveRefresh', async () => {
  const react = await import('react');
  return { useLiveRefresh: (load: () => void) => react.useEffect(() => { void load(); }, [load]) };
});

import { PenaltiesScreen } from './PenaltiesScreen';

const KINDS = [
  { key: 'LATE', ar: 'التأخير', unitAr: 'دقيقة', sourceAr: '' },
  { key: 'SHORTFALL', ar: 'فرق تحصيل', unitAr: 'طلب', sourceAr: '' },
];
const row = (over: Record<string, unknown> = {}) => ({
  id: 'p1', kind: 'SHORTFALL', occurredOn: '2026-10-18T00:00:00Z', units: 1, chargedUnits: 1, amount: 2, currencyCode: 'USD',
  status: 'PROPOSED', note: 'ORD-1 · ST-1 · خصم أعطاه الموظف', decisionNote: null, decidedAt: null, payslipId: null, reversesId: null,
  settlementMatchId: 'm1', user: { id: 'u-sara', name: 'سارة', role: 'FOLLOW_UP_AGENT' }, ...over,
});
let rows: ReturnType<typeof row>[];
const posts = () => api.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST');

beforeEach(() => {
  vi.clearAllMocks();
  rows = [row()];
  api.mockImplementation(async (url: string) => {
    if (url.includes('people=1')) return { people: [{ id: 'u-sara', name: 'سارة' }, { id: 'u-mona', name: 'منى' }] };
    if (url.startsWith('/api/team/penalties')) return { kinds: KINDS, penalties: rows };
    return {};
  });
});
afterEach(cleanup);

describe('a shortfall on the screen', () => {
  it('is named «بانتظار قرار المالك أو المحاسب», carries the approval’s words, and says what it is', async () => {
    render(<PenaltiesScreen />);
    expect(await screen.findByText('بانتظار قرار المالك أو المحاسب')).toBeTruthy();
    expect(screen.getByText('ORD-1 · ST-1 · خصم أعطاه الموظف')).toBeTruthy();
    expect(screen.getByText(/فرق تحصيل/)).toBeTruthy();
  });

  it('WAIVED reads «التفسير مقبول — على الشركة» and APPLIED reads «يُخصم»', async () => {
    rows = [row({ id: 'p2', status: 'WAIVED' }), row({ id: 'p3', status: 'APPLIED' })];
    render(<PenaltiesScreen />);
    expect(await screen.findByText('التفسير مقبول — على الشركة')).toBeTruthy();
    expect(screen.getByText('يُخصم')).toBeTruthy();
  });

  it('a lateness charge keeps the general words — the names belong to the shortfall only', async () => {
    rows = [row({ id: 'p4', kind: 'LATE', settlementMatchId: null, status: 'PROPOSED', note: null })];
    render(<PenaltiesScreen />);
    expect(await screen.findByText('مقترح')).toBeTruthy();
    expect(screen.queryByText('بانتظار قرار المالك أو المحاسب')).toBeNull();
    expect(screen.queryByRole('button', { name: /حوّل لموظف آخر/ })).toBeNull();
  });
});

describe('moving it to the person who really collected the parcel', () => {
  it('offers «حوّل لموظف آخر» on a PROPOSED shortfall — and not on an applied one', async () => {
    rows = [row({ id: 'p1' }), row({ id: 'p2', status: 'APPLIED' })];
    render(<PenaltiesScreen />);
    await screen.findAllByText('سارة');
    expect(screen.getAllByRole('button', { name: /حوّل لموظف آخر/ })).toHaveLength(1);
  });

  it('lists the people except the one who carries it now, and asks for no reason', async () => {
    render(<PenaltiesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: /حوّل لموظف آخر/ }));
    const dialog = await screen.findByRole('dialog');
    const options = within(dialog).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['اختر…', 'منى']);
    expect(within(dialog).queryByRole('textbox')).toBeNull();
  });

  it('«تأكيد» is off until a person is picked, then sends the move with that person and no reason', async () => {
    render(<PenaltiesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: /حوّل لموظف آخر/ }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'تأكيد' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'u-mona' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String((posts()[0][1] as RequestInit).body))).toEqual({ penaltyId: 'p1', action: 'retarget', userId: 'u-mona' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('asks the server for the people only once, and only for the one who decides', async () => {
    render(<PenaltiesScreen />);
    await screen.findByText('بانتظار قرار المالك أو المحاسب');
    expect(api.mock.calls.filter((c) => String(c[0]).includes('people=1'))).toHaveLength(1);
  });
});

describe('the other two decisions still ask for a reason', () => {
  it('«ألغِ» opens the reason box with a text area', async () => {
    render(<PenaltiesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: /ألغِ/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('textbox')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'تأكيد' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
