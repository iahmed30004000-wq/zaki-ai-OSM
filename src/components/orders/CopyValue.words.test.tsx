// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * THE ONE COPY BUTTON, TOLD THREE THINGS — and nothing else about it changed.
 *
 * `title`: a screen whose button holds a value the plain «نسخ <noun>» does not name («انسخ الباركود»).
 * `onRefused`: a screen that hands a refused copy to something better than a warning that goes away (a dialog with the
 * value in a field to select by hand).
 * `whenEmpty`: a screen whose owner wants the button to stay in its place and be OFF when there is nothing to copy (the
 * shipment follow-up's barcode, 10/11).
 *
 * Left out, all three are what they always were: the tooltip «نسخ <noun>», the warning toast that carries the value, and an
 * empty value drawing nothing — `OrderRef.test.tsx` holds the rest of the button.
 */

const { warn } = vi.hoisted(() => ({ warn: vi.fn<(text: string, detail?: string) => void>() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ done: vi.fn(), warn, failed: vi.fn() }) }));

import { CopyValue } from './CopyValue';

// What a test awaits it may wait eight seconds for: a loaded machine is not a failing test.
configure({ asyncUtilTimeout: 8000 });

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

describe('an empty value', () => {
  it('— draws NOTHING, as it always did, unless the screen says what an OFF button should say', () => {
    clipboard(true);
    const { container } = render(<CopyValue text="" noun="باركود الشحنة" />);
    expect(container.querySelector('button')).toBeNull();
  });

  it('— with `whenEmpty` is drawn OFF: not pressable, dimmed, and the sentence is its tooltip and part of its name', () => {
    clipboard(true);
    render(<CopyValue text="" noun="باركود الشحنة" whenEmpty="ما في باركود للشحنة" />);
    const button = screen.getByRole('button', { name: 'نسخ باركود الشحنة — ما في باركود للشحنة' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title')).toBe('ما في باركود للشحنة');
    expect(button.className).toMatch(/opacity/);
    // The same size as the live one, so the row does not jump when a barcode arrives.
    expect(button.className).toMatch(/\bh-11\b/);
  });

  it('— and pressing it copies nothing and raises nothing', async () => {
    clipboard(true);
    const refused = vi.fn();
    render(<CopyValue text="" noun="باركود الشحنة" whenEmpty="ما في باركود للشحنة" onRefused={refused} />);
    fireEvent.click(screen.getByRole('button'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(written).toEqual([]);
    expect(refused).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('— and a value that is there is the plain pressable button, whatever `whenEmpty` says', async () => {
    clipboard(true);
    render(<CopyValue text="K1" noun="باركود الشحنة" shown="K1" whenEmpty="ما في باركود للشحنة" />);
    const button = screen.getByRole('button', { name: 'نسخ باركود الشحنة K1' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(written).toEqual(['K1']));
  });
});
