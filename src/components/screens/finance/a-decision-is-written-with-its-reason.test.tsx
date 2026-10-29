// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * THE SCREEN OFFERS A DECISION WITH ITS REASON, AND ONLY WHAT THE ORDER CAN TAKE.
 *
 * · five characters of explanation at least — four never leave the browser;
 * · the buttons the matrix refuses are grey, and the sentence beside them is the matrix’s own;
 * · «قيد المراجعة» is always there;
 * · an answered row shows its answer, the claim it left, and — until the approval — a way to answer again;
 * · «بتّ جماعي» offers the lines that carry the same word of the company, two or more, nobody has answered.
 */
const { api, toast, permissions } = vi.hoisted(() => ({
  api: vi.fn(),
  toast: { done: vi.fn(), failed: vi.fn(), warn: vi.fn() },
  permissions: { current: ['settlement.review'] as string[] },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/finance/matching',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', status: 'ACTIVE', role: 'ACCOUNTANT', permissions: permissions.current } }),
}));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>المطابقة</h1> }));
vi.mock('@/components/ui/NextStep', () => ({ NextStepButton: () => null }));
vi.mock('@/components/screens/finance/DifferencesByPerson', () => ({ DifferencesByPerson: () => null }));
vi.mock('@/components/screens/finance/ManualMatching', () => ({ ManualMatching: () => null }));
vi.mock('@/components/orders/OrderNotesPeek', () => ({ OrderNotesPeek: () => null }));

import { DifferenceActions } from './DifferenceActions';
import { BulkDecide } from './BulkDecide';
import { MatchingScreen } from './MatchingScreen';

const OK = { allowed: true, why: null };
const NO = (why: string) => ({ allowed: false, why });

const props = (over: Record<string, unknown> = {}) => ({
  statementId: 's1', matchId: 'm1', orderId: 'o1', orderNumber: 'ORD-1', resolution: null, resolutionNote: null,
  onResolved: vi.fn(), ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  permissions.current = ['settlement.review'];
  api.mockResolvedValue({});
});
afterEach(cleanup);

const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('the explanation', () => {
  it('four characters never leave the browser — the sentence appears and nothing is sent', async () => {
    render(<DifferenceActions {...props()} />);
    type('تفسير القرار', 'خصم');
    fireEvent.click(screen.getByRole('button', { name: /اعتُمد رقم الشركة/ }));

    expect(await screen.findByText('اكتب تفسير القرار — 5 أحرف على الأقل')).toBeTruthy();
    expect(api).not.toHaveBeenCalled();
  });

  it('exactly five are sent with the choice, trimmed, and the row is redrawn', async () => {
    const onResolved = vi.fn();
    render(<DifferenceActions {...props({ onResolved })} />);
    type('تفسير القرار', '  اتفقن  ');
    fireEvent.click(screen.getByRole('button', { name: /رقمنا هو المعتمد/ }));

    await waitFor(() => expect(onResolved).toHaveBeenCalled());
    expect(api).toHaveBeenCalledWith(
      '/api/finance/statements/s1/matches/m1/resolve',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ resolution: 'OURS_STANDS', note: 'اتفقن' }) })
    );
  });

  it('«قيد المراجعة» needs the explanation too', async () => {
    render(<DifferenceActions {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'قيد المراجعة' }));
    expect(await screen.findByText('اكتب تفسير القرار — 5 أحرف على الأقل')).toBeTruthy();
    expect(api).not.toHaveBeenCalled();
    type('تفسير القرار', 'ننتظر الشركة');
    fireEvent.click(screen.getByRole('button', { name: 'قيد المراجعة' }));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    expect(JSON.parse((api.mock.calls[0][1] as { body: string }).body)).toEqual({ resolution: 'UNDER_REVIEW', note: 'ننتظر الشركة' });
  });

  it('the door’s refusal is shown, not swallowed', async () => {
    api.mockRejectedValue(new Error('الطلب مُسوّى أصلاً'));
    render(<DifferenceActions {...props()} />);
    type('تفسير القرار', 'اتفقنا');
    fireEvent.click(screen.getByRole('button', { name: /اعتُمد رقم الشركة/ }));
    expect(await screen.findByText('الطلب مُسوّى أصلاً')).toBeTruthy();
  });
});

describe('what the matrix refuses is grey, with its sentence', () => {
  it('a parcel on the road: «رقمنا» is grey and says why; their figure and the parking are not', () => {
    render(
      <DifferenceActions
        {...props({ decisions: { ACCEPTED_COURIER: OK, OURS_STANDS: NO('الطرد لم يُسجَّل مسلَّماً بعد — لا مطالبة قبل التسليم'), UNDER_REVIEW: OK } })}
      />
    );
    expect((screen.getByRole('button', { name: /رقمنا هو المعتمد/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /اعتُمد رقم الشركة/ }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'قيد المراجعة' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('الطرد لم يُسجَّل مسلَّماً بعد — لا مطالبة قبل التسليم')).toBeTruthy();
  });

  it('a settled order: both figures are grey, the parking is the only way', () => {
    render(
      <DifferenceActions
        {...props({ decisions: { ACCEPTED_COURIER: NO('الطلب مُسوّى أصلاً'), OURS_STANDS: NO('الطلب مُسوّى أصلاً'), UNDER_REVIEW: OK } })}
      />
    );
    expect((screen.getByRole('button', { name: /اعتُمد رقم الشركة/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /رقمنا هو المعتمد/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'قيد المراجعة' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('with no matrix at all (an older payload) every saying is offered and the door decides', () => {
    render(<DifferenceActions {...props()} />);
    for (const name of [/اعتُمد رقم الشركة/, /رقمنا هو المعتمد/, 'قيد المراجعة']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false);
    }
  });
});

describe('an answered row', () => {
  it('shows the answer and its explanation, and — until the approval — a way to answer again', async () => {
    render(<DifferenceActions {...props({ resolution: 'ACCEPTED_COURIER', resolutionNote: 'خصم أعطاه الموظف' })} />);
    expect(screen.getByText('اعتُمد رقم الشركة')).toBeTruthy();
    expect(screen.getByText('خصم أعطاه الموظف')).toBeTruthy();
    expect(screen.queryByLabelText('تفسير القرار')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'غيّر البتّ' }));
    expect(await screen.findByLabelText('تفسير القرار')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'قيد المراجعة' })).toBeTruthy();
  });

  it('after the approval the answer is read, not changed', () => {
    render(<DifferenceActions {...props({ resolution: 'ACCEPTED_COURIER', resolutionNote: 'خصم أعطاه الموظف', locked: true })} />);
    expect(screen.queryByRole('button', { name: 'غيّر البتّ' })).toBeNull();
  });

  it('«رقمنا» shows the claim it left on the company', () => {
    render(<DifferenceActions {...props({ resolution: 'OURS_STANDS', resolutionNote: 'نطالب بالفرق', claim: 2, currency: 'JOD' })} />);
    expect(screen.getByText('رقمنا هو المعتمد')).toBeTruthy();
    expect(screen.getByText(/مطالبة على الشركة 2 JOD/)).toBeTruthy();
  });

  it('«قيد المراجعة» is read as an answer too', () => {
    render(<DifferenceActions {...props({ resolution: 'UNDER_REVIEW', resolutionNote: 'ننتظر الشركة' })} />);
    expect(screen.getByText('قيد المراجعة')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /اعتُمد رقم الشركة/ })).toBeNull();
  });
});

describe('بتّ جماعي', () => {
  const rows = (...r: Array<[string, string | null, string | null, boolean]>) =>
    r.map(([id, wordGroup, word, answered]) => ({ id, wordGroup, word, answered }));

  it('is not drawn when no two unanswered lines share a word', () => {
    const { container } = render(
      <BulkDecide
        statementId="s1"
        onDone={vi.fn()}
        rows={rows(['a', 'MEANS:POSTPONED', 'مؤجلة', false], ['b', 'MEANS:DELIVERED', 'تم توصيلها', false], ['c', 'MEANS:POSTPONED', 'مؤجلة', true], ['d', null, null, false])}
      />
    );
    expect(container.textContent).toBe('');
  });

  it('offers the group of two or more, with the word and the count, and presses all of them with ONE explanation', async () => {
    const onDone = vi.fn();
    render(
      <BulkDecide
        statementId="s1"
        onDone={onDone}
        rows={rows(['a', 'MEANS:POSTPONED', 'مؤجلة', false], ['b', 'MEANS:POSTPONED', 'مؤجل', false], ['c', 'MEANS:DELIVERED', 'تم توصيلها', false])}
      />
    );
    expect(screen.getByText(/«مؤجلة» — 2 أسطر/)).toBeTruthy();
    expect(screen.queryByText(/تم توصيلها/)).toBeNull();

    fireEvent.change(screen.getByPlaceholderText('اكتب تفسير القرار — 5 أحرف على الأقل'), { target: { value: 'ننتظر كشف الشركة' } });
    fireEvent.click(screen.getByRole('button', { name: 'بتّ الأسطر' }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(api).toHaveBeenCalledWith(
      '/api/finance/statements/s1/decisions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ matchIds: ['a', 'b'], resolution: 'UNDER_REVIEW', note: 'ننتظر كشف الشركة' }),
      })
    );
  });

  it('four characters never leave the browser', async () => {
    render(<BulkDecide statementId="s1" onDone={vi.fn()} rows={rows(['a', 'K', 'مؤجلة', false], ['b', 'K', 'مؤجلة', false])} />);
    fireEvent.change(screen.getByPlaceholderText('اكتب تفسير القرار — 5 أحرف على الأقل'), { target: { value: 'خصم' } });
    fireEvent.click(screen.getByRole('button', { name: 'بتّ الأسطر' }));
    expect(await screen.findByText('اكتب تفسير القرار — 5 أحرف على الأقل')).toBeTruthy();
    expect(api).not.toHaveBeenCalled();
  });

  it('a refusal of the door (one line cannot take it) is shown and nothing is redrawn', async () => {
    api.mockRejectedValue(new Error('لا يصحّ هذا البتّ على 1 سطراً — لم يُحفظ شيء'));
    const onDone = vi.fn();
    render(<BulkDecide statementId="s1" onDone={onDone} rows={rows(['a', 'K', 'مؤجلة', false], ['b', 'K', 'مؤجلة', false])} />);
    fireEvent.change(screen.getByPlaceholderText('اكتب تفسير القرار — 5 أحرف على الأقل'), { target: { value: 'ننتظر كشف الشركة' } });
    fireEvent.click(screen.getByRole('button', { name: 'بتّ الأسطر' }));
    expect(await screen.findByText(/لم يُحفظ شيء/)).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe('on the matching screen', () => {
  const base = {
    matchedBy: 'MERCHANT_REF', expectedFee: null, statementFee: null, feeDifference: null, resolution: null, resolutionNote: null,
    orderOutcome: null, followUp: null, claim: null, decisions: { ACCEPTED_COURIER: OK, OURS_STANDS: OK, UNDER_REVIEW: OK },
    wordGroup: 'MEANS:POSTPONED', result: 'MISMATCHED', note: null, expectedAmount: 20, statementAmount: 0, difference: -20,
    courierWord: { phrase: 'مؤجلة', outcome: 'POSTPONED', known: true, label: 'تقول الشركة: مؤجَّل' },
  };
  const mk = (n: number, over: Record<string, unknown> = {}) => ({
    ...base, id: `d${n}`,
    order: { id: `o${n}`, orderNumber: `ORD-${n}`, merchantRef: `REF-${n}`, shippingStatus: 'DELIVERED' },
    statementLine: { merchantRef: `REF-${n}`, barcode: null, amount: 0, status: 'مؤجلة', rawRow: 'raw' },
    ...over,
  });

  const serve = (approvedAt: string | null) =>
    api.mockImplementation(async (url: string) => {
      if (url === '/api/finance/statements') {
        return { statements: [{ id: 's1', reference: 'ST-1', status: 'MATCHED', approvedAt, currencyCode: 'JOD', counts: { lines: 3, receipts: 1, matches: 3 } }] };
      }
      if (url === '/api/finance/statements/s1') return { statement: { matches: [mk(1), mk(2), mk(3, { resolution: 'UNDER_REVIEW', resolutionNote: 'ننتظر' })] } };
      return {};
    });

  it('offers the bulk press for the two lines nobody has answered — not the third, which is parked', async () => {
    serve(null);
    render(<MatchingScreen />);
    expect(await screen.findByText(/«مؤجلة» — 2 أسطر/)).toBeTruthy();
  });

  it('and not after the approval, nor to somebody who may not review', async () => {
    serve('2026-10-29T10:00:00Z');
    const { unmount } = render(<MatchingScreen />);
    await screen.findAllByText('فرق في المبلغ');
    expect(screen.queryByText(/أسطر بكلمة واحدة للشركة/)).toBeNull();
    unmount();

    serve(null);
    permissions.current = ['settlement.view'];
    render(<MatchingScreen />);
    await screen.findAllByText('فرق في المبلغ');
    expect(screen.queryByText(/أسطر بكلمة واحدة للشركة/)).toBeNull();
  });
});
