// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE ORDER WINDOW’S «تأكيد الطلب» SAYS THE GOVERNORATE FIRST (30/10).
 *
 * The owner: «المفروض ما يسمح لموظفة التأكيد تأكّد غير لما تحدد المحافظة». The window records a contact attempt BEFORE it
 * asks the door to confirm, so a refusal after the press would leave a call in the log for a confirmation that never
 * happened. It says the sentence when the form opens, and shuts the send button.
 *
 * DEFINITION OF DONE: an order with `regionId` null / '' ⇒ the form shows the door’s own sentence and its «تأكيد» is shut,
 * nothing is sent; an order with one ⇒ no sentence, the button is open and the two requests go out (NEGATIVE); an order
 * object that does not carry the field at all is not guessed about.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { ConfirmationActions } from './ConfirmationActions';
import { REGION_REQUIRED_MESSAGE } from '@/lib/confirmation-queue';

const base = { id: 'o-1', orderNumber: 'ORD-1', confirmationStatus: 'IN_PROGRESS', version: 1 };
const reply = (body: unknown, ok = true) => ({ ok, json: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
  apiFetch.mockImplementation(async (url: string, init?: { method?: string }) =>
    init?.method === 'POST' ? reply({}) : reply({ attempts: [], summary: null })
  );
});
afterEach(cleanup);

const open = async (order: Record<string, unknown>) => {
  render(<ConfirmationActions order={order} ar isRtl onRefreshOrder={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'تأكيد الطلب' }));
  await screen.findByText(/سيتم تسجيل تأكيد العميل للطلب/);
};
const send = () => screen.getByRole('button', { name: 'تأكيد' }) as HTMLButtonElement;
const posts = () => apiFetch.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === 'POST');

describe('the confirm form of an order with no governorate', () => {
  it.each([
    ['null', null],
    ['an empty string', ''],
  ])('regionId %s: the door’s sentence is shown and «تأكيد» is shut — nothing is sent', async (_n, regionId) => {
    await open({ ...base, regionId });
    const line = screen.getByRole('alert').textContent ?? '';
    expect(line).toBe(REGION_REQUIRED_MESSAGE);
    expect(line).not.toMatch(/[A-Za-z]/);
    expect(send().disabled).toBe(true);
    fireEvent.click(send());
    expect(posts()).toEqual([]);
  });

  it('the other forms are not held back: «تأجيل» still asks only for its date', async () => {
    render(<ConfirmationActions order={{ ...base, regionId: null }} ar isRtl onRefreshOrder={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'تأجيل' }));
    await screen.findByText(/تحديد موعد المتابعة إلزامي/);
    expect(screen.queryByText(REGION_REQUIRED_MESSAGE)).toBeNull();
  });
});

describe('NEGATIVE: an order that has its governorate', () => {
  it('shows no sentence, the button is open, and the attempt and the confirmation both go out', async () => {
    await open({ ...base, regionId: 'r-dam' });
    expect(screen.queryByText(REGION_REQUIRED_MESSAGE)).toBeNull();
    expect(send().disabled).toBe(false);

    fireEvent.click(send());

    await waitFor(() => expect(posts().map((c) => String(c[0]))).toEqual(['/api/orders/o-1/contact-attempts', '/api/orders/o-1/confirmation']));
  });

  it('an order object without the field at all is not guessed about: the door decides', async () => {
    await open({ ...base });
    expect(screen.queryByText(REGION_REQUIRED_MESSAGE)).toBeNull();
    expect(send().disabled).toBe(false);
  });
});

describe('when the door refuses anyway', () => {
  it('its sentence is what the window shows after the recorded attempt', async () => {
    apiFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method !== 'POST') return reply({ attempts: [], summary: null });
      return String(url).endsWith('/confirmation')
        ? reply({ errorAr: REGION_REQUIRED_MESSAGE, code: 'REGION_REQUIRED' }, false)
        : reply({});
    });
    await open({ ...base });
    fireEvent.click(send());
    const line = await screen.findByText(/تم تسجيل محاولة الاتصال لكن فشل تحديث حالة الطلب/);
    expect(line.textContent).toContain(REGION_REQUIRED_MESSAGE);
  });
});
