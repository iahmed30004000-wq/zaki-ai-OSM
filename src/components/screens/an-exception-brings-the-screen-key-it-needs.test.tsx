// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE EXCEPTIONS EDITOR NEVER SENDS AN ACTION WITHOUT ITS SCREEN KEY.
 *
 * «منح» «تعديل الطلبات» to somebody whose role gives no «عرض الطلبات» would
 * be refused by the door (`ORPHAN_ACTION`). So the editor grants the screen
 * key WITH it, before the press, in a line the person can read; and a «منع»
 * on «عرض الطلبات» denies the actions that need it. When the person cannot
 * grant what is needed, the editor says so and does not offer the press.
 *
 * It also sends the version it read (`permissionsVersion`) — a list that
 * replaces the stored one is saved only over what it was read at (RV171) —
 * and does not remove, with one click, an exception that would leave an
 * action without its screen key.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { app, net } = vi.hoisted(() => ({
  app: { value: {} as Record<string, unknown> },
  net: {
    perms: {} as Record<string, unknown>,
    calls: [] as Array<{ url: string; method: string; body: any }>,
    put: { status: 200, body: {} as Record<string, unknown> },
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/admin/users/u2',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ id: 'u2' }),
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock('@/context/AppContext', () => ({ useApp: () => app.value }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => true), useTell: () => vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ show: vi.fn(), push: vi.fn(), done: vi.fn(), failed: vi.fn(), success: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/components/performance/ScoreCard', () => ({ ScoreCard: () => null }));
vi.mock('@/components/screens/users/UserShift', () => ({ UserShift: () => null }));
vi.mock('@/components/screens/users/UserSalary', () => ({ UserSalary: () => null }));
vi.mock('@/components/screens/users/UserAccessSections', () => ({ UserGeoAccessSection: () => null, UserPhoneField: () => null }));
vi.mock('@/components/screens/users/UserCommissionCurrency', () => ({ UserCommissionCurrency: () => null }));

import { UserDetailScreen } from './UserDetailScreen';

const STAFF = {
  id: 'u2', name: 'موظّفة تأكيد', email: 'staff@example.test', role: 'CONFIRMATION_AGENT', status: 'ACTIVE', phone: null,
  createdAt: '2026-09-01T08:00:00.000Z', lastLoginAt: null, totpEnabledAt: '2026-10-01T08:00:00.000Z',
  workload: { assigned: 0, claimed: 0, created: 0 },
};

type Row = { permission: string; effect: 'ALLOW' | 'DENY'; scope: string | null; scopeIds: null };
const ALLOW = (permission: string): Row => ({ permission, effect: 'ALLOW', scope: 'ALL_COMPANY', scopeIds: null });
const DENY = (permission: string): Row => ({ permission, effect: 'DENY', scope: null, scopeIds: null });

/** The payload `/api/users/u2/permissions` answers, for a person whose role gives these keys and who has these exceptions. */
function person(roleKeys: string[], overrides: Row[] = [], version = 7) {
  const grant = { scope: 'ALL_COMPANY', scopeIds: null };
  const held = new Set(roleKeys);
  for (const o of overrides) (o.effect === 'DENY' ? held.delete(o.permission) : held.add(o.permission));
  net.perms = {
    user: { id: 'u2', name: 'موظّفة تأكيد', email: 'staff@example.test' },
    role: { id: 'r-agent', name: 'موظف تأكيد' },
    permissionsVersion: version,
    roleGrants: Object.fromEntries(roleKeys.map((k) => [k, grant])),
    overrides,
    effective: { fullAccess: false, grants: Object.fromEntries([...held].map((k) => [k, grant])) },
    denied: overrides.filter((o) => o.effect === 'DENY').map((o) => o.permission),
  };
}

function signedIn(role: string, ...permissions: string[]) {
  app.value = {
    locale: 'ar', isRtl: true, t: {},
    currentUser: { id: 'u0', name: 'المالك', role, permissions, status: 'ACTIVE' },
  };
}

beforeEach(() => {
  net.calls = [];
  net.put = { status: 200, body: {} };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      net.calls.push({ url: String(url), method, body: init?.body ? JSON.parse(init.body) : undefined });
      if (method === 'PUT') return { ok: net.put.status < 300, status: net.put.status, json: async () => (net.put.status < 300 ? net.perms : net.put.body) };
      if (method === 'DELETE') return { ok: true, status: 200, json: async () => ({ success: true }) };
      if (String(url).startsWith('/api/categories')) return { ok: true, status: 200, json: async () => ({ categories: [] }) };
      if (String(url).endsWith('/profile')) return { ok: true, status: 200, json: async () => STAFF };
      if (String(url) === '/api/roles') return { ok: true, status: 200, json: async () => ({ roles: [] }) };
      return { ok: true, status: 200, json: async () => net.perms };
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// PR-13 (قديم ← جديد): the exceptions card is editable on roles.edit now (D9), so this person holds it; she still lacks the screen key being granted.
const OWNER = ['users.view', 'users.edit', 'roles.edit'];
const put = () => net.calls.find((c) => c.method === 'PUT');

async function openAddDialog() {
  const user = userEvent.setup();
  await user.click(await screen.findByText('إضافة استثناء'));
  await screen.findByRole('option', { name: /orders\.edit/ });
  return user;
}

const keysOf = (rows: Array<{ permission: string; effect: string }>) => rows.map((r) => `${r.effect}:${r.permission}`).sort();

describe('«منح» on an action', () => {
  it('grants its screen key with it — said before the press — and sends both, over the version it read', async () => {
    signedIn('SUPER_ADMIN');
    person(['dashboard.view']);
    render(<UserDetailScreen />);
    const user = await openAddDialog();

    await user.click(screen.getByRole('option', { name: /orders\.edit/ }));
    const note = await screen.findByRole('status');
    expect(note.textContent).toContain('ومعها رح ينضاف منح «عرض الطلبات»');

    await user.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(put()).toBeTruthy());
    expect(keysOf(put()!.body.overrides)).toEqual(['ALLOW:orders.edit', 'ALLOW:orders.view']);
    expect(put()!.body.version, 'ما أرسل النسخة اللي قرأها').toBe(7);
    await waitFor(() => expect(screen.queryByText(/تم حفظ الاستثناءات — ومعها رح ينضاف منح «عرض الطلبات»/)).not.toBeNull());
  });

  it('NEGATIVE: when the role already gives the screen key nothing is added and nothing is said', async () => {
    signedIn('SUPER_ADMIN');
    person(['orders.view']);
    render(<UserDetailScreen />);
    const user = await openAddDialog();

    await user.click(screen.getByRole('option', { name: /orders\.edit/ }));
    expect(screen.queryByRole('status')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(put()).toBeTruthy());
    expect(keysOf(put()!.body.overrides)).toEqual(['ALLOW:orders.edit']);
  });

  it('is blocked, in words and with no press to make, when the person cannot grant the screen key', async () => {
    // Holds «تعديل الطلبات» and not «عرض الطلبات»: can edit exceptions, cannot give what it needs.
    signedIn('COMPANY_ADMIN', ...OWNER, 'orders.edit');
    person(['dashboard.view']);
    render(<UserDetailScreen />);
    const user = await openAddDialog();

    await user.click(screen.getByRole('option', { name: /orders\.edit/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('«تعديل الطلبات» بتحتاج «عرض الطلبات»، وإنت ما عندك «عرض الطلبات» لتمنحها.');
    expect((screen.getByRole('button', { name: 'حفظ' }) as HTMLButtonElement).disabled).toBe(true);
    expect(put()).toBeUndefined();
  });
});

describe('«منع» on a screen key', () => {
  it('denies the actions the role still gives, in a line before the press', async () => {
    signedIn('SUPER_ADMIN');
    person(['orders.view', 'orders.edit', 'orders.navigate']);
    render(<UserDetailScreen />);
    const user = userEvent.setup();
    await user.click(await screen.findByText('إضافة استثناء'));
    await user.click(await screen.findByLabelText(/منع — يحجبها/));
    await user.click(await screen.findByRole('option', { name: /orders\.view/ }));

    const lines = (await screen.findAllByText(/ومعها رح ينضاف منع/)).map((n) => n.textContent);
    expect(lines.some((l) => l?.includes('«تعديل الطلبات»'))).toBe(true);
    expect(lines.some((l) => l?.includes('«التنقّل بين الطلبات (السابق واللاحق)»'))).toBe(true);

    await user.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(put()).toBeTruthy());
    expect(keysOf(put()!.body.overrides)).toEqual(['DENY:orders.edit', 'DENY:orders.navigate', 'DENY:orders.view']);
  });
});

describe('a refusal from the door', () => {
  it('a stale list (409) is shown in the door’s words, and the person is read again so the next try carries the new version', async () => {
    signedIn('SUPER_ADMIN');
    person(['dashboard.view']);
    net.put = { status: 409, body: { error: 'تغيّرت الصلاحيات من وقت ما فتحت الشاشة — حدّث الصفحة وأعد تعديلك', code: 'STALE_VERSION' } };
    render(<UserDetailScreen />);
    const user = await openAddDialog();
    const reads = () => net.calls.filter((c) => c.method === 'GET' && c.url === '/api/users/u2/permissions').length;
    const before = reads();

    await user.click(screen.getByRole('option', { name: /orders\.view/ }));
    await user.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(screen.queryByText(/حدّث الصفحة/)).not.toBeNull());
    expect(reads()).toBeGreaterThan(before);
  });
});

describe('removing an exception', () => {
  // WAITS for the row: the heading «استثناءات المستخدم» is drawn before the rows are, and a one-shot
  // lookup lost that race under load (CI, #82) — «Unable to find audit.view» with the screen still filling.
  const removeButtonOf = async (key: string) => {
    // The key also stands in the effective table above; the row to press is the one that carries «إزالة».
    const row = await waitFor(() => {
      const li = screen
        .getAllByText(key, { selector: 'p' })
        .map((p) => p.closest('li'))
        .find((li): li is HTMLLIElement => !!li && within(li).queryByRole('button', { name: /إزالة/ }) !== null);
      if (!li) throw new Error(`no removable row for ${key}`);
      return li;
    });
    return within(row).getByRole('button', { name: /إزالة/ });
  };

  it('one that an action still depends on is NOT removed — the screen says what to do first and sends nothing', async () => {
    signedIn('SUPER_ADMIN');
    person([], [ALLOW('orders.view'), ALLOW('orders.edit')]);
    render(<UserDetailScreen />);
    const user = userEvent.setup();
    await screen.findByText('استثناءات المستخدم');
    await user.click(await removeButtonOf('orders.view'));

    const note = await screen.findByRole('status');
    expect(note.textContent).toContain('ما بينشال «عرض الطلبات» لحاله');
    expect(note.textContent).toContain('امنع «تعديل الطلبات» أول');
    expect(net.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('NEGATIVE: one nothing depends on is removed as before', async () => {
    signedIn('SUPER_ADMIN');
    person([], [ALLOW('audit.view')]);
    render(<UserDetailScreen />);
    const user = userEvent.setup();
    await screen.findByText('استثناءات المستخدم');
    await user.click(await removeButtonOf('audit.view'));

    await waitFor(() => expect(net.calls.some((c) => c.method === 'DELETE')).toBe(true));
    expect(net.calls.find((c) => c.method === 'DELETE')!.url).toBe('/api/users/u2/permissions/audit.view');
    expect(screen.queryByRole('status')).toBeNull();
  });
});
