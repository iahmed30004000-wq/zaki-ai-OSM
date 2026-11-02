// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE ORDER WINDOW ASKS, WHEN THE DOOR SAYS THE CUSTOMER ALREADY HAS A CONFIRMED TWIN (the owner, 2/11).
 *
 * «تأكيد الطلب» in the window records a contact attempt and then asks the confirmation door. When the door answers 409
 * `TWIN_CONFIRMED` nothing was written: the window must not print a red error line and leave her at a dead end — it asks her, in the
 * one shared dialog, whether the order is the same one sent again («رفضه كمكرر») or a second one on purpose («طلب تاني فعلاً — أكّد»).
 *
 * DEFINITION OF DONE: the dialog opens on that 409 and on no other; the confirm form closes; each of the three buttons sends exactly
 * its body (reject as a duplicate at the version the window was drawn at / confirm with `acknowledgeTwin` and the note she typed /
 * nothing) and records NO second contact attempt; a stale version or a dead network is said in the window's own line; the window
 * refreshes after a decision; and the file never writes the acknowledgement itself — it comes from the one body builder.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { ConfirmationActions } from './ConfirmationActions';

const ORDER = { id: 'o-1', orderNumber: 'ORD-2026-1696', confirmationStatus: 'IN_PROGRESS', version: 7, regionId: 'r1' };
const TWIN_BODY = {
  error: 'الزبون عنده طلب مؤكَّد بنفس المنتج (ORD-2026-1711) — إذا هالطلب مكرر ارفضه كمكرر، وإذا طلب تاني فعلاً أكّده وانت متأكد',
  errorAr: 'الزبون عنده طلب مؤكَّد بنفس المنتج (ORD-2026-1711) — إذا هالطلب مكرر ارفضه كمكرر، وإذا طلب تاني فعلاً أكّده وانت متأكد',
  code: 'TWIN_CONFIRMED',
  twins: [{ orderNumber: 'ORD-2026-1711', confirmedAt: new Date(Date.now() - 12 * 60_000).toISOString(), confirmedByName: 'سارة' }],
};
const reply = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 409, json: async () => body });

const onRefreshOrder = vi.fn();
/** What the confirmation door answers to the NEXT call it gets (the first one is always the twin question). */
let answers: unknown[];

beforeEach(() => {
  vi.clearAllMocks();
  answers = [reply(TWIN_BODY, false)];
  apiFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (init?.method !== 'POST') return reply({ attempts: [], summary: null });
    if (String(url).endsWith('/contact-attempts')) return reply({});
    const next = answers.shift();
    return next ?? reply({});
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const posts = () =>
  apiFetch.mock.calls
    .filter((c) => (c[1] as { method?: string } | undefined)?.method === 'POST')
    .map((c) => ({ url: String(c[0]), body: JSON.parse(String((c[1] as { body: string }).body)) as Record<string, unknown> }));
const confirmations = () => posts().filter((p) => p.url.endsWith('/confirmation'));
const attempts = () => posts().filter((p) => p.url.endsWith('/contact-attempts'));

/** Draw the window, open «تأكيد الطلب», optionally type a note, press its «تأكيد» — and let the door answer. */
async function pressConfirm(note?: string, order: Record<string, unknown> = ORDER) {
  render(<ConfirmationActions order={order} ar isRtl onRefreshOrder={onRefreshOrder} />);
  fireEvent.click(await screen.findByRole('button', { name: 'تأكيد الطلب' }));
  await screen.findByText(/سيتم تسجيل تأكيد العميل للطلب/);
  if (note) fireEvent.change(screen.getByRole('textbox'), { target: { value: note } });
  fireEvent.click(screen.getByRole('button', { name: 'تأكيد' }));
}
/** The twin question — by its own name, because the confirm form is a dialog too and stays open after an ordinary refusal. */
const TITLE = 'الزبون عنده طلب مؤكَّد بنفس المنتج';
const dialog = () => screen.findByRole('dialog', { name: TITLE });
const twinDialogNow = () => screen.queryByRole('dialog', { name: TITLE });
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('when the door answers TWIN_CONFIRMED', () => {
  it('the dialog opens, lists the other order by number, colleague and time — and there is NO red error line', async () => {
    await pressConfirm();
    const d = await dialog();
    expect(d.textContent).toContain('ORD-2026-1711 — أكّده سارة قبل 12 د');
    expect(screen.queryByText(/فشل تحديث حالة الطلب/)).toBeNull();
    expect(screen.queryByText(/الزبون عنده طلب مؤكَّد بنفس المنتج \(/)).toBeNull();
  });

  it('the confirm form is closed (its work is done) and what was sent so far is one attempt and one confirmation, the second refused', async () => {
    await pressConfirm();
    await dialog();
    expect(screen.queryByText(/سيتم تسجيل تأكيد العميل للطلب/)).toBeNull();
    expect(attempts()).toHaveLength(1);
    expect(confirmations()).toEqual([{ url: '/api/orders/o-1/confirmation', body: expect.objectContaining({ action: 'confirm', expectedVersion: 7 }) }]);
    expect(confirmations()[0].body).not.toHaveProperty('acknowledgeTwin');
  });

  it('«رفضه كمكرر» sends the door’s own reject, with the reason that already exists, at the version the window was drawn at — and no second attempt', async () => {
    await pressConfirm();
    await dialog();
    answers.push(reply({ success: true }));
    fireEvent.click(button('رفضه كمكرر'));
    await waitFor(() => expect(confirmations()).toHaveLength(2));
    expect(confirmations()[1]).toEqual({
      url: '/api/orders/o-1/confirmation',
      body: { action: 'reject', rejectionReason: 'DUPLICATE_ORDER', expectedVersion: 7 },
    });
    expect(attempts()).toHaveLength(1);
    await waitFor(() => expect(onRefreshOrder).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('رُفض الطلب كمكرر')).toBeTruthy();
    expect(twinDialogNow()).toBeNull();
  });

  it('«طلب تاني فعلاً — أكّد» sends the confirm again with her word and the note she had typed — and no second attempt', async () => {
    await pressConfirm('الزبون أكد الطلبين بالهاتف');
    await dialog();
    answers.push(reply({ success: true }));
    fireEvent.click(button('طلب تاني فعلاً — أكّد'));
    await waitFor(() => expect(confirmations()).toHaveLength(2));
    expect(confirmations()[1].body).toEqual({
      action: 'confirm',
      acknowledgeTwin: true,
      expectedVersion: 7,
      note: 'الزبون أكد الطلبين بالهاتف',
    });
    expect(attempts()).toHaveLength(1);
    await waitFor(() => expect(onRefreshOrder).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('تم تأكيد الطلب')).toBeTruthy();
  });

  it('with no note typed the acknowledgement carries none', async () => {
    await pressConfirm();
    await dialog();
    answers.push(reply({ success: true }));
    fireEvent.click(button('طلب تاني فعلاً — أكّد'));
    await waitFor(() => expect(confirmations()).toHaveLength(2));
    expect(confirmations()[1].body).toEqual({ action: 'confirm', acknowledgeTwin: true, expectedVersion: 7 });
  });

  it('«رجوع» sends nothing: the dialog closes, the order is as it was, no line is drawn, nothing is refreshed', async () => {
    await pressConfirm();
    await dialog();
    fireEvent.click(button('رجوع'));
    expect(twinDialogNow()).toBeNull();
    expect(posts()).toHaveLength(2); // the attempt and the refused confirmation — nothing since
    expect(onRefreshOrder).not.toHaveBeenCalled();
    expect(screen.queryByText(/فشل|رُفض|تم تأكيد/)).toBeNull();
  });

  it('a stale version is said in the window’s own red line — the dialog is gone, the window is not refreshed under her, nothing is hidden', async () => {
    await pressConfirm();
    await dialog();
    const stale = 'عدّل هذا الطلبَ شخصٌ آخر قبلك — أعد تحميل الصفحة ثم احفظ';
    answers.push(reply({ error: stale, errorAr: 'تم تعديل هذا الطلب بواسطة مستخدم آخر.', code: 'VERSION_CONFLICT' }, false));
    fireEvent.click(button('رفضه كمكرر'));
    expect(await screen.findByText('تم تعديل هذا الطلب بواسطة مستخدم آخر.')).toBeTruthy();
    expect(twinDialogNow()).toBeNull();
    expect(onRefreshOrder).not.toHaveBeenCalled();
    // …and she can try again from the window: «تأكيد الطلب» is still there
    expect(screen.getByRole('button', { name: 'تأكيد الطلب' })).toBeTruthy();
  });

  it('a dead network is said too, in Arabic, and never an unhandled rejection', async () => {
    await pressConfirm();
    await dialog();
    apiFetch.mockImplementationOnce(async () => {
      throw new Error('انتهت مهلة الطلب. تحقق من الاتصال وحاول مجدداً.');
    });
    fireEvent.click(button('طلب تاني فعلاً — أكّد'));
    expect(await screen.findByText('انتهت مهلة الطلب. تحقق من الاتصال وحاول مجدداً.')).toBeTruthy();
    expect(twinDialogNow()).toBeNull();
  });

  it('the dialog goes away when the window moves to another order', async () => {
    const { rerender } = render(<ConfirmationActions order={ORDER} ar isRtl onRefreshOrder={onRefreshOrder} />);
    fireEvent.click(await screen.findByRole('button', { name: 'تأكيد الطلب' }));
    await screen.findByText(/سيتم تسجيل تأكيد العميل للطلب/);
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد' }));
    await dialog();
    rerender(<ConfirmationActions order={{ ...ORDER, id: 'o-2', orderNumber: 'ORD-2' }} ar isRtl onRefreshOrder={onRefreshOrder} />);
    await waitFor(() => expect(twinDialogNow()).toBeNull());
  });
});

describe('NEGATIVE: every other answer is still what it was', () => {
  it('another 409 (the governorate) is the red line it always was, with the attempt recorded — and no dialog', async () => {
    answers = [reply({ errorAr: 'حدّد المحافظة أولاً — أجرة التوصيل مبنية عليها ولا يُؤكَّد طلب بلا محافظة', code: 'REGION_REQUIRED' }, false)];
    await pressConfirm();
    const line = await screen.findByText(/تم تسجيل محاولة الاتصال لكن فشل تحديث حالة الطلب/);
    expect(line.textContent).toContain('حدّد المحافظة أولاً');
    expect(twinDialogNow()).toBeNull();
  });

  it('a TWIN_CONFIRMED-looking body without the code is not the dialog', async () => {
    answers = [reply({ errorAr: 'شي تاني', twins: TWIN_BODY.twins }, false)];
    await pressConfirm();
    await screen.findByText(/فشل تحديث حالة الطلب/);
    expect(twinDialogNow()).toBeNull();
  });

  it('an ordinary confirmation (no twin) closes the form and refreshes, as ever', async () => {
    answers = [reply({ success: true })];
    await pressConfirm();
    await waitFor(() => expect(onRefreshOrder).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('تم تسجيل الإجراء بنجاح')).toBeTruthy();
    expect(twinDialogNow()).toBeNull();
  });

  it('the other quick actions never open it: «لا يرد» is a contact result and nothing else', async () => {
    answers = [reply({ success: true })];
    render(<ConfirmationActions order={ORDER} ar isRtl onRefreshOrder={onRefreshOrder} />);
    fireEvent.click(await screen.findByRole('button', { name: 'لا يرد' }));
    await waitFor(() => expect(confirmations()).toHaveLength(1));
    expect(twinDialogNow()).toBeNull();
  });
});

describe('on a phone', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true, media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
    }));
  });

  it('the same question, the same three buttons, each 44px tall and the full width', async () => {
    await pressConfirm();
    const d = await dialog();
    expect(d.textContent).toContain('ORD-2026-1711');
    for (const name of ['رفضه كمكرر', 'طلب تاني فعلاً — أكّد', 'رجوع']) {
      expect(button(name).classList.contains('h-11'), name).toBe(true);
      expect(button(name).classList.contains('w-full'), name).toBe(true);
    }
    answers.push(reply({ success: true }));
    fireEvent.click(button('رفضه كمكرر'));
    await waitFor(() => expect(confirmations()).toHaveLength(2));
    expect(confirmations()[1].body).toMatchObject({ action: 'reject', rejectionReason: 'DUPLICATE_ORDER' });
  });
});

describe('the file', () => {
  const src = stripComments(readFileSync(join(process.cwd(), 'src/components/orders/ConfirmationActions.tsx'), 'utf8'));

  it('draws the shared dialog and gets the two bodies from the one builder — it never writes the acknowledgement itself', () => {
    expect(src).toContain("from '@/components/orders/TwinConfirmedDialog'");
    expect(src).toMatch(/<TwinConfirmedDialog\b/);
    expect(src).toContain('rejectAsDuplicateBody(order.version)');
    expect(src).toContain('confirmAnywayBody(order.version, held.note)');
    expect(src).not.toMatch(/acknowledgeTwin\s*:/);
    expect(src).not.toContain("rejectionReason: 'DUPLICATE_ORDER'");
  });

  it('reads the refusal with the shared parser, not with a code string of its own', () => {
    expect(src).toContain('twinsFromRefusal(confData)');
    expect(src).not.toContain("'TWIN_CONFIRMED'");
  });

  it('keeps its contact attempt first: the attempt is posted before the transition, and the dialog’s calls post no attempt', () => {
    const decide = src.slice(src.indexOf('const decideTwin'), src.indexOf('const wf ='));
    expect(decide).toContain('/confirmation');
    expect(decide).not.toContain('contact-attempts');
  });
});
