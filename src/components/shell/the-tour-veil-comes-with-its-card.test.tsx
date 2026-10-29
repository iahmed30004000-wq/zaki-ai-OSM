// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE TOUR'S VEIL COMES WITH ITS CARD, ITS KEYBOARD STAYS IN IT, AND IT
 * DOES NOT OPEN OVER A DIALOG.
 *
 * Three faults, one component:
 *
 *   1. The veil was drawn the moment the tour opened, the card only once its
 *      anchor had been measured. If the anchor was gone between two steps
 *      the screen stayed dimmed, every press was swallowed, and there was
 *      nothing to press — Escape was the only way out.
 *   2. Tab walked straight out of the card into the dimmed page behind it.
 *   3. A dialog already open at first paint sat UNDER the veil (z-50 under
 *      z-60) and could not be pressed.
 *
 * The first-run-tour-runs-once file owns «once»; this one owns the three
 * above.
 * ═══════════════════════════════════════════════════════════════════════
 */

const user: { current: { id: string; name: string; tourDoneAt?: string | null } | null } = {
  current: { id: 'u1', name: 'سامر', tourDoneAt: null },
};

vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: user.current, refreshUser: async () => undefined }),
}));
vi.mock('@/lib/api-client', () => ({ apiJson: vi.fn(async () => ({})) }));

import { FirstRunTour } from './FirstRunTour';

function Frame({ guide = true, children }: { guide?: boolean; children?: React.ReactNode }) {
  return (
    <div>
      <aside data-tour="sidebar">القائمة</aside>
      <div data-tour="context">المتجر</div>
      <button data-tour="search">ابحث</button>
      {guide && <button data-tour="guide">ⓘ</button>}
      {children}
      <FirstRunTour />
    </div>
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  user.current = { id: 'u1', name: 'سامر', tourDoneAt: null };
});
afterEach(cleanup);

const tour = () => screen.queryByTestId('first-run-tour');
/** The dimming layer: the only <div> in the tour that is hidden from a screen reader. */
const veil = () => tour()?.querySelector('div[aria-hidden="true"]') ?? null;
const card = () => screen.queryByRole('dialog', { name: 'الجولة الأولى' });

describe('the veil and the card are one thing', () => {
  it('both are on the screen while the tour runs', () => {
    render(<Frame />);
    expect(card()).toBeTruthy();
    expect(veil(), 'ما في ستارة').toBeTruthy();
  });

  it('and the veil is written INSIDE the card’s own condition — the moment before the anchor is measured has none', () => {
    // A render cannot show this: the anchor is measured in an effect that runs before anything is
    // painted in jsdom. It is the one claim here that reads the source, and it reads the shape, not a name.
    const src = readFileSync(join(process.cwd(), 'src/components/shell/FirstRunTour.tsx'), 'utf8');
    expect(src, 'الستارة خرجت من شرط البطاقة').toMatch(
      /\{rect && \(\s*<>\s*<div className="fixed inset-0 z-\[60\][^"]*" aria-hidden \/>/
    );
  });

  it('when the last step’s anchor has gone, the walk ends — with no veil left over', () => {
    const { rerender } = render(<Frame />);
    // The ⓘ leaves the page while the person reads the first step.
    rerender(<Frame guide={false} />);
    fireEvent.click(screen.getByText('التالي'));
    fireEvent.click(screen.getByText('التالي'));
    fireEvent.click(screen.getByText('التالي'));
    // Four steps were planned; the fourth points at nothing, so it closes.
    expect(card(), 'البطاقة بقيت تشاور على لا شي').toBeNull();
    expect(veil(), 'الستارة بقيت لحالها وبتاكل كل ضغطة').toBeNull();
  });

  it('when a middle anchor has gone, the walk moves on to the next step instead of stopping', () => {
    function Host() {
      const [shown, setShown] = React.useState(true);
      return (
        <div>
          <aside data-tour="sidebar">القائمة</aside>
          {shown && <div data-tour="context">المتجر</div>}
          <button data-tour="search">ابحث</button>
          <button data-tour="guide">ⓘ</button>
          <button data-testid="hide" onClick={() => setShown(false)} />
          <FirstRunTour />
        </div>
      );
    }
    render(<Host />);
    fireEvent.click(screen.getByTestId('hide'));
    fireEvent.click(screen.getByText('التالي'));
    // Step 2 pointed at the store chip, which is gone: the search step shows.
    expect(screen.getByText(/يلاقي كل شي/)).toBeTruthy();
    expect(card()).toBeTruthy();
    expect(veil()).toBeTruthy();
  });
});

describe('Tab stays inside the card', () => {
  const stops = () => [
    screen.getByText('تخطّي'),
    screen.getByText('التالي').closest('button')!,
    screen.getByRole('checkbox'),
  ];

  it('from the last control it wraps to the first', () => {
    render(<Frame />);
    const [skip, , checkbox] = stops();
    checkbox.focus();
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(skip);
  });

  it('Shift+Tab from the first control wraps to the last', () => {
    render(<Frame />);
    const [skip, , checkbox] = stops();
    skip.focus();
    const ev = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(checkbox);
  });

  it('Tab from the card itself, or from outside it, lands on its first control', () => {
    render(<Frame />);
    const [skip] = stops();
    (document.activeElement as HTMLElement | null)?.blur();
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(ev);
    });
    expect(document.activeElement).toBe(skip);
  });

  it('a Tab in the middle of the card is left to the browser', () => {
    render(<Frame />);
    const [, next] = stops();
    next.focus();
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented, 'التبويب انحبس وسط البطاقة').toBe(false);
  });
});

describe('it does not open over somebody’s dialog', () => {
  it('a dialog already open at first paint means no tour this visit', () => {
    render(
      <Frame>
        <div role="dialog" aria-modal="true" aria-label="نافذة مفتوحة" />
      </Frame>
    );
    expect(card(), 'الجولة فتحت فوق نافذة').toBeNull();
    expect(veil()).toBeNull();
    // And it did not spend the skip: nothing was written to the session.
    expect(window.sessionStorage.length).toBe(0);
  });

  it('with no dialog open, it opens as before', () => {
    render(<Frame />);
    expect(card()).toBeTruthy();
  });
});
