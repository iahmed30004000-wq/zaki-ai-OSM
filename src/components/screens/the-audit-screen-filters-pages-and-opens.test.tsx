// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * «سجل التدقيق» — the screen draws what the door sends, in Arabic, and never sends more
 * than was chosen. It is rendered, not read: a link that is drawn for somebody who may not
 * open it is the failure, and only a render can see it.
 */

const { api, may } = vi.hoisted(() => ({
  api: vi.fn(),
  may: { yes: ((_p: string) => true) as (p: string) => boolean },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/hooks/useMayOpen', () => ({
  useMayOpen: () => (target: string | { path: string }) => may.yes(typeof target === 'string' ? target : target.path),
}));
vi.mock('@/hooks/useLiveRefresh', () => ({ useLiveRefresh: () => {} }));
vi.mock('@/components/ui/PageHeader', () => ({
  PageHeader: ({ title, description }: { title: string; description?: string }) => (
    <header>
      <h1>{title}</h1>
      <p>{description}</p>
    </header>
  ),
}));

import { AuditScreen } from './AuditScreen';

const ORDER_ID = '0f8c1b2a-1111-4222-8333-444455556666';
const ROW = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  action: 'ORDER_STATUS_CHANGED',
  entity: 'Order',
  entityId: ORDER_ID,
  newData: JSON.stringify({ status: 'CONFIRMED' }),
  createdAt: '2026-10-20T10:00:00.000Z',
  user: { id: 'u1', name: 'سامر', role: 'MODERATOR' },
  ...over,
});
const BODY = (logs: unknown[], over: Record<string, unknown> = {}) => ({
  logs,
  pagination: { total: 60, page: 1, limit: 25, totalPages: 3 },
  facts: {
    users: [{ id: 'u1', name: 'سامر', count: 40 }, { id: 'system', name: 'النظام (تلقائي)', count: 20 }],
    entities: [{ entity: 'Order', count: 50 }, { entity: 'Wallet', count: 10 }],
  },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  may.yes = () => true;
  api.mockResolvedValue(BODY([ROW(), ROW({ id: 'a2', action: 'WALLET_STOPPED', entity: 'Wallet', entityId: 'w-0000-1111-2222', user: null })]));
});
afterEach(cleanup);

const urls = () => api.mock.calls.map((c) => String(c[0]));

describe('the rows', () => {
  it('say the action and the record in Arabic, and the automatic ones are named', async () => {
    render(<AuditScreen />);
    expect((await screen.findAllByText('تغيير حالة طلب')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('إيقاف محفظة').length).toBeGreaterThan(0);
    expect(screen.getAllByText('النظام (تلقائي)').length).toBeGreaterThan(0);
    // no English sentence for a heading any more
    expect(document.body.textContent).not.toMatch(/Section 29|audit trail/i);
  });

  it('keeps the machine code on the tooltip — nothing is lost by the Arabic', async () => {
    render(<AuditScreen />);
    await screen.findAllByText('تغيير حالة طلب');
    expect(document.querySelector('[title="ORDER_STATUS_CHANGED"]')).not.toBeNull();
  });

  it('an order opens from its row; a wallet has no link', async () => {
    render(<AuditScreen />);
    await screen.findAllByText('تغيير حالة طلب');
    const links = screen.getAllByRole('link', { name: 'افتح' });
    expect(new Set(links.map((l) => l.getAttribute('href')))).toEqual(new Set([`/orders/${ORDER_ID}`]));
  });

  it('NEGATIVE: somebody who may not open the orders sees the id and no link', async () => {
    may.yes = (p) => p !== '/orders';
    render(<AuditScreen />);
    await screen.findAllByText('تغيير حالة طلب');
    expect(screen.queryByRole('link', { name: 'افتح' })).toBeNull();
    expect(screen.getAllByText(ORDER_ID.slice(0, 8)).length).toBeGreaterThan(0);
  });
});

describe('a row the server cut says so', () => {
  it('a partners’ row without its figures says why they are missing, and which key opens them', async () => {
    api.mockResolvedValue(BODY([ROW({ id: 'a3', action: 'PARTNERS_SAVED', entity: 'Partner', entityId: 'c1', newData: null, partnersWithheld: true })]));
    render(<AuditScreen />);
    // drawn once for the table and once for the phone's cards
    expect((await screen.findAllByText(/الأسماء والنسب والمبالغ لا تظهر إلا لمن معه صلاحية «الشركاء والسحوبات»/)).length).toBeGreaterThan(0);
    // the pay row's own note does not ride along on a partners' row
    expect(screen.queryByText(/عرض الرواتب/)).toBeNull();
  });

  it('a row nobody cut carries no note', async () => {
    render(<AuditScreen />);
    await screen.findAllByText('تغيير حالة طلب');
    expect(screen.queryByText(/لا تظهر إلا لمن معه صلاحية/)).toBeNull();
  });
});

describe('the questions it asks', () => {
  it('opens with nothing chosen: page 1, 25 rows, no filter in the address', async () => {
    render(<AuditScreen />);
    await screen.findAllByText('تغيير حالة طلب');
    expect(urls()[0]).toBe('/api/audit-logs?page=1&limit=25');
  });

  it('a person chosen is asked for, from page one, with the figure beside the name', async () => {
    render(<AuditScreen />);
    await screen.findAllByText('تغيير حالة طلب');
    expect(screen.getByRole('option', { name: 'سامر (40)' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('مَن'), { target: { value: 'u1' } });
    await waitFor(() => expect(urls().some((u) => u.includes('user=u1') && u.includes('page=1'))).toBe(true));
  });

  it('a kind of record chosen is asked for, and «إعادة تعيين» brings the whole trail back', async () => {
    render(<AuditScreen />);
    await screen.findAllByText('تغيير حالة طلب');
    fireEvent.change(screen.getByLabelText('على ماذا'), { target: { value: 'Wallet' } });
    await waitFor(() => expect(urls().some((u) => u.includes('entity=Wallet'))).toBe(true));
    await act(async () => {
      screen.getByRole('button', { name: /إعادة تعيين/ }).click();
    });
    await waitFor(() => expect(urls().at(-1)).toBe('/api/audit-logs?page=1&limit=25'));
  });

  it('the pager asks for the next page of the same list', async () => {
    render(<AuditScreen />);
    await screen.findAllByText('تغيير حالة طلب');
    expect(screen.getByText(/صفحة 1 من 3/)).toBeTruthy();
    await act(async () => {
      screen.getByRole('button', { name: 'الصفحة التالية' }).click();
    });
    await waitFor(() => expect(urls().at(-1)).toContain('page=2'));
  });
});

describe('when nothing matches', () => {
  it('says so and offers the way back, instead of «the log is empty»', async () => {
    api.mockResolvedValue(BODY([], { pagination: { total: 0, page: 1, limit: 25, totalPages: 1 } }));
    render(<AuditScreen />);
    fireEvent.change(await screen.findByLabelText('على ماذا'), { target: { value: 'Wallet' } });
    expect(await screen.findAllByText('لا أحداث بهذه الاختيارات')).not.toHaveLength(0);
  });

  it('an empty log with no choice is the honest «nothing yet»', async () => {
    api.mockResolvedValue(BODY([], { pagination: { total: 0, page: 1, limit: 25, totalPages: 1 } }));
    render(<AuditScreen />);
    expect((await screen.findAllByText('لا أحداث في السجلّ بعد')).length).toBeGreaterThan(0);
  });
});
