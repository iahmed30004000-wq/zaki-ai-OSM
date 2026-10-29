// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * CALL, SMS AND WHATSAPP ARE 44px ON A PHONE — AND STAY SMALL IN A TABLE.
 *
 * They were 28px squares four pixels apart on the orders and customers
 * rows, and 32px tall on «طلباتي» beside 44px buttons. A thumb that lands
 * on the neighbour dials a customer by mistake — and writes a line in the
 * contact log for a call nobody meant to make.
 *
 * jsdom draws no layout; what is pinned is the rule the measurement came
 * down to, read off the rendered buttons: a phone height on every one, the
 * desk's old size restored from `md`, and a full strip that shares its row.
 * ═══════════════════════════════════════════════════════════════════════
 */

vi.mock('@/lib/api-client', () => ({ apiJson: vi.fn(async () => ({ templates: [] })) }));

import { ContactButtons } from './ContactButtons';

const CONTEXT = { orderNumber: 'ORD-1', customerName: 'أبو محمد', amount: 25 };

beforeEach(() => {
  // A phone, so SMS is drawn as a button and not as a sentence.
  vi.stubGlobal('navigator', { ...navigator, maxTouchPoints: 5 });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const has = (el: Element, c: string) => el.classList.contains(c);
const strip = () => [screen.getByTitle('اتصال'), screen.getByTitle('رسالة نصية'), screen.getByTitle('واتساب')];

describe('the compact strip, in a table cell', () => {
  it('is 44px tall on a phone and 44px wide, and returns to 28 × 28 from md', () => {
    render(<ContactButtons phone="0791234567" countryCode="962" context={CONTEXT} compact />);
    const three = strip();
    expect(three.length).toBe(3);
    for (const b of three) {
      expect(has(b, 'h-11'), 'أقل من 44 طولاً').toBe(true);
      expect(has(b, 'min-w-11'), 'أقل من 44 عرضاً').toBe(true);
      expect(has(b, 'md:h-7'), 'ما رجع للمكتب').toBe(true);
      expect(has(b, 'md:min-w-0')).toBe(true);
      expect(has(b, 'w-7'), 'عرض المكتب القديم').toBe(true);
      // The old fixed 28px height must not sit beside the phone's 44.
      expect(has(b, 'h-7')).toBe(false);
    }
  });

  it('keeps the strip as wide as its buttons — a table cell has no room to stretch it', () => {
    const { container } = render(
      <ContactButtons phone="0791234567" countryCode="962" context={CONTEXT} compact />
    );
    const root = container.firstElementChild as HTMLElement;
    expect(has(root, 'inline-flex')).toBe(true);
    expect(has(root, 'flex')).toBe(false);
  });
});

describe('the full strip, on a work card', () => {
  it('is 44px on a phone and 32px from md, and the three share the row', () => {
    const { container } = render(<ContactButtons phone="0791234567" countryCode="962" context={CONTEXT} />);
    for (const b of strip()) {
      expect(has(b, 'h-11'), 'أقل من 44').toBe(true);
      expect(has(b, 'md:h-8')).toBe(true);
      expect(has(b, 'flex-1'), 'ما تقاسمت السطر').toBe(true);
      expect(has(b, 'md:flex-none')).toBe(true);
      // The old fixed 32px height is gone.
      expect(has(b, 'h-8')).toBe(false);
    }
    const root = container.firstElementChild as HTMLElement;
    expect(has(root, 'flex'), 'الشريط ما يمتد بعرض البطاقة').toBe(true);
    expect(has(root, 'md:inline-flex')).toBe(true);
    expect(has(root, 'gap-2')).toBe(true);
  });
});
