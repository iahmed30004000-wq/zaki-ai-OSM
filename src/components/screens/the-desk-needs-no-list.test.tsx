// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «الصلاحيات» SAYS THAT «طلباتي» NEEDS NO LIST — AND WHEN A PULL HAS NO DESK.
 *
 * «كموظف تأكيد ماتقدر تسحب او تعدل على طلب الا اذا كانت ظاهرة عندك كل
 * الطلبات اللي بالموقع..»
 *
 * The owner ticked «عرض الطلبات» — which both editors default to «كل
 * الشركة» — because it was the only way an agent could work the order she
 * had pulled. It is not any more (order-work-door.ts), so the screen says so
 * beside the tick that used to be the only way.
 *
 * And the other half: `confirmation.pull` without `confirmation.work` takes
 * an order into hands that cannot see it or work it. Nothing refuses that —
 * the screen says what it will do, as it already does for a role that works
 * the queue and cannot record a call.
 * ═══════════════════════════════════════════════════════════════════════
 */

vi.mock('next/navigation', () => ({ usePathname: () => '/admin/permissions', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn() }) }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => true), useTell: () => vi.fn() }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({
    locale: 'ar',
    t: {},
    currentUser: { id: 'u0', role: 'SUPER_ADMIN', permissions: [], status: 'ACTIVE' },
  }),
}));

import { PermissionsScreen } from './PermissionsScreen';

const NO_LIST = /«طلباتي» بتشتغل بلا «عرض الطلبات»/;
const NO_DESK = /ما رح تظهر على مكتبه/;
const FIX = /فعّل «العمل على طلباتي والمؤجلة»/;
const ROLE_NAME = 'موظّف تأكيد';

/** The roles list, as `/api/roles` answers it, holding exactly these keys. */
function roleHolding(...keys: string[]) {
  const role = {
    id: 'r1',
    name: ROLE_NAME,
    usersCount: 2,
    isSystem: false,
    permissions: keys.map((permission) => ({ permission, scope: 'ALL_COMPANY', scopeIds: [] })),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () => (String(url).includes('/default') ? { available: false } : { roles: [role] }),
    }))
  );
}

async function openTheRole() {
  const user = userEvent.setup();
  await waitFor(() => expect(screen.queryByText(ROLE_NAME)).not.toBeNull());
  await user.click(await screen.findByText('تعديل'));
  await waitFor(() => expect(screen.queryByText('الطلبات')).not.toBeNull());
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('a role that works «طلباتي»', () => {
  it('is told it needs no «عرض الطلبات» to work the order in its hands', async () => {
    roleHolding('confirmation.work', 'confirmation.pull', 'orders.contact_log', 'orders.confirm');
    render(<PermissionsScreen />);
    await openTheRole();
    expect(screen.queryByText(NO_LIST), 'ما قال إنّ «طلباتي» بتشتغل بلا القائمة').not.toBeNull();
    expect(screen.queryByText(NO_DESK), 'حذّر من سحب بلا مكتب والدور عنده مكتب').toBeNull();
  });
});

describe('a role that pulls with no desk to pull onto', () => {
  it('is warned, and told what to tick', async () => {
    roleHolding('confirmation.pull', 'orders.view');
    render(<PermissionsScreen />);
    await openTheRole();
    expect(screen.queryByText(NO_DESK), 'ما حذّر').not.toBeNull();
    expect(screen.queryByText(FIX), 'قال المشكلة وما قال الحلّ').not.toBeNull();
    // It does not work «طلباتي», so the line about «طلباتي» is not its line.
    expect(screen.queryByText(NO_LIST)).toBeNull();
  });
});

describe('NEGATIVE: a role that has nothing to do with the queue', () => {
  it('hears neither', async () => {
    roleHolding('orders.view', 'reports.export');
    render(<PermissionsScreen />);
    await openTheRole();
    expect(screen.queryByText(NO_LIST)).toBeNull();
    expect(screen.queryByText(NO_DESK)).toBeNull();
  });
});
