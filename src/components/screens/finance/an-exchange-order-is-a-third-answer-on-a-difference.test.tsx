// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * «طلب تبديل» ON THE SCREEN — THE THIRD ANSWER BESIDE THE TWO (the owner, 13/11).
 *
 *   «احيانا بيكون طلب تبديل او زبون وصلو الطلب ناقص فنبعثلو حبة فلازم يا تعمل خيار يعطيك انو طلب تبديل»
 *
 * What the screen must do, read from the DOM a person gets (on a phone first):
 *
 *   · a third button «طلب تبديل» beside «اعتُمد رقم الشركة» and «رقمنا هو المعتمد» — the same size, a real <button>, 44 px on a phone —
 *     greyed by exactly the verdict of «اعتُمد رقم الشركة» (the same cell, so the same sentence) and drawn only where an answer is taken
 *     (not on a line no order carries, not on a closed statement);
 *   · its hint printed under the pair on a phone (there is no hover) and in its `title` on the desk, in the owner's own words;
 *   · it needs the explanation like the others, and sends `exchange: true` beside the courier's figure — and ONLY it does: the other
 *     answers are the body they always were;
 *   · the answered row reads «طلب تبديل» (the green chip) when the server says so, «اعتُمد رقم الشركة» when it does not — including an
 *     older server that sends no qualifier at all — and a qualifier standing beside any OTHER answer is read as nothing;
 *   · «غيّر البتّ» moves a line from the exchange to either figure and back;
 *   · it is NOT in the bulk answer, and it carries NO NEW CSS.
 */

const { api, toast, permissions, phone } = vi.hoisted(() => ({
  api: vi.fn(),
  toast: { done: vi.fn(), failed: vi.fn(), warn: vi.fn() },
  permissions: { current: ['settlement.review'] as string[] },
  phone: { value: false },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
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
import { EXCHANGE_AR, EXCHANGE_MEANING, RESOLUTIONS } from '@/lib/settlement-difference';
import { STATEMENT_CLOSED_SENTENCE } from '@/lib/settlement-gates';

const OK = { allowed: true, why: null };
const NO = (why: string) => ({ allowed: false, why });
const THE_HINT = 'تبديل أو حبة ناقصة بعتناها للزبون — ما إلها ثمن؛ رقم الشركة هو الصحيح وما بينحسب خصم على حدا.';
const SENTENCE = 'اكتب تفسيراً واضحاً: 5 أحرف على الأقل، منها 3 حروف أو أرقام';
const URL_OF = '/api/finance/statements/s1/matches/m1/resolve';

const props = (over: Record<string, unknown> = {}) => ({
  statementId: 's1', matchId: 'm1', orderId: 'o1', orderNumber: 'ORD-1', resolution: null, resolutionNote: null,
  onResolved: vi.fn(), ...over,
});
const type = (value: string) => fireEvent.change(screen.getByLabelText('تفسير القرار'), { target: { value } });
const buttonNamed = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;
const bodyOf = (call = 0) => JSON.parse((api.mock.calls[call][1] as { body: string }).body) as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  permissions.current = ['settlement.review'];
  phone.value = false;
  api.mockResolvedValue({});
});
afterEach(cleanup);

describe('the third button', () => {
  it('is a real <button> named «طلب تبديل», beside the two answers and before «قيد المراجعة» — in that order', () => {
    render(<DifferenceActions {...props()} />);
    const names = screen.getAllByRole('button').map((b) => b.textContent?.trim());
    expect(names).toEqual(['اعتُمد رقم الشركة', 'رقمنا هو المعتمد', 'طلب تبديل', 'قيد المراجعة']);
    expect(buttonNamed('طلب تبديل').tagName).toBe('BUTTON');
    expect(buttonNamed('طلب تبديل').getAttribute('type')).toBe('button');
  });

  it('is the same size as the others — 44 px on a phone, free on the desk — and wears only classes its siblings wear', () => {
    render(<DifferenceActions {...props()} />);
    const mine = buttonNamed('طلب تبديل').className.split(/\s+/);
    for (const c of ['min-h-11', 'md:min-h-0', 'inline-flex', 'items-center', 'gap-1', 'rounded-md', 'border', 'px-2', 'py-1', 'text-xs', 'font-medium', 'transition-colors', 'disabled:opacity-50']) {
      expect(mine, c).toContain(c);
    }
    const siblings = new Set(
      ['اعتُمد رقم الشركة', 'رقمنا هو المعتمد', 'قيد المراجعة'].flatMap((n) => buttonNamed(n).className.split(/\s+/))
    );
    // On the desk the siblings' resting look is the muted one; the new button's tokens are all among them.
    phone.value = false;
    for (const c of mine) expect(siblings.has(c), `${c} is worn by no sibling`).toBe(true);
  });

  it('carries the owner’s hint in its title (what a hover shows on the desk)', () => {
    render(<DifferenceActions {...props()} />);
    expect(buttonNamed('طلب تبديل').getAttribute('title')).toBe(THE_HINT);
    expect(EXCHANGE_MEANING).toBe(THE_HINT);
    expect(EXCHANGE_AR).toBe('طلب تبديل');
  });

  it('on a phone the hint is PRINTED under the pair, like the other two (there is no hover) — and not on the desk', () => {
    phone.value = true;
    const { container, unmount } = render(<DifferenceActions {...props()} />);
    const hints = container.querySelector('span.block.w-full') as HTMLElement;
    expect(hints).toBeTruthy();
    expect(within(hints).getByText(THE_HINT, { exact: false })).toBeTruthy();
    // The three explanations are in one block, in the order of the buttons: their figure, ours, the exchange.
    const lines = [...hints.querySelectorAll('span.block')].map((s) => s.textContent);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('اعتُمد رقم الشركة:');
    expect(lines[1]).toContain('رقمنا هو المعتمد:');
    expect(lines[2]).toBe(`طلب تبديل: ${THE_HINT}`);
    unmount();

    phone.value = false;
    render(<DifferenceActions {...props()} />);
    expect(screen.queryByText(THE_HINT, { exact: false })).toBeNull();
  });

  it('is greyed by exactly the verdict of «اعتُمد رقم الشركة» — over all four combinations of that verdict and «رقمنا»', () => {
    for (const accepted of [OK, NO('الطلب مُسوّى أصلاً')]) {
      for (const ours of [OK, NO('لا نقص نطالب به — رقم الشركة ليس أقل من رقمنا')]) {
        const { unmount } = render(<DifferenceActions {...props({ decisions: { ACCEPTED_COURIER: accepted, OURS_STANDS: ours, UNDER_REVIEW: OK } })} />);
        expect(buttonNamed('طلب تبديل').disabled, `${accepted.allowed}/${ours.allowed}`).toBe(!accepted.allowed);
        expect(buttonNamed('اعتُمد رقم الشركة').disabled).toBe(buttonNamed('طلب تبديل').disabled);
        // «قيد المراجعة» is the valve and is never closed by it.
        expect(buttonNamed('قيد المراجعة').disabled).toBe(false);
        unmount();
      }
    }
  });

  it('and says why with the matrix’s own sentence — the very one that greys their figure', () => {
    render(<DifferenceActions {...props({ decisions: { ACCEPTED_COURIER: NO('الطلب مُسوّى أصلاً (حُصّل يدوياً أو بكشف) — لا بتّ عليه'), OURS_STANDS: NO('الطلب مُسوّى أصلاً (حُصّل يدوياً أو بكشف) — لا بتّ عليه'), UNDER_REVIEW: OK } })} />);
    expect(buttonNamed('طلب تبديل').disabled).toBe(true);
    expect(screen.getByText('الطلب مُسوّى أصلاً (حُصّل يدوياً أو بكشف) — لا بتّ عليه')).toBeTruthy();
  });

  it('a parcel on the road where their figure is allowed (a statement with money): it is allowed too', () => {
    render(<DifferenceActions {...props({ decisions: { ACCEPTED_COURIER: OK, OURS_STANDS: NO('الطرد لم يُسجَّل مسلَّماً بعد — لا مطالبة قبل التسليم'), UNDER_REVIEW: OK } })} />);
    expect(buttonNamed('طلب تبديل').disabled).toBe(false);
    expect(buttonNamed('رقمنا هو المعتمد').disabled).toBe(true);
  });

  it('with no matrix at all (an older payload) it is offered, and the door decides', () => {
    render(<DifferenceActions {...props()} />);
    expect(buttonNamed('طلب تبديل').disabled).toBe(false);
  });

  it('is not drawn on a line no order carries (only «قيد المراجعة» is) — nor on a closed statement (the sentence is)', () => {
    const { unmount } = render(<DifferenceActions {...props({ parkOnly: true, orderId: null, orderNumber: null })} />);
    expect(screen.queryByRole('button', { name: 'طلب تبديل' })).toBeNull();
    expect(screen.getByRole('button', { name: 'قيد المراجعة' })).toBeTruthy();
    unmount();

    render(<DifferenceActions {...props({ locked: true })} />);
    expect(screen.queryByRole('button', { name: 'طلب تبديل' })).toBeNull();
    expect(screen.getByText(STATEMENT_CLOSED_SENTENCE)).toBeTruthy();
  });
});

describe('pressing it', () => {
  it('needs the explanation first — four characters never leave the browser', async () => {
    render(<DifferenceActions {...props()} />);
    type('خصم');
    fireEvent.click(buttonNamed('طلب تبديل'));
    expect(await screen.findByText(SENTENCE)).toBeTruthy();
    expect(api).not.toHaveBeenCalled();
  });

  it('sends exactly `exchange: true` beside the courier’s figure and the trimmed explanation — then redraws the row', async () => {
    const onResolved = vi.fn();
    render(<DifferenceActions {...props({ onResolved })} />);
    type('  تبديل حبة ناقصة  ');
    fireEvent.click(buttonNamed('طلب تبديل'));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith(URL_OF, expect.objectContaining({ method: 'POST' }));
    expect(bodyOf()).toEqual({ resolution: 'ACCEPTED_COURIER', exchange: true, note: 'تبديل حبة ناقصة' });
  });

  it('and ONLY it does: every other answer is the body it always was — no `exchange` key at all', async () => {
    for (const [name, resolution] of [['اعتُمد رقم الشركة', 'ACCEPTED_COURIER'], ['رقمنا هو المعتمد', 'OURS_STANDS'], ['قيد المراجعة', 'UNDER_REVIEW']] as const) {
      api.mockClear();
      const { unmount } = render(<DifferenceActions {...props()} />);
      type('ننتظر كشف الشركة');
      fireEvent.click(buttonNamed(name));
      await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
      expect(api.mock.calls[0][1].body, name).toBe(JSON.stringify({ resolution, note: 'ننتظر كشف الشركة' }));
      expect(Object.keys(bodyOf()), name).toEqual(['resolution', 'note']);
      unmount();
    }
  });

  it('the door’s refusal is shown, not swallowed — and the row is not redrawn', async () => {
    api.mockRejectedValue(new Error('الطلب مُسوّى أصلاً (حُصّل يدوياً أو بكشف) — لا بتّ عليه'));
    const onResolved = vi.fn();
    render(<DifferenceActions {...props({ onResolved })} />);
    type('تبديل حبة ناقصة');
    fireEvent.click(buttonNamed('طلب تبديل'));
    expect(await screen.findByText('الطلب مُسوّى أصلاً (حُصّل يدوياً أو بكشف) — لا بتّ عليه')).toBeTruthy();
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('while it is being saved every button is held, and the spinner is on the exchange alone', async () => {
    let finish: () => void = () => undefined;
    api.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { container } = render(<DifferenceActions {...props()} />);
    type('تبديل حبة ناقصة');
    fireEvent.click(buttonNamed('طلب تبديل'));
    await waitFor(() => expect(buttonNamed('طلب تبديل').disabled).toBe(true));
    for (const n of ['اعتُمد رقم الشركة', 'رقمنا هو المعتمد', 'قيد المراجعة']) expect(buttonNamed(n).disabled, n).toBe(true);
    expect(buttonNamed('طلب تبديل').querySelector('svg.animate-spin')).toBeTruthy();
    expect(buttonNamed('اعتُمد رقم الشركة').querySelector('svg.animate-spin')).toBeNull();
    expect(container.querySelectorAll('svg.animate-spin')).toHaveLength(1);
    finish();
  });
});

describe('an answered row', () => {
  const answered = (over: Record<string, unknown> = {}) =>
    props({ resolution: 'ACCEPTED_COURIER', resolutionNote: 'تبديل حبة ناقصة بعتناها للزبون', ...over });

  it('reads «طلب تبديل» — and not «اعتُمد رقم الشركة» — when the server says it is one, with its explanation', () => {
    render(<DifferenceActions {...answered({ resolutionKind: 'EXCHANGE' })} />);
    expect(screen.getByText('طلب تبديل')).toBeTruthy();
    expect(screen.queryByText('اعتُمد رقم الشركة')).toBeNull();
    expect(screen.getByText('تبديل حبة ناقصة بعتناها للزبون')).toBeTruthy();
    expect(screen.queryByLabelText('تفسير القرار')).toBeNull();
  });

  it('the chip is the green one the other answers wear — no chip of its own', () => {
    const { container } = render(<DifferenceActions {...answered({ resolutionKind: 'EXCHANGE' })} />);
    const chip = [...container.querySelectorAll('span')].find((s) => s.textContent === 'طلب تبديل')!;
    expect(chip.className).toContain('border-[var(--sys-success)]/40');
    expect(chip.className).toContain('bg-[var(--sys-success-soft)]');
    const plainChip = (() => {
      cleanup();
      const r = render(<DifferenceActions {...answered()} />);
      return [...r.container.querySelectorAll('span')].find((s) => s.textContent === 'اعتُمد رقم الشركة')!;
    })();
    expect(chip.className).toBe(plainChip.className);
  });

  it('reads «اعتُمد رقم الشركة» when there is no qualifier — null, absent (an older server), or a word nobody knows', () => {
    for (const resolutionKind of [null, undefined, '', 'SOMETHING_ELSE']) {
      const { unmount } = render(<DifferenceActions {...answered({ resolutionKind })} />);
      expect(screen.getByText('اعتُمد رقم الشركة'), String(resolutionKind)).toBeTruthy();
      expect(screen.queryByText('طلب تبديل'), String(resolutionKind)).toBeNull();
      unmount();
    }
  });

  it('a qualifier beside ANY OTHER answer is read as nothing — «رقمنا» and «قيد المراجعة» keep their own words', () => {
    const { unmount } = render(<DifferenceActions {...props({ resolution: 'OURS_STANDS', resolutionKind: 'EXCHANGE', resolutionNote: 'نطالب بالفرق', claim: 2, currency: 'JOD' })} />);
    expect(screen.getByText('رقمنا هو المعتمد')).toBeTruthy();
    expect(screen.queryByText('طلب تبديل')).toBeNull();
    expect(screen.getByText(/مطالبة على الشركة 2 JOD/)).toBeTruthy();
    unmount();
    render(<DifferenceActions {...props({ resolution: 'UNDER_REVIEW', resolutionKind: 'EXCHANGE', resolutionNote: 'ننتظر الشركة' })} />);
    expect(screen.getByText('قيد المراجعة')).toBeTruthy();
    expect(screen.queryByText('طلب تبديل')).toBeNull();
  });

  it('after the approval it is read, not changed: the chip stays, «غيّر البتّ» goes', () => {
    render(<DifferenceActions {...answered({ resolutionKind: 'EXCHANGE', locked: true })} />);
    expect(screen.getByText('طلب تبديل')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'غيّر البتّ' })).toBeNull();
  });
});

describe('«غيّر البتّ» — from the exchange to either figure and back', () => {
  it('opens the whole choice again from an exchange — the explanation box, all four answers', async () => {
    render(<DifferenceActions {...props({ resolution: 'ACCEPTED_COURIER', resolutionKind: 'EXCHANGE', resolutionNote: 'تبديل حبة ناقصة' })} />);
    fireEvent.click(buttonNamed('غيّر البتّ'));
    expect(await screen.findByLabelText('تفسير القرار')).toBeTruthy();
    expect(screen.getAllByRole('button').map((b) => b.textContent?.trim())).toEqual(['اعتُمد رقم الشركة', 'رقمنا هو المعتمد', 'طلب تبديل', 'قيد المراجعة']);
  });

  it('exchange → «رقمنا» → exchange → their figure: each answer sends its own body, and the chip follows what the server saved', async () => {
    const onResolved = vi.fn();
    const saved = (resolution: string, resolutionKind: string | null) =>
      props({ onResolved, resolution, resolutionKind, resolutionNote: 'شرح كافٍ للبتّ' });
    const { rerender } = render(<DifferenceActions {...saved('ACCEPTED_COURIER', 'EXCHANGE')} />);
    expect(screen.getByText('طلب تبديل')).toBeTruthy();

    // exchange → ours
    fireEvent.click(buttonNamed('غيّر البتّ'));
    type('نطالب بالفرق');
    fireEvent.click(buttonNamed('رقمنا هو المعتمد'));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(bodyOf(0)).toEqual({ resolution: 'OURS_STANDS', note: 'نطالب بالفرق' });
    rerender(<DifferenceActions {...saved('OURS_STANDS', null)} />);
    expect(screen.getByText('رقمنا هو المعتمد')).toBeTruthy();

    // ours → exchange
    fireEvent.click(buttonNamed('غيّر البتّ'));
    type('تبديل حبة ناقصة');
    fireEvent.click(buttonNamed('طلب تبديل'));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(2));
    expect(bodyOf(1)).toEqual({ resolution: 'ACCEPTED_COURIER', exchange: true, note: 'تبديل حبة ناقصة' });
    rerender(<DifferenceActions {...saved('ACCEPTED_COURIER', 'EXCHANGE')} />);
    expect(screen.getByText('طلب تبديل')).toBeTruthy();

    // exchange → their figure, plainly
    fireEvent.click(buttonNamed('غيّر البتّ'));
    type('خصم أعطاه الموظف');
    fireEvent.click(buttonNamed('اعتُمد رقم الشركة'));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(3));
    expect(bodyOf(2)).toEqual({ resolution: 'ACCEPTED_COURIER', note: 'خصم أعطاه الموظف' });
    expect(Object.keys(bodyOf(2))).not.toContain('exchange');
    rerender(<DifferenceActions {...saved('ACCEPTED_COURIER', null)} />);
    expect(screen.getByText('اعتُمد رقم الشركة')).toBeTruthy();
    expect(screen.queryByText('طلب تبديل')).toBeNull();
  });
});

describe('on the matching screen', () => {
  const base = {
    matchedBy: 'MERCHANT_REF', expectedFee: null, statementFee: null, feeDifference: null, resolution: null, resolutionNote: null,
    orderOutcome: null, followUp: null, claim: null, decisions: { ACCEPTED_COURIER: OK, OURS_STANDS: OK, UNDER_REVIEW: OK },
    wordGroup: 'MEANS:RETURNED', result: 'MISMATCHED', note: null, expectedAmount: 17, statementAmount: -3, difference: -20,
    courierWord: { phrase: 'تم إرجاعها', outcome: 'RETURNED', known: true, label: 'تقول الشركة: رجع' },
  };
  const mk = (n: number, over: Record<string, unknown> = {}) => ({
    ...base, id: `d${n}`,
    order: { id: `o${n}`, orderNumber: `ORD-${n}`, merchantRef: `REF-${n}`, shippingStatus: 'DELIVERED' },
    statementLine: { merchantRef: `REF-${n}`, barcode: null, amount: -3, status: 'تم إرجاعها', rawRow: 'raw' },
    ...over,
  });
  const serve = (matches: unknown[], approvedAt: string | null = null) =>
    api.mockImplementation(async (url: string) => {
      if (url === '/api/finance/statements') {
        return { statements: [{ id: 's1', reference: 'ST-1', status: 'MATCHED', approvedAt, currencyCode: 'USD', counts: { lines: 3, receipts: 1, matches: 3 } }] };
      }
      if (url === '/api/finance/statements/s1') return { statement: { matches } };
      return {};
    });

  it('draws the chip from the field the server sent — the line of the screenshot reads «طلب تبديل», the others do not', async () => {
    serve([
      mk(1, { resolution: 'ACCEPTED_COURIER', resolutionKind: 'EXCHANGE', resolutionNote: 'حبة ناقصة بعتناها' }),
      mk(2, { resolution: 'ACCEPTED_COURIER', resolutionKind: null, resolutionNote: 'خصم أعطاه الموظف' }),
      mk(3, { resolution: 'ACCEPTED_COURIER', resolutionNote: 'سطر من خادم أقدم' }),
    ]);
    render(<MatchingScreen queuesStartOpen />);
    await screen.findAllByText('حبة ناقصة بعتناها');
    // The screen draws every row twice — as a table row for the desk and as a card for the phone — so the counts are read against that.
    const drawn = screen.getAllByText('حبة ناقصة بعتناها').length;
    expect(drawn).toBeGreaterThan(0);
    expect(screen.getAllByText('طلب تبديل')).toHaveLength(drawn);
    expect(screen.getAllByText('اعتُمد رقم الشركة')).toHaveLength(2 * drawn);
  });

  it('offers the button on every unanswered difference, wherever «رقمنا» is offered — and none once the statement is closed', async () => {
    serve([mk(1), mk(2)]);
    const { unmount } = render(<MatchingScreen queuesStartOpen />);
    await screen.findAllByText('فرق في المبلغ');
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'طلب تبديل' }).length).toBeGreaterThanOrEqual(2));
    // One beside every «رقمنا هو المعتمد» — never fewer, never more.
    expect(screen.getAllByRole('button', { name: 'طلب تبديل' })).toHaveLength(screen.getAllByRole('button', { name: 'رقمنا هو المعتمد' }).length);
    unmount();

    serve([mk(1), mk(2)], '2026-10-29T10:00:00Z');
    render(<MatchingScreen queuesStartOpen />);
    await screen.findAllByText('فرق في المبلغ');
    expect(screen.queryByRole('button', { name: 'طلب تبديل' })).toBeNull();
  });

  it('a press on the row sends the exchange for THAT row, then reads the statement again', async () => {
    serve([mk(7)]);
    render(<MatchingScreen queuesStartOpen />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'طلب تبديل' }).length).toBeGreaterThan(0));
    fireEvent.change(screen.getAllByLabelText('تفسير القرار')[0], { target: { value: 'تبديل حبة ناقصة' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'طلب تبديل' })[0]);
    await waitFor(() => expect(api.mock.calls.some((c) => String(c[0]).endsWith('/resolve'))).toBe(true));
    const call = api.mock.calls.find((c) => String(c[0]).endsWith('/resolve'))!;
    expect(call[0]).toBe('/api/finance/statements/s1/matches/d7/resolve');
    expect(JSON.parse((call[1] as { body: string }).body)).toEqual({ resolution: 'ACCEPTED_COURIER', exchange: true, note: 'تبديل حبة ناقصة' });
    // …and the statement is read again, so the chip is the saved one.
    await waitFor(() => expect(api.mock.calls.filter((c) => c[0] === '/api/finance/statements/s1').length).toBeGreaterThan(1));
  });
});

describe('it is NOT in the bulk answer', () => {
  const rows = [
    { id: 'a', wordGroup: 'K', word: 'مؤجلة', answered: false },
    { id: 'b', wordGroup: 'K', word: 'مؤجلة', answered: false },
  ];

  it('the bulk press offers the courier’s figure, ours and «قيد المراجعة» — and no exchange', () => {
    render(<BulkDecide statementId="s1" onDone={vi.fn()} rows={rows} />);
    const options = [...(screen.getAllByRole('combobox')[1] as HTMLSelectElement).options].map((o) => o.textContent);
    expect(options).toEqual(['اعتُمد رقم الشركة', 'رقمنا هو المعتمد', 'قيد المراجعة']);
    expect(screen.queryByText('طلب تبديل')).toBeNull();
  });

  it('and what it sends has no `exchange` in it', async () => {
    render(<BulkDecide statementId="s1" onDone={vi.fn()} rows={rows} />);
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'ACCEPTED_COURIER' } });
    fireEvent.change(screen.getByPlaceholderText(SENTENCE), { target: { value: 'خصم متفق عليه' } });
    fireEvent.click(screen.getByRole('button', { name: 'بتّ الأسطر' }));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    expect(Object.keys(bodyOf())).toEqual(['matchIds', 'resolution', 'note']);
  });

  it('the list of answers the bulk press is built from is still the two figures — the exchange never joined it', () => {
    expect([...RESOLUTIONS]).toEqual(['ACCEPTED_COURIER', 'OURS_STANDS']);
    expect(readFileSync(join(process.cwd(), 'src/components/screens/finance/BulkDecide.tsx'), 'utf8')).not.toMatch(/EXCHANGE|طلب تبديل/);
  });
});

describe('the dialog «من يتحمّل الفرق؟» — drawn from what the approval really says — never lists an exchange', () => {
  // The stop is raised by the REAL `proposeShortfalls` (no door person for either parcel), and its lines are handed to the REAL dialog.
  const SCOPE = {
    companyId: 'c1', storeId: 's1', approverId: 'u-approver',
    statement: { id: 'st1', reference: 'ST-1', currencyCode: 'USD', importedAt: new Date('2026-10-20T10:00:00Z') },
    fallbackDeliveredAt: new Date('2026-10-19T00:00:00Z'), minorUnit: 2,
  };
  const SCREENSHOT = { expectedAmount: 17, expectedFee: 3, statementAmount: -3, statementFee: 3 };
  const cand = (n: string, over: Record<string, unknown> = {}) => ({
    matchId: `m-${n}`, orderId: `o-${n}`, orderNumber: `ORD-${n}`, ...SCREENSHOT, explanation: 'شرح كافٍ للبتّ', ...over,
  });
  const tx = () => ({
    order: { findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({ id, shippingStatus: 'DELIVERED', deliveredAt: new Date('2026-10-18T09:00:00Z'), moderatorId: 'u-mod', confirmedById: 'u-conf' }))) },
    deliveryAttempt: { findMany: vi.fn(async () => []) },
    // Two reads of users: the ones the door and the approver named (`id: { in }` — none here), and the list of people who may carry a line
    // (`id: { not: approver }`), which is what the dialog offers.
    user: {
      findMany: vi.fn(async (a: { where: { id?: { in?: string[]; not?: string } } }) =>
        a.where.id?.in ? [] : [{ id: 'u-sara', name: 'سارة', role: 'FOLLOW_UP_AGENT' }, { id: 'u-mona', name: 'منى', role: 'FOLLOW_UP_AGENT' }]
      ),
    },
    penalty: { findMany: vi.fn(async () => []), create: vi.fn() },
    orderActivity: { create: vi.fn() },
  });

  it('one exchange and one plain short line: the dialog has ONE box, for the plain line — and its «اعتمد» needs just that one answer', async () => {
    const { proposeShortfalls } = await import('@/lib/shortfall');
    const { ShortfallPeopleDialog } = await import('./ShortfallPeopleDialog');
    const { stop } = await proposeShortfalls(tx() as never, SCOPE, [cand('EXCH', { exchange: true }), cand('PLAIN')]);
    expect(stop).toMatchObject({ code: 'SHORTFALL_UNNAMED' });
    if (!stop || stop.code !== 'SHORTFALL_UNNAMED') throw new Error('the approval did not stop for a name');
    const onConfirm = vi.fn();
    render(<ShortfallPeopleDialog sentence="سطور مقبولة برقم الشركة وهو أقل من رقمنا" lines={stop.lines} candidates={stop.candidates} busy={false} onClose={vi.fn()} onConfirm={onConfirm} />);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getAllByRole('combobox')).toHaveLength(1);
    expect(within(dialog).getByText(/ORD-PLAIN — الفرق/)).toBeTruthy();
    expect(within(dialog).queryByText(/ORD-EXCH/)).toBeNull();
    const go = within(dialog).getByRole('button', { name: 'اعتمد' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'u-sara' } });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    // The answer carries the plain line's key only: nobody names a person for the exchange.
    expect(onConfirm).toHaveBeenCalledWith({ 'm-PLAIN': 'u-sara' });
  });

  it('an approval with only exchanges raises no stop at all — there is no dialog to draw', async () => {
    const { proposeShortfalls } = await import('@/lib/shortfall');
    const r = await proposeShortfalls(tx() as never, SCOPE, [cand('E1', { exchange: true }), cand('E2', { exchange: true })]);
    expect(r).toEqual({ charges: [], onCompany: [], stop: null });
  });
});

describe('the per-person card says the exchanges apart — and they are in none of its discount numbers', () => {
  const payload = (over: Record<string, unknown>) => ({
    people: [{
      personId: 'p1', name: 'سارة', role: 'CONFIRMATION_AGENT', differences: 2, accepted: 1, open: 1, acceptedValue: 2, settledOrders: 30, rate: 0.07,
      why: '2 فرقاً على 30 طلباً وصلت كشفاً', ...over,
    }],
    minSettledOrders: 20, unattributed: { settledOrders: 0, differences: 0 },
  });
  const drawCard = async (over: Record<string, unknown>) => {
    const { DifferencesByPerson: Real } = await vi.importActual<typeof import('@/components/screens/finance/DifferencesByPerson')>(
      '@/components/screens/finance/DifferencesByPerson'
    );
    api.mockResolvedValue(payload(over));
    return render(<Real currency="USD" open />);
  };

  it('«طلب تبديل N» appears beside the person when there are exchanges, with the words that say it is no discount', async () => {
    await drawCard({ exchanges: 3 });
    expect(await screen.findByText('طلب تبديل 3 — لا يُحسب خصماً')).toBeTruthy();
    // The discount numbers are the ones the query sent — untouched by the exchanges.
    expect(screen.getByText('2 فرقاً · اعتُمد رقم الشركة في 1 · بانتظار البتّ 1')).toBeTruthy();
  });

  it('nothing is said when there are none — zero, or an older server that sends no such number', async () => {
    for (const over of [{ exchanges: 0 }, {}]) {
      const { unmount } = await drawCard(over);
      await screen.findByText('سارة');
      expect(screen.queryByText(/طلب تبديل/), JSON.stringify(over)).toBeNull();
      unmount();
    }
  });

  it('a person with only exchanges reads no difference and no discount, and their exchanges', async () => {
    await drawCard({ differences: 0, accepted: 0, open: 0, acceptedValue: 0, rate: 0, exchanges: 5, why: '0 فرقاً على 30 طلباً وصلت كشفاً' });
    expect(await screen.findByText('طلب تبديل 5 — لا يُحسب خصماً')).toBeTruthy();
    expect(screen.getByText('0 فرقاً · اعتُمد رقم الشركة في 0 · بانتظار البتّ 0')).toBeTruthy();
  });
});

describe('NO NEW CSS — every class the touched components use is one the product already ships', () => {
  /*
   * The dashboard's first-load stylesheet is under a ratchet (`quality-gates.test.ts`, measured only on CI's build): a class nobody else
   * ships grows it. The new button, the hint line and the exchange count are written from classes the siblings already wear; this holds
   * both touched components to that — the static `className="…"` strings AND the template-literal ones.
   */
  const root = join(process.cwd(), 'src');
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx|ts)$/.test(name) && !/\.test\./.test(name)) files.push(p);
    }
  })(root);
  const staticClasses = (src: string) => [...src.matchAll(/className="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/).filter(Boolean));
  // The static strings, and the text of a template literal outside its holes.
  const allClasses = (src: string) => {
    const out = [...staticClasses(src)];
    for (const m of src.matchAll(/className=\{`([^`]*)`\}/g)) out.push(...m[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).filter(Boolean));
    return out;
  };
  // What the component ALREADY wore before this work, inside the holes of its template literals — the accepted/ours buttons' ternary
  // branches. Tailwind generates those from this very file, so a token reused from there adds nothing to the stylesheet.
  const holeTokens = (src: string) =>
    [...src.matchAll(/className=\{`([^`]*)`\}/g)].flatMap((m) => [...m[1].matchAll(/'([^']*)'/g)].flatMap((q) => q[1].split(/\s+/).filter(Boolean)));

  it.each([
    'components/screens/finance/DifferenceActions.tsx',
    'components/screens/finance/DifferencesByPerson.tsx',
  ])('`%s`: every class appears in another source file (or is one this component already wore in its own ternaries)', (rel) => {
    const own = join(root, rel);
    const ownSrc = readFileSync(own, 'utf8');
    const used = new Set(allClasses(ownSrc));
    expect(used.size, 'the component has classes').toBeGreaterThan(10);
    const elsewhere = new Set([
      ...files.filter((f) => f !== own).flatMap((f) => staticClasses(readFileSync(f, 'utf8'))),
      ...holeTokens(ownSrc),
    ]);
    const brandNew = [...used].filter((c) => !elsewhere.has(c));
    expect(brandNew, `classes nobody else ships: ${brandNew.join(' ')}`).toEqual([]);
  });

  it('the new button’s class string is its sibling «قيد المراجعة»’s, with the courier’s figure’s own hover colour — and every token of it is shipped elsewhere', () => {
    const src = readFileSync(join(root, 'components/screens/finance/DifferenceActions.tsx'), 'utf8').replace(/\r\n/g, '\n');
    // The opening tag of the <button> whose label is the exchange’s, read as text.
    const label = src.indexOf('{EXCHANGE_AR}\n        </button>');
    expect(label, 'the exchange button is in the source').toBeGreaterThan(0);
    const tag = src.slice(src.lastIndexOf('<button', label), label);
    const mine = /className="([^"]+)"/.exec(tag)![1].split(/\s+/);
    // «قيد المراجعة»’s opening tag: the one whose label is {PARKED_AR}.
    const parkedLabel = src.indexOf('{PARKED_AR}\n      </button>');
    expect(parkedLabel, 'the parking button is in the source').toBeGreaterThan(0);
    const parkedTag = src.slice(src.lastIndexOf('<button', parkedLabel), parkedLabel);
    const parked = /className="([^"]+)"/.exec(parkedTag)![1].split(/\s+/);
    // Everything but the two hover tokens (success instead of warning — the colour their figure already has on the desk).
    expect(mine.filter((c) => !parked.includes(c))).toEqual(['hover:border-[var(--sys-success)]', 'hover:text-[var(--sys-success)]']);
    expect(parked.filter((c) => !mine.includes(c))).toEqual(['hover:border-[var(--sys-warning)]', 'hover:text-[var(--sys-warning)]']);
    // Every token is one the product already ships — in another file's static string, or in this component's own accepted button (which
    // wears the two hover tokens on the desk): nothing here is new to the stylesheet.
    const elsewhere = new Set([
      ...files.filter((f) => !f.endsWith('DifferenceActions.tsx')).flatMap((f) => staticClasses(readFileSync(f, 'utf8'))),
      ...holeTokens(src),
    ]);
    for (const c of mine) expect(elsewhere.has(c), c).toBe(true);
    // …and the two hover tokens are worn by the accepted button before this work (they are in its ternary), so they are not new either.
    expect(holeTokens(src)).toEqual(expect.arrayContaining(['hover:border-[var(--sys-success)]', 'hover:text-[var(--sys-success)]']));
  });
});
