// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { CampaignsBoard, type BoardCampaign } from './CampaignsBoard';

/**
 * The board on the campaigns screen: the cards, the filters, three views, selection with «احذف المحدد», «احذف
 * المكرر», and dragging — offered only on the whole list.
 */

vi.mock('@/components/shell/BulkBar', () => ({
  BulkBar: ({ show, children }: { show: boolean; children: React.ReactNode }) => (show ? <div data-testid="bulk">{children}</div> : null),
}));

afterEach(cleanup);

const camp = (id: string, name: string, over: Partial<BoardCampaign> = {}): BoardCampaign => ({
  id, name, code: id.toUpperCase(), status: 'ACTIVE', platform: 'META', adAccount: { id: 'acc' }, product: { id: 'p' }, duplicateOf: null,
  money: { spend: 10, revenue: 30, net: 20, roas: 3, costPerDelivered: 2, costPerOrder: 1 },
  funnel: { brought: 5, delivered: 3 },
  ...over,
});
const list = [
  camp('a', 'كمأة سايت'),
  camp('b', 'ندبات', { status: 'PAUSED', money: { spend: 40, revenue: 0, net: -40, roas: 0, costPerDelivered: null, costPerOrder: null }, funnel: { brought: 0, delivered: 0 } }),
  camp('c', 'كمأة يدوية', { adAccount: null, duplicateOf: 'a' }),
];
const insights = { best: { id: 'a', name: 'كمأة سايت', roas: 3 }, worst: { id: 'b', name: 'ندبات', net: -40 }, spentNoOrders: 1, noProduct: 0, duplicates: 1 };

function draw(over: Partial<React.ComponentProps<typeof CampaignsBoard>> = {}) {
  const props = {
    // was: no `mayManage` — the writes are drawn only for «إدارة الحملات» since PR-11, so the board is told.
    mayManage: true,
    campaigns: list, insights, currency: 'USD',
    statuses: [{ key: 'ACTIVE', label: 'تعمل' }, { key: 'PAUSED', label: 'متوقفة' }],
    platforms: [{ key: 'META', label: 'ميتا' }],
    accounts: [{ id: 'acc', accountName: 'كيوان 3', accountId: 'act_1' }],
    renderCard: (c: BoardCampaign) => <div data-testid="card">{c.name}</div>,
    onReorder: vi.fn(async () => {}), onBulkDelete: vi.fn(async () => {}), onMerge: vi.fn(async () => {}),
    ...over,
  };
  render(<CampaignsBoard {...props} />);
  return props;
}

describe('the campaigns board', () => {
  it('shows the server’s cards, and a card narrows the list', () => {
    draw();
    expect(screen.getByText('3×')).toBeTruthy();
    fireEvent.click(screen.getByText('صرفت بلا طلبات', { selector: 'p' }).closest('button')!);
    expect(screen.getAllByTestId('card').map((e) => e.textContent)).toEqual(['ندبات']);
  });

  it('filters by name and by status', () => {
    draw();
    fireEvent.change(screen.getByLabelText('ابحث في الحملات'), { target: { value: 'كمأة' } });
    expect(screen.getAllByTestId('card')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('الحالة'), { target: { value: 'PAUSED' } });
    expect(screen.queryAllByTestId('card')).toHaveLength(0);
  });

  it('offers dragging on the whole list — and NEGATIVE: not while a filter narrows it', () => {
    draw();
    expect(screen.getAllByLabelText(/^اسحب /)).toHaveLength(3);
    fireEvent.change(screen.getByLabelText('ابحث في الحملات'), { target: { value: 'كمأة' } });
    expect(screen.queryAllByLabelText(/^اسحب /)).toHaveLength(0);
  });

  it('selects everything shown, and the bar deletes exactly that', () => {
    const p = draw();
    fireEvent.click(screen.getByLabelText('حدد كل المعروض'));
    fireEvent.click(screen.getByRole('button', { name: /احذف المحدد/ }));
    expect(p.onBulkDelete).toHaveBeenCalledWith(['a', 'b', 'c']);
  });

  it('«احذف المكرر» merges every duplicate; a selected duplicate can be merged alone', () => {
    const p = draw();
    fireEvent.click(screen.getByRole('button', { name: /احذف المكرر \(1\)/ }));
    expect(p.onMerge).toHaveBeenCalledWith();
    fireEvent.click(screen.getByLabelText('حدد كمأة يدوية'));
    fireEvent.click(screen.getByRole('button', { name: /ادمج المكرر المحدد/ }));
    expect(p.onMerge).toHaveBeenLastCalledWith(['c']);
  });

  it('three views — cards, table, short list', () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'جدول' }));
    expect(screen.queryAllByTestId('card')).toHaveLength(0);
    expect(screen.getByText('كلفة الواصل')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'قائمة مختصرة' }));
    const row = screen.getAllByTitle('ندبات').at(-1)!.parentElement!;
    expect(row.textContent).toMatch(/40.*USD · 0× · 0$/);
  });

  it('NEGATIVE: with no duplicates there is no merge button', () => {
    draw({ insights: { ...insights, duplicates: 0 } });
    expect(screen.queryByRole('button', { name: /احذف المكرر/ })).toBeNull();
  });
});

describe('a viewer of the campaigns (campaigns.view without campaigns.manage)', () => {
  // an earlier test picks the short list, and the view is remembered in this browser — start from the default
  beforeEach(() => { try { localStorage.clear(); } catch { /* storage refused */ } });

  it('sees the cards, the filters and the views, and none of the writes: no selection, no drag, no merge, no bulk bar', () => {
    draw({ mayManage: false });
    expect(screen.getAllByTestId('card')).toHaveLength(3);
    expect(screen.getByLabelText('ابحث في الحملات')).toBeTruthy();
    expect(screen.queryByLabelText('حدد كل المعروض')).toBeNull();
    expect(screen.queryAllByLabelText(/^حدد /)).toHaveLength(0);
    expect(screen.queryAllByLabelText(/^اسحب /)).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /احذف المكرر/ })).toBeNull();
    expect(screen.queryByTestId('bulk')).toBeNull();
  });

  it('NEGATIVE: the same board for a manager offers every one of them', () => {
    draw({ mayManage: true });
    expect(screen.getByLabelText('حدد كل المعروض')).toBeTruthy();
    expect(screen.getAllByLabelText(/^اسحب /)).toHaveLength(3);
    expect(screen.getByRole('button', { name: /احذف المكرر \(1\)/ })).toBeTruthy();
  });
});
