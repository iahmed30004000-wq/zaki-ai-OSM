// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { stripComments, repoFile } from '@/lib/guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A SENTENCE THAT BECAME A LIE MUST NOT BE ON THE SCREEN.
 *
 * With `AUTH_TWO_FACTOR_REQUIRED` off (the default since the owner's ruling 11/11) nobody is asked for a second code. The
 * employee page used to say «كلّ حساب صار عليه تحقّق بخطوتين … رح يُطلَب منه يسجّله أوّل مرّة يدخل» and «ولا يدخل أحدٌ بلا
 * تحقّق»; the list said «بانتظار أوّل دخول». Those are true only while the code is asked. The server page reads the switch
 * and hands it to the screen; the words follow it, and the old words are back the moment it is on.
 *
 * NOTHING IS REMOVED: the reset button (it clears a phone and ends the account's sessions) stays, for an enrolled account.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { app, state } = vi.hoisted(() => ({
  app: { value: {} as Record<string, unknown> },
  state: { enrolled: false },
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

const STAFF = (enrolled: boolean) => ({
  id: 'u2', name: 'موظّفة تأكيد', email: 'staff@example.test', role: 'CONFIRMATION_AGENT', status: 'ACTIVE', phone: null,
  createdAt: '2026-09-01T08:00:00.000Z', lastLoginAt: null, totpEnabledAt: enrolled ? '2026-10-01T08:00:00.000Z' : null,
  workload: { assigned: 0, claimed: 0, created: 0 },
});

const PERMISSIONS = {
  user: { id: 'u2', name: 'موظّفة تأكيد', email: 'staff@example.test' },
  role: { id: 'r-agent', name: 'موظف تأكيد' },
  permissionsVersion: 1,
  roleGrants: {},
  overrides: [],
  effective: { fullAccess: false, grants: {} },
  denied: [],
};

beforeEach(() => {
  app.value = {
    locale: 'ar', isRtl: true, t: {},
    currentUser: { id: 'u0', name: 'المالك', role: 'SUPER_ADMIN', permissions: ['users.view', 'users.edit', 'users.security'], status: 'ACTIVE' },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).endsWith('/profile')) return { ok: true, status: 200, json: async () => STAFF(state.enrolled) };
      if (String(url) === '/api/roles') return { ok: true, status: 200, json: async () => ({ roles: [] }) };
      // The exceptions editor on this page reads the person's permissions; an empty answer crashes its render.
      return { ok: true, status: 200, json: async () => PERMISSIONS };
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const OLD_NOT_ENROLLED = /كلّ حساب صار عليه تحقّق بخطوتين/;
const OLD_ENROLLED = /ولا يدخل أحدٌ بلا تحقّق/;

describe('the employee page — an account that never set the second code up', () => {
  beforeEach(() => {
    state.enrolled = false;
  });

  it('with the code NOT required it says so — and does not promise a setup at the next sign-in', async () => {
    render(<UserDetailScreen twoFactorRequired={false} />);
    await screen.findByText('غير مطلوب');
    expect(screen.getByText(/غير مطلوب على أي حساب الآن/)).toBeTruthy();
    expect(screen.queryByText('بانتظار أوّل دخول')).toBeNull();
    expect(screen.queryByText(OLD_NOT_ENROLLED), 'الجملة القديمة صارت كذبة وما زالت ظاهرة').toBeNull();
  });

  it('with it required the words are the ones that were there', async () => {
    render(<UserDetailScreen twoFactorRequired />);
    await screen.findByText('بانتظار أوّل دخول');
    expect(screen.getByText(OLD_NOT_ENROLLED)).toBeTruthy();
    expect(screen.queryByText('غير مطلوب')).toBeNull();
  });

  it('and for a caller that says nothing — every test, any future page — the old words stay', async () => {
    render(<UserDetailScreen />);
    await screen.findByText('بانتظار أوّل دخول');
    expect(screen.getByText(OLD_NOT_ENROLLED)).toBeTruthy();
  });
});

describe('the employee page — an account that has one', () => {
  beforeEach(() => {
    state.enrolled = true;
  });

  it('with the code NOT required it does not say «nobody gets in without it» — and the reset button is still there', async () => {
    render(<UserDetailScreen twoFactorRequired={false} />);
    await screen.findByText(/غير مطلوب عند الدخول الآن/);
    expect(screen.queryByText(OLD_ENROLLED), 'الجملة القديمة صارت كذبة وما زالت ظاهرة').toBeNull();
    expect(screen.getByText('أعِد ضبط التحقّق بخطوتين'), 'الزر انشال بدل ما يتعلّم').toBeTruthy();
  });

  it('with it required the old sentence is back, word for word', async () => {
    render(<UserDetailScreen twoFactorRequired />);
    await screen.findByText(OLD_ENROLLED);
    expect(screen.getByText('أعِد ضبط التحقّق بخطوتين')).toBeTruthy();
  });
});

describe('the employees list, and the words the server sends back', () => {
  const read = (rel: string) => stripComments(repoFile(rel));

  it('the list column reads «غير مطلوب» for an account that never enrolled while the code is not asked, and «مفعّل» for one that did', () => {
    const src = read('src/components/screens/UsersScreen.tsx');
    expect(src).toContain("{u.totpEnabledAt ? 'مفعّل' : twoFactorRequired ? 'بانتظار أوّل دخول' : 'غير مطلوب'}");
    expect(src).toContain('twoFactorRequired = true');
  });

  it('both server pages read the switch at request time and hand it down', () => {
    expect(read('src/app/(system)/(shell)/admin/users/page.tsx')).toContain('<UsersScreen twoFactorRequired={twoFactorRequired()} />');
    expect(read('src/app/(system)/(shell)/admin/users/[id]/page.tsx')).toContain('<UserDetailScreen twoFactorRequired={twoFactorRequired()} />');
  });

  it('the reset door’s message follows the switch too: it only promises a re-setup while the code is asked', () => {
    const src = read('src/app/api/users/[id]/two-factor/route.ts');
    expect(src).toMatch(/message: twoFactorRequired\(\)\s*\?/);
    expect(src).toContain('سيُطلب منه تسجيله من جديد عند الدخول القادم');
    expect(src).toContain('التحقّق غير مطلوب عند الدخول الآن');
  });
});
