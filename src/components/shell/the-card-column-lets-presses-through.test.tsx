// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE COLUMN OF CARDS CATCHES PRESSES ON THE CARDS, NOT BETWEEN THEM.
 *
 * The corner container is a fixed column 20rem wide standing above the
 * page's last rows. On a phone five cards cover up to 250 points from the
 * bottom, and the container itself — the 8px gaps between the cards and any
 * strip beside a narrow one — swallowed the taps meant for the page under
 * it. The container now passes presses through, and only the cards and
 * «إخفاء الكل» take them.
 *
 * jsdom has no hit-testing, so what is pinned is the pair of rules that
 * produce it, read off the rendered tree: the column lets presses through,
 * and every control inside it turns them back on.
 * ═══════════════════════════════════════════════════════════════════════
 */

const NOTES = [1, 2, 3].map((n) => ({
  id: `n${n}`,
  type: 'ORDER_NEW',
  title: `طلب ${n}`,
  message: 'وصل طلب جديد',
  link: n === 1 ? '/orders' : null,
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('./NotificationsProvider', () => ({
  useNotifications: () => ({
    arriving: NOTES,
    dismiss: () => {},
    dismissAll: () => {},
    markRead: async () => {},
  }),
}));

import { NotificationCards } from './NotificationCards';

afterEach(cleanup);

const has = (el: Element, c: string) => el.classList.contains(c);

describe('the card column', () => {
  it('lets a press through wherever there is no card', () => {
    render(<NotificationCards />);
    const column = screen.getByText('طلب 1').closest('[aria-live]') as HTMLElement;
    expect(column).toBeTruthy();
    expect(has(column, 'pointer-events-none'), 'العمود ما زال يلتقط الضغط بالفراغات').toBe(true);
  });

  it('and takes it back on every card', () => {
    render(<NotificationCards />);
    const column = screen.getByText('طلب 1').closest('[aria-live]') as HTMLElement;
    // The cards are the column's direct children, apart from «إخفاء الكل».
    const cards = [...column.children].filter((c) => c.tagName === 'DIV');
    expect(cards.length).toBe(3);
    for (const c of cards) {
      expect(has(c, 'pointer-events-auto'), 'بطاقة ما بتستقبل ضغطة').toBe(true);
    }
  });

  it('and on «إخفاء الكل», which sits in the same column', () => {
    render(<NotificationCards />);
    const all = screen.getByText(/إخفاء الكل/).closest('button') as HTMLElement;
    expect(has(all, 'pointer-events-auto'), 'زر الإخفاء الكلّي صار ميّتاً').toBe(true);
  });

  it('each card’s own dismiss button is inside the card, so it takes the press with it', () => {
    render(<NotificationCards />);
    const dismiss = screen.getByLabelText('أخفِ طلب 2');
    expect(dismiss.closest('.pointer-events-auto'), 'زر الإخفاء خارج البطاقة').toBeTruthy();
  });
});
