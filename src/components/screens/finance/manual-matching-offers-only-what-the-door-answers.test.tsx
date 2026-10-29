// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * «المطابقة اليدوية» READS THE FOLLOW-UP DOOR, SO IT OFFERS ONLY WHAT THAT DOOR WOULD ANSWER.
 *
 * The door refuses the delivered states and the «بانتظار التحصيل» view to whoever does not see the courier's money, and
 * the return states to whoever does not see the return rows (`who-sees-which-rows.test.ts`). This screen's lists used to
 * offer all of them; a person who chose one met a 403. Now the lists follow `access`, which the door sends.
 */

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/finance/matching',
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', status: 'ACTIVE', role: 'MANAGER', permissions: ['ops.track'] } }),
}));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => async () => true, useAsk: () => async () => null }));
vi.mock('@/components/screens/tracking/CollectDialog', () => ({ CollectDialog: () => null }));

import { ManualMatching } from './ManualMatching';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const row = {
  id: 'id-M1',
  orderNumber: 'ORD-M1',
  merchantRef: 'M1',
  trackingNumber: 'TRK-M1',
  shippingStatus: 'SHIPPED',
  daysInTransit: 1,
  late: false,
  totalAmount: 40,
  currency: 'JOD',
  customer: { fullName: 'زبون', phone: '0790000000', city: 'عمّان' },
  deliveryProvider: { id: A, name: 'أبو علي', kind: 'AGENT' },
  alert: null,
};

let access: Record<string, boolean> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  access = undefined;
  api.mockImplementation(async (url: string) => {
    const u = new URL(url, 'http://x');
    if (u.pathname === '/api/products') return { products: [] };
    return {
      orders: [row],
      pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
      facts: {
        total: 1,
        tasks: { CANCELLED: 0, CHANGED: 0, FAILED: 0, RETURNING: 0, LATE: 0, NO_BARCODE: 0, COLLECT: 0 },
        lateCount: 0,
        couriers: [{ id: A, name: 'أبو علي', count: 1 }],
        regions: [],
        ages: { fresh: 0, few: 0, week: 0, old: 0 },
      },
      ...(access ? { access } : {}),
    };
  });
});
afterEach(() => cleanup());

const draw = async () => {
  render(<ManualMatching />);
  await screen.findByLabelText('جهة الشحن');
  await waitFor(() => expect(document.querySelector('tbody tr')).not.toBeNull());
};
const offered = (label: string) => within(screen.getByLabelText(label)).getAllByRole('option').map((o) => o.textContent);

describe('the lists', () => {
  it('NEGATIVE: without the money level there is no delivered state and no «المسلَّم بانتظار التحصيل فقط» view; without the returns level, no return state', async () => {
    access = { money: false, returns: false, collect: false };
    await draw();
    const states = offered('الحالة');
    for (const s of ['مسلَّم', 'مسلَّم جزئياً', 'طلب إرجاع']) expect(states, s).not.toContain(s);
    expect(states).toContain('مشحون');
    expect(offered('ما أعرضه')).toEqual(['كل ما عند الجهة']);
  });

  it('with the money level the delivered states and the view come back — the return state still waits for its own key', async () => {
    access = { money: true, returns: false, collect: false };
    await draw();
    expect(offered('الحالة')).toEqual(expect.arrayContaining(['مسلَّم', 'مسلَّم جزئياً']));
    expect(offered('الحالة')).not.toContain('طلب إرجاع');
    expect(offered('ما أعرضه')).toContain('المسلَّم بانتظار التحصيل فقط');
  });

  it('with both levels it offers everything it always did, and an answer that does not say is read the same way', async () => {
    for (const given of [{ money: true, returns: true, collect: true }, undefined]) {
      cleanup();
      access = given;
      await draw();
      expect(offered('الحالة')).toEqual(expect.arrayContaining(['مسلَّم', 'مسلَّم جزئياً', 'طلب إرجاع']));
      expect(offered('ما أعرضه')).toContain('المسلَّم بانتظار التحصيل فقط');
    }
  });
});
