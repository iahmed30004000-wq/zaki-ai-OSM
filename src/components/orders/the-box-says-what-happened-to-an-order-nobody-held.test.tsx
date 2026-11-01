// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «لم يستلمه أحد بعد — متاح في الطابور» IS TRUE ONLY OF AN ORDER STILL WAITING (the owner, 1/11)
 *
 * ORD-2026-1896 was confirmed with nobody holding it, and this box read «متاح في الطابور» beside a confirmed status — an order that is
 * no longer in any queue. The box says what happened instead, and keeps the old words for the order that really is waiting.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, useApp } = vi.hoisted(() => ({ apiJson: vi.fn(), useApp: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('@/context/AppContext', () => ({ useApp: () => useApp() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), success: vi.fn() }) }));

import { OrderResponsibility } from './OrderResponsibility';

const nobody = { id: 'o1', claimedById: null, claimedAt: null, claimer: null, owner: null };

const show = async (order: Record<string, unknown>) => {
  useApp.mockReturnValue({ currentUser: { id: 'x1', role: 'X', status: 'ACTIVE', permissions: [] } });
  apiJson.mockResolvedValue({ mayTransfer: false, candidates: [] });
  render(<OrderResponsibility order={{ ...nobody, ...order }} currentUserId="x1" onChanged={() => {}} />);
  await waitFor(() => expect(apiJson).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 0));
};
const text = () => document.body.textContent ?? '';

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('an order nobody holds', () => {
  it('still WAITING: the old words — «لم يستلمه أحد بعد — متاح في الطابور»', async () => {
    for (const confirmationStatus of ['NEW', 'IN_PROGRESS', 'NO_ANSWER', 'FOLLOW_UP_REQUIRED', 'POSTPONED']) {
      cleanup();
      await show({ confirmationStatus });
      expect(text(), confirmationStatus).toContain('لم يستلمه أحد بعد');
      expect(text(), confirmationStatus).toContain('متاح في الطابور');
    }
  });

  it('a status the screen was not told about: the old words too (nothing is claimed that was not said)', async () => {
    await show({});
    expect(text()).toContain('متاح في الطابور');
  });

  it('CONFIRMED with nobody holding it — ORD-2026-1896: says so, and who gave the yes; never «متاح في الطابور»', async () => {
    await show({ confirmationStatus: 'CONFIRMED', confirmer: { id: 'u9', name: 'عبير' } });
    expect(text()).toContain('انأكّد من غير ما حدا يستلمه');
    expect(text()).toContain('أكّده عبير');
    expect(text(), 'قال إنو الطلب متاح بالطابور وهو مؤكَّد').not.toContain('متاح في الطابور');
    expect(text()).not.toContain('لم يستلمه أحد بعد');
  });

  it('CONFIRMED and the confirmer is unknown (an old import): still no «متاح في الطابور», and no invented name', async () => {
    await show({ confirmationStatus: 'CONFIRMED', confirmer: null });
    expect(text()).toContain('انأكّد من غير ما حدا يستلمه');
    expect(text()).not.toContain('أكّده');
    expect(text()).not.toContain('متاح في الطابور');
  });

  it('REJECTED or CANCELLED with nobody holding it: decided, not waiting — and it does not claim somebody confirmed it', async () => {
    for (const confirmationStatus of ['REJECTED', 'CANCELLED']) {
      cleanup();
      await show({ confirmationStatus, confirmer: { id: 'u9', name: 'عبير' } });
      expect(text(), confirmationStatus).toContain('انحسم من غير ما حدا يستلمه');
      expect(text(), confirmationStatus).not.toContain('أكّده');
      expect(text(), confirmationStatus).not.toContain('متاح في الطابور');
    }
  });
});

describe('what did not change', () => {
  it('an order somebody holds says whose hands it is in, whatever its status', async () => {
    await show({ confirmationStatus: 'CONFIRMED', claimedById: 'a1', claimer: { id: 'a1', name: 'ليلى' } });
    expect(text()).toContain('بين يدي');
    expect(text()).toContain('ليلى');
    expect(text()).not.toContain('من غير ما حدا يستلمه');
  });

  it('an order held back for a colleague (the hold) keeps its sentence', async () => {
    await show({ confirmationStatus: 'NEW', reservedFor: { id: 'a2', name: 'سارة', hoursLeft: 5 } });
    expect(text()).toContain('تابع لـسارة');
    expect(text()).not.toContain('متاح في الطابور');
  });
});
