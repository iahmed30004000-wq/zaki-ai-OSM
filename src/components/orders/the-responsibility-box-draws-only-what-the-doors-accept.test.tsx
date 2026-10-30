// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE BOX DRAWS WHAT THE DOORS ACCEPT — AND LOSES NOTHING THAT WORKED.
 *
 * «سحبه منه» on another person's order is drawn only for who holds BOTH
 * `orders.unlock` and `orders.release` (the door asks both). «استلمه أنا» is
 * drawn for `orders.unlock`. «تحويل لزميل» follows the transfer door's own
 * answer (`mayTransfer`) and nothing else — a reassigner without the unlock
 * key keeps it. On the order the person holds, nothing moved.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, useApp } = vi.hoisted(() => ({ apiJson: vi.fn(), useApp: vi.fn() }));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('@/context/AppContext', () => ({ useApp: () => useApp() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), success: vi.fn() }) }));

import { OrderResponsibility } from './OrderResponsibility';

const agentsOrder = {
  id: 'o1', claimedById: 'agent1', claimedAt: null,
  claimer: { id: 'agent1', name: 'عبير' }, owner: null,
};

const as = (id: string, permissions: string[], mayTransfer: boolean) => {
  useApp.mockReturnValue({ currentUser: { id, role: 'X', status: 'ACTIVE', permissions } });
  apiJson.mockResolvedValue({ mayTransfer, candidates: [{ id: 'a2', name: 'سارة' }] });
};

const show = async (order = agentsOrder, me = 'x1') => {
  render(<OrderResponsibility order={order} currentUserId={me} onChanged={() => {}} />);
  await waitFor(() => expect(apiJson).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('on an order somebody else holds', () => {
  it('the owner (unlock + release) sees pull back, take, and transfer', async () => {
    as('x1', ['orders.unlock', 'orders.release'], true);
    await show();
    expect(screen.queryByText('سحبه منه')).not.toBeNull();
    expect(screen.queryByText('استلمه أنا')).not.toBeNull();
    expect(screen.queryByText('تحويل لزميل')).not.toBeNull();
  });

  it('a reassigner without the unlock key keeps «تحويل لزميل» and is not shown the other two', async () => {
    as('x1', ['orders.release'], true);
    await show();
    expect(screen.queryByText('تحويل لزميل')).not.toBeNull();
    expect(screen.queryByText('سحبه منه')).toBeNull();
    expect(screen.queryByText('استلمه أنا')).toBeNull();
  });

  it('unlock without release may take it but is not drawn a pull-back the door would refuse', async () => {
    as('x1', ['orders.unlock'], false);
    await show();
    expect(screen.queryByText('استلمه أنا')).not.toBeNull();
    expect(screen.queryByText('سحبه منه')).toBeNull();
  });

  it('an agent with neither is drawn no button at all', async () => {
    as('x1', ['orders.release'], false);
    await show();
    expect(screen.queryByText('سحبه منه')).toBeNull();
    expect(screen.queryByText('استلمه أنا')).toBeNull();
    expect(screen.queryByText('تحويل لزميل')).toBeNull();
  });
});

describe('on the order the person holds', () => {
  it('nothing moved: give it back and hand it to a colleague, no «take»', async () => {
    as('agent1', ['orders.release'], true);
    await show(agentsOrder, 'agent1');
    expect(screen.queryByText('سحبه منه')).not.toBeNull();
    expect(screen.queryByText('تحويل لزميل')).not.toBeNull();
    expect(screen.queryByText('استلمه أنا')).toBeNull();
  });
});
