// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «قاعدة جديدة» AND «إنهاء العمل بها» ASK commission.manage (perm-plan PR-4).
 *
 * The page opens on commission.view; writing a rule decides what people are paid, and the server asks
 * commission.manage (it asked settings.edit before). So the two buttons are drawn for that key and no other:
 * not for the person who can only read, and not for the person who holds the old key alone.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { app, api } = vi.hoisted(() => ({
  app: { value: {} as Record<string, unknown> },
  api: { answers: {} as Record<string, unknown> },
}));

vi.mock('@/context/AppContext', () => ({ useApp: () => app.value }));
vi.mock('@/lib/api-client', () => ({
  apiJson: async (url: string) => {
    const hit = Object.keys(api.answers).find((p) => url === p || url.startsWith(`${p}?`));
    if (!hit) throw new Error(`unexpected request ${url}`);
    return api.answers[hit];
  },
}));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>العمولات</h1> }));
vi.mock('@/components/screens/commission/PeriodProgress', () => ({ PeriodProgress: () => null }));
vi.mock('@/components/screens/commission/FairnessPanel', () => ({ FairnessPanel: () => null }));
vi.mock('@/components/screens/commission/PayoutDialog', () => ({ PayoutDialog: () => null }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => unknown) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, []);
  },
}));

import { CommissionSettingsScreen } from './CommissionSettingsScreen';

const RULE = {
  id: 'r1', name: 'قاعدة الشهر', appliesToRole: 'MODERATOR', appliesToUserId: null, appliesToUserName: null,
  type: 'PER_ORDER', value: 2, metric: 'DELIVERED_ORDERS', period: 'PER_ORDER', tiers: null, minOrders: null,
  effectiveFrom: '2026-10-01', effectiveTo: null, isActive: true, inForce: true,
};

function signedIn(permissions: string[]) {
  app.value = { locale: 'ar', isRtl: true, t: {}, currentUser: { id: 'u0', name: 'موظف', role: 'MODERATOR', status: 'ACTIVE', permissions } };
}

beforeEach(() => {
  api.answers = {
    '/api/settings/commission': { rules: [RULE], noRuleInForce: false },
    '/api/finance/commission': { totals: [], currencyCode: 'USD', fairness: null },
  };
});
afterEach(cleanup);

async function drawn(permissions: string[]) {
  signedIn(permissions);
  render(<CommissionSettingsScreen />);
  // the rows are drawn twice (a table for wide screens, cards for narrow ones)
  await screen.findAllByText('قاعدة الشهر');
  const out = { add: screen.queryAllByText('قاعدة جديدة').length > 0, end: screen.queryAllByText('إنهاء العمل بها').length > 0 };
  cleanup();
  return out;
}

describe('the two write buttons', () => {
  it('are drawn for commission.manage', async () => {
    expect(await drawn(['commission.view', 'commission.manage'])).toEqual({ add: true, end: true });
  });

  it('NEGATIVE: not for somebody who can only read the page', async () => {
    expect(await drawn(['commission.view'])).toEqual({ add: false, end: false });
  });

  it('NEGATIVE: not for somebody holding the key the door asked BEFORE (settings.edit), or the sensitive one', async () => {
    expect(await drawn(['commission.view', 'settings.view', 'settings.edit', 'settings.manage'])).toEqual({ add: false, end: false });
  });
});
