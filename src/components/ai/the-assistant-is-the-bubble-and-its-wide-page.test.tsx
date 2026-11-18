// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { attachGrants, can } from '@/lib/authorization';
import { ALL_ROUTES, canAccessRoute, findRoute, menuNav, visibleNav } from '@/lib/route-registry';

/**
 * «المساعد الذكي» — THE BUBBLE IS THE ASSISTANT; THE PAGE IS ITS «افتح كاملاً».
 *
 * A menu line and a bubble on every screen opened the same chat (the page says so
 * itself). The owner (24/10) hid the menu line and kept the bubble. What had to
 * stay true, because hiding a line must never lose the way in:
 *
 *   · `/assistant` is still a route — same path, permission (`ai.use`) and guard —
 *     and still openable; only the MENU leaves it out, for everybody;
 *   · the open bubble carries a link to it, so the wide page is one click away;
 *   · nothing else was taken out of the menu by this.
 */

vi.mock('next/navigation', () => ({ usePathname: () => '/customers' }));

import { AiDock } from './AiDock';
import { BulkProvider } from '@/components/shell/BulkBar';

const userWith = (keys: string[]) =>
  attachGrants({ id: 'u1', role: 'MODERATOR', status: 'ACTIVE', permissions: keys } as any, {
    fullAccess: false,
    grants: Object.fromEntries(keys.map((k) => [k, { scope: 'ALL_COMPANY' }])),
  });
const pathsOf = (groups: ReturnType<typeof menuNav>) => groups.flatMap((g) => g.routes.map((r) => r.path));

// jsdom has no scrollIntoView; the open panel scrolls its last message into view
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});
afterEach(cleanup);

describe('the menu', () => {
  it('has no «المساعد الذكي» line for somebody who may use it — the route stays openable', () => {
    const user = userWith(['ai.use', 'growth.intelligence']);
    expect(pathsOf(menuNav(user, can))).not.toContain('/assistant');
    expect(pathsOf(visibleNav(user, can))).toContain('/assistant');
    expect(canAccessRoute(user, findRoute('/assistant')!, can)).toBe(true);
    // the group keeps the rest of what is in it
    expect(pathsOf(menuNav(user, can))).toContain('/growth/intelligence');
  });

  it('hides exactly that one line for being a bubble — «offMenu» is nobody else’s but the profile’s', () => {
    // 18/11 (R6): was ['/assistant'] alone. «الملف الشخصي» is off the menu too — everybody's own page, whose door is the name in
    // the header and a line of the phone's «المزيد» (`the-profile-has-a-door-for-everyone.test.tsx`). Still exactly these, by name.
    expect(ALL_ROUTES.filter((r) => r.offMenu).map((r) => r.path)).toEqual(['/assistant', '/admin/profile']);
  });

  it('and the route still asks the permission it always asked', () => {
    expect(findRoute('/assistant')?.permissions).toEqual(['ai.use']);
    expect(canAccessRoute(userWith(['orders.view']), findRoute('/assistant')!, can)).toBe(false);
  });
});

describe('the bubble', () => {
  it('opens with «افتح كاملاً», which goes to the wide page', async () => {
    render(
      <BulkProvider>
        <AiDock />
      </BulkProvider>
    );
    expect(screen.queryByRole('link', { name: 'افتح كاملاً' })).toBeNull();
    await act(async () => {
      screen.getByRole('button', { name: 'افتح المساعد الذكي' }).click();
    });
    expect(screen.getByRole('link', { name: 'افتح كاملاً' }).getAttribute('href')).toBe('/assistant');
  });
});
