// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * THE ONE COPY BUTTON, TOLD TWO THINGS — and nothing else about it changed.
 *
 * `title`: a screen whose button holds a value the plain «نسخ <noun>» does not name («انسخ المرجع»).
 * `onRefused`: a screen that hands a refused copy to something better than a warning that goes away (a dialog with the
 * value in a field to select by hand).
 *
 * Left out, both are what they always were: the tooltip «نسخ <noun>» and the warning toast that carries the value —
 * `OrderRef.test.tsx` holds the rest of the button.
 */

const { warn } = vi.hoisted(() => ({ warn: vi.fn<(text: string, detail?: string) => void>() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ done: vi.fn(), warn, failed: vi.fn() }) }));

import { CopyValue } from './CopyValue';

let written: string[];
const clipboard = (works: boolean) => {
  written = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: vi.fn(async (t: string) => {
        if (!works) throw new Error('denied');
        written.push(t);
      }),
    },
  });
  document.execCommand = vi.fn(() => false);
};

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  delete (document as { execCommand?: unknown }).execCommand;
});

describe('the tooltip', () => {
  it('— is «نسخ <noun>» unless the screen says another, and the accessible name does not change either way', () => {
    clipboard(true);
    const { unmount } = render(<CopyValue text="K1" noun="باركود الشحنة" shown="K1" />);
    expect(screen.getByRole('button', { name: 'نسخ باركود الشحنة K1' }).getAttribute('title')).toBe('نسخ باركود الشحنة');
    unmount();
    render(<CopyValue text="K1" noun="باركود الشحنة" shown="K1" title="انسخ الباركود" />);
    const button = screen.getByRole('button', { name: 'نسخ باركود الشحنة K1' });
    expect(button.getAttribute('title')).toBe('انسخ الباركود');
  });

  it('— and a copy that worked still says «تم النسخ» on the button, whatever tooltip it had', async () => {
    clipboard(true);
    render(<CopyValue text="K1" noun="باركود الشحنة" title="انسخ الباركود" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByRole('button').getAttribute('title')).toBe('تم النسخ'));
    expect(written).toEqual(['K1']);
  });
});

describe('a copy the browser refuses', () => {
  it('— goes to the screen’s own hand, with the text; no warning is raised', async () => {
    clipboard(false);
    const refused = vi.fn();
    render(<CopyValue text="K1" noun="باركود الشحنة" onRefused={refused} />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(refused).toHaveBeenCalledTimes(1));
    expect(refused).toHaveBeenCalledWith('K1');
    expect(warn).not.toHaveBeenCalled();
  });

  it('— and without one it is the warning that carries the text, exactly as before', async () => {
    clipboard(false);
    render(<CopyValue text="K1" noun="باركود الشحنة" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith('تعذّر النسخ — انسخه يدوياً', 'K1');
  });

  it('— and a copy that worked never calls it', async () => {
    clipboard(true);
    const refused = vi.fn();
    render(<CopyValue text="K1" noun="باركود الشحنة" onRefused={refused} />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(written).toEqual(['K1']));
    expect(refused).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
