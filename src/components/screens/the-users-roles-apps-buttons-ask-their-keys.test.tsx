// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { repoFile, stripComments } from '@/lib/guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE BUTTONS ARE DRAWN FOR WHO THE DOOR WILL ANSWER (perm-plan PR-13).
 *
 *   · «تعديل» on a SYSTEM role template asks `roles.edit_system`; the screen says why a template is read-only;
 *   · the keys of other systems (a panel inside «التطبيقات المثبتة») are drawn for `apps.tokens`, not for the shelf's key;
 *   · «إدارة» on the employees list asks `users.edit` — every act in the panel it opens asks it;
 *   · the employee's page: the shift card asks `users.edit` AND `users.shift`, the personal-exceptions card is editable on
 *     `roles.edit` (D9), the password card needs the security key AND the edit key, and the 2FA button the security key.
 *
 * Each case has its NEGATIVE: the same screen, the same row, the key absent. The SUPER_ADMIN sees every button with nothing listed.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { user, apiJson } = vi.hoisted(() => ({
  user: { current: { id: 'u1', name: 'سارة', role: 'CUSTOM', permissions: [] as string[], status: 'ACTIVE' } as Record<string, unknown> },
  apiJson: vi.fn(),
}));

vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: user.current, locale: 'ar', isRtl: true, t: {} }) }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: vi.fn() }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<unknown>) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, []);
  },
}));
vi.mock('@/components/apps/SystemTokensPanel', () => ({ SystemTokensPanel: () => <div>لوحة المفاتيح</div> }));
vi.mock('@/components/ui/Confirm', () => ({ useAsk: () => vi.fn(), useTell: () => vi.fn(), useConfirm: () => vi.fn() }));

import { PermissionsScreen } from './PermissionsScreen';
import { InstalledAppsScreen } from './InstalledAppsScreen';

const holding = (...keys: string[]) => {
  user.current = { id: 'u1', name: 'سارة', role: 'CUSTOM', permissions: keys, status: 'ACTIVE' };
};

const ROLES = [
  { id: 't1', companyId: null, name: 'MANAGER', isSystem: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', usersCount: 2, permissionsCount: 3, permissions: [] },
  { id: 'c1', companyId: 'co1', name: 'مسؤول المخزن', isSystem: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', usersCount: 1, permissionsCount: 2, permissions: [] },
  { id: 's1', companyId: null, name: 'SUPER_ADMIN', isSystem: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', usersCount: 1, permissionsCount: 0, permissions: [] },
];

beforeEach(() => {
  vi.clearAllMocks();
  holding();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ roles: ROLES }) })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ───────────────────────────── the roles screen ─────────────────────────────

const READ_ONLY = /تعديل قوالب الأدوار الأساسية/;
const editButtons = () => screen.queryAllByRole('button', { name: /^تعديل$/ });

describe('«تعديل» on a role', () => {
  it('NEGATIVE: with roles.edit alone the system template has no edit button and says why; the company’s own role does', async () => {
    holding('roles.view', 'roles.edit');
    render(<PermissionsScreen />);
    await screen.findByText('MANAGER');
    expect(editButtons()).toHaveLength(1); // only «مسؤول المخزن»
    expect(screen.getByText(READ_ONLY)).toBeTruthy();
  });

  it('with roles.edit_system the template gets its button too, and the sentence is gone', async () => {
    holding('roles.view', 'roles.edit', 'roles.edit_system');
    render(<PermissionsScreen />);
    await screen.findByText('MANAGER');
    expect(editButtons()).toHaveLength(2);
    expect(screen.queryByText(READ_ONLY)).toBeNull();
  });

  it('NEGATIVE: roles.edit_system without roles.edit draws no edit button at all', async () => {
    holding('roles.view', 'roles.edit_system');
    render(<PermissionsScreen />);
    await screen.findByText('MANAGER');
    expect(editButtons()).toHaveLength(0);
    expect(screen.queryByText(READ_ONLY), 'a sentence about a button she would not have had anyway').toBeNull();
  });

  it('the owner sees both buttons with nothing listed — and the SUPER_ADMIN template stays read-only for her too', async () => {
    user.current = { id: 'root', name: 'المالك', role: 'SUPER_ADMIN', permissions: [], status: 'ACTIVE' };
    render(<PermissionsScreen />);
    await screen.findByText('MANAGER');
    expect(editButtons()).toHaveLength(2);
    expect(screen.getAllByText('قراءة فقط').length).toBeGreaterThan(0);
  });
});

// ───────────────────────────── the installed apps screen ─────────────────────────────

describe('the keys of other systems', () => {
  const body = { builtIn: [], external: [] };
  beforeEach(() => {
    apiJson.mockImplementation(async (url: string) => (url.includes('deliveries') ? { deliveries: [], totals: { pending: 0, failed: 0, ok: 0 } } : body));
  });

  it('are drawn for apps.tokens', async () => {
    holding('apps.view', 'apps.tokens');
    render(<InstalledAppsScreen />);
    await waitFor(() => expect(apiJson).toHaveBeenCalled());
    expect(screen.getByText('لوحة المفاتيح')).toBeTruthy();
  });

  it('NEGATIVE: not drawn for the shelf’s own key (apps.manage) — and the panel makes no request that would be refused', async () => {
    holding('apps.view', 'apps.manage');
    render(<InstalledAppsScreen />);
    await waitFor(() => expect(apiJson).toHaveBeenCalled());
    expect(screen.queryByText('لوحة المفاتيح')).toBeNull();
  });
});

// ───────────────────────────── the screens' source: the keys they ask ─────────────────────────────

describe('the employee’s page and the list, read as source', () => {
  const detail = () => stripComments(repoFile('src/components/screens/UserDetailScreen.tsx'));
  const list = () => stripComments(repoFile('src/components/screens/UsersScreen.tsx'));

  it('the shift card is editable only with the edit key AND users.shift', () => {
    const src = detail();
    expect(src).toMatch(/canEdit=\{userCan\(currentUser, 'users\.edit'\) && userCan\(currentUser, 'users\.shift'\)\}/);
  });

  it('the personal exceptions are editable on roles.edit (D9) — not on the profile key', () => {
    const src = detail();
    expect(src).toMatch(/<UserPermissionsSection userId=\{userId\} canEdit=\{userCan\(currentUser, 'roles\.edit'\) && mayManage\} \/>/);
    expect(src).not.toMatch(/<UserPermissionsSection[^>]*users\.edit/);
  });

  it('the password card needs the security key (the rule) AND the edit key the door opens on', () => {
    expect(detail()).toMatch(/maySetPassword\(currentUser as never, user\.id\)\.ok && userCan\(currentUser, 'users\.edit'\)/);
  });

  it('the 2FA button is drawn by the same rule the server uses (mayResetTwoFactor → users.security)', () => {
    expect(detail()).toMatch(/mayResetTwoFactor\(currentUser as never, user\.id\)\.ok && user\.totpEnabledAt/);
    expect(stripComments(repoFile('src/lib/two-factor-reset.ts'))).toMatch(/userCan\(user, 'users\.security'\)/);
  });

  it('«إدارة» on the list is drawn only for users.edit', () => {
    expect(list()).toMatch(/userCan\(currentUser, 'users\.edit'\) && \(\s*<Button[^>]*onClick=\{\(\) => openManage\(u\)\}/);
  });
});
