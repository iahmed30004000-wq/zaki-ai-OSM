// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «الصلاحيات» SAYS WHICH KEYS FREE THEIR HOLDER FROM «اسحبي الطلب أول» (request Q1b, 19/11).
 *
 * The lesson of 1/11: a key ticked on a role for another reason excused every agent of that role from the desk's first rule, and
 * nothing on the screen said so. Now, beside each key of `EXEMPTS_FROM_HOLD` (the lib's list — the rule's own keys, pinned to
 * `mustHoldToWork` by `desk-readiness.test.ts`), one sentence says it. Beside no other key — `confirmation.supervise` frees nobody.
 * A render of the real screen against a fake door (nothing behind the sign-in opens in a browser here).
 * ═══════════════════════════════════════════════════════════════════════
 */

const h = vi.hoisted(() => ({ user: { id: 'u0', role: 'SUPER_ADMIN', permissions: [] as string[], status: 'ACTIVE' } }));

vi.mock('next/navigation', () => ({ usePathname: () => '/admin/permissions', useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn() }) }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => true), useTell: () => vi.fn(), useAsk: () => vi.fn() }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ locale: 'ar', isRtl: true, t: {}, currentUser: h.user }) }));
vi.mock('@/lib/api-client', () => ({
  apiJson: vi.fn(async (url: string) => (url === '/api/nav/arrangement' ? { maySetRoleBase: false, roleBase: null } : {})),
  apiFetch: vi.fn(),
}));

import { PermissionsScreen } from './PermissionsScreen';
import { EXEMPTS_FROM_HOLD, EXEMPT_FROM_HOLD_SENTENCE } from '@/lib/desk-exempt-keys';
import { EXEMPTS_FROM_HOLD as READINESS_LIST } from '@/lib/desk-readiness';

const V = '2026-11-19T10:00:00.000Z';
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
      if (url.includes('/default')) return ok({ available: false });
      return ok({
        roles: [{ id: 'r1', companyId: 'co1', name: 'دور تجربة', isSystem: false, createdAt: V, updatedAt: V, usersCount: 0, permissionsCount: 0, permissions: [] }],
      });
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openSections(...headings: string[]) {
  const user = userEvent.setup();
  render(<PermissionsScreen />);
  await screen.findByText('دور تجربة');
  await user.click(screen.getAllByRole('button', { name: /^\s*تعديل\s*$/ })[0]);
  await screen.findByText('حفظ التغييرات');
  for (const heading of headings) await user.click(await screen.findByRole('button', { name: new RegExp(`^${heading}`) }));
  return screen.getByRole('dialog');
}
/** The row of a key: the block that holds its box. */
const rowOf = (dialog: HTMLElement, key: string) => within(dialog).getByRole('checkbox', { name: new RegExp(key.replace('.', '\\.')) }).closest('.px-4') as HTMLElement;

describe('the warning beside the exempting keys', () => {
  it('the list is the lib\'s — the same one the rules page reads — and it is these two keys', () => {
    expect(READINESS_LIST).toBe(EXEMPTS_FROM_HOLD);
    expect([...EXEMPTS_FROM_HOLD].sort()).toEqual(['orders.assign', 'orders.unlock']);
    expect(EXEMPT_FROM_HOLD_SENTENCE).toBe('هالمفتاح بيعفي حامله من قاعدة «اسحبي الطلب أول»');
  });

  it('each key of the list carries the sentence, once', async () => {
    const dialog = await openSections('الطلبات');
    for (const key of EXEMPTS_FROM_HOLD) {
      const lines = rowOf(dialog, key).querySelectorAll('[data-exempts-from-hold]');
      expect(lines, key).toHaveLength(1);
      expect(lines[0].textContent).toBe(EXEMPT_FROM_HOLD_SENTENCE);
    }
  });

  it('NEGATIVE: no other key does — not «orders.view», not «confirmation.supervise»', async () => {
    const dialog = await openSections('الطلبات', 'مركز التأكيد');
    expect(dialog.querySelectorAll('[data-exempts-from-hold]')).toHaveLength(EXEMPTS_FROM_HOLD.length);
    for (const key of ['orders.view', 'orders.confirm', 'confirmation.supervise', 'confirmation.work']) {
      expect(rowOf(dialog, key).querySelector('[data-exempts-from-hold]'), key).toBeNull();
    }
  });

  it('the screen reads the list from the lib and types no key of its own for it', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/screens/PermissionsScreen.tsx'), 'utf8');
    expect(src).toContain("from '@/lib/desk-exempt-keys'");
    expect(src).not.toMatch(/\[\s*'orders\.unlock'\s*,\s*'orders\.assign'\s*\]/);
    // The browser can import the list: its file imports nothing (desk-readiness.ts brings the database with it).
    expect(readFileSync(join(process.cwd(), 'src/lib/desk-exempt-keys.ts'), 'utf8')).not.toMatch(/^import /m);
    expect(src).not.toContain("from '@/lib/desk-readiness'");
  });
});
