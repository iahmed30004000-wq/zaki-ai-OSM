// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { ON_CALL_KEY } from '@/lib/exposure';

/**
 * THE PRESS OF «اتصال» TELLS THE IDLE GUARD A CALL BEGAN — the owner's ruling 4/11.
 *
 * The time she spends in the dialler (or the call helper) is work, and IdleGuard counts it as such only if the press
 * left its mark. The mark is a time and nothing else: no number, no order, no name.
 */

vi.mock('@/lib/api-client', () => ({ apiJson: vi.fn(async () => ({ templates: [] })) }));

import { ContactButtons } from './ContactButtons';

const CONTEXT = { orderNumber: 'ORD-1', customerName: 'أبو محمد', amount: 25 };

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('open', vi.fn());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('«اتصال»', () => {
  it('leaves the time of the press, and only the time', () => {
    const before = Date.now();
    render(<ContactButtons phone="0791234567" countryCode="962" orderId="o1" context={CONTEXT} />);
    fireEvent.click(screen.getByTitle('اتصال'));
    const mark = localStorage.getItem(ON_CALL_KEY);
    expect(mark, 'الضغطة ما تركت علامة — المكالمة بتنحسب خمول').not.toBeNull();
    expect(Number(mark)).toBeGreaterThanOrEqual(before);
    expect(mark).toMatch(/^\d+$/);
  });

  it('and WhatsApp does not — a message is not a call', () => {
    render(<ContactButtons phone="0791234567" countryCode="962" orderId="o1" context={CONTEXT} />);
    fireEvent.click(screen.getByTitle('واتساب'));
    expect(localStorage.getItem(ON_CALL_KEY)).toBeNull();
  });
});
