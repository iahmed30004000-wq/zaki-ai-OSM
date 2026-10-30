// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { repoFile, stripComments } from '@/lib/guard-source';
import { Pager } from './Pager';

/**
 * THE ORDERS, CUSTOMERS AND USERS LISTS DRAW THE SAME PAGE BAR AS THE OTHERS.
 *
 * Each of the three carried its own copy of the arrows and «صفحة X من Y». They
 * say the count their own way (the orders screen says it on the line above the
 * list, the users screen says «إجمالي N مستخدم»), so the bar takes a `label`:
 * `null` draws nothing on that side, a node replaces the default sentence, and
 * leaving it out keeps «عرض 25 من 312 طلب» as it was for the lists that never
 * passed one.
 */

afterEach(cleanup);

const bar = (over: Partial<React.ComponentProps<typeof Pager>> = {}) =>
  render(<Pager page={2} totalPages={5} total={110} shown={25} noun="مستخدم" onPage={vi.fn()} {...over} />);

describe('the count on the start side', () => {
  it('— left out, it is the sentence every list always had', () => {
    bar();
    expect(screen.getByText(/عرض/).textContent).toBe('عرض 25 من 110 مستخدم');
  });

  it('— null draws no count at all, and the page position is still there', () => {
    bar({ label: null });
    expect(screen.queryByText(/عرض/)).toBeNull();
    expect(screen.getByText('صفحة 2 من 5')).toBeTruthy();
  });

  it('— a node replaces the sentence (the users screen’s «إجمالي N مستخدم»)', () => {
    bar({ label: <>إجمالي <strong>110</strong> مستخدم</> });
    expect(screen.queryByText(/عرض/)).toBeNull();
    expect(screen.getByText(/إجمالي/).textContent).toBe('إجمالي 110 مستخدم');
  });
});

describe('the three screens use the shared bar and no longer write the arrows out', () => {
  for (const file of ['OrdersScreen', 'CustomersScreen', 'UsersScreen']) {
    it(`— ${file}`, () => {
      const src = stripComments(repoFile(`src/components/screens/${file}.tsx`));
      expect(src, 'لا شريط مشترك').toContain("from '@/components/ui/Pager'");
      expect(src).toContain('<Pager');
      expect(src, 'سهمٌ مكتوب باليد').not.toMatch(/RiArrow(Left|Right)SLine/);
      expect(src, 'ملصق الصفحة مكتوب باليد').not.toMatch(/صفحة \{pagination\.page\}/);
    });
  }
});
