// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { IconButton } from './IconButton';

/**
 * R2a (18/11) — AN ICON BUTTON HAS A NAME, A STATED SIZE, AND THE SAME LOCK.
 *
 * Class names below are cut into pieces: Tailwind scans test files.
 */

const j = (...p: string[]) => p.join('');
const tokens = (el: Element) => new Set(el.className.split(/\s+/).filter(Boolean));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const Pencil = () => <svg data-testid="icon" width="16" height="16" />;

describe('the name', () => {
  it('is the label, for a screen reader and as the tooltip', () => {
    render(
      <IconButton label="تعديل المنتج">
        <Pencil />
      </IconButton>
    );
    const btn = screen.getByRole('button', { name: 'تعديل المنتج' });
    expect(btn.getAttribute('aria-label')).toBe('تعديل المنتج');
    expect(btn.getAttribute('title')).toBe('تعديل المنتج');
  });

  it('and the picture is hidden from a reader, so the name is not read twice', () => {
    render(
      <IconButton label="حذف">
        <Pencil />
      </IconButton>
    );
    expect(screen.getByTestId('icon').closest('[aria-hidden="true"]')).toBeTruthy();
  });

  it('is REQUIRED by the type (a call without it does not compile)', () => {
    // The negative half of the guarantee, checked by `tsc`: the directive
    // below is itself an error if the line under it ever compiles.
    // @ts-expect-error -- label is required
    const bad = <IconButton>{<Pencil />}</IconButton>;
    expect(bad).toBeTruthy();
  });

  it('and an empty one is said out loud in development, and gives no fake name', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <IconButton label="   ">
        <Pencil />
      </IconButton>
    );
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toContain('IconButton');
    expect(screen.getByRole('button').getAttribute('aria-label')).toBeNull();
  });

  it('and a good label raises no warning', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <IconButton label="حذف">
        <Pencil />
      </IconButton>
    );
    expect(err).not.toHaveBeenCalled();
  });

  it('and the caller cannot replace the name with a title of its own', () => {
    // `title` and `aria-label` are omitted from the props by type; a JS
    // caller that sneaks one in still loses to the label.
    const sneaky = { title: 'اسم ثانٍ', 'aria-label': 'اسم ثالث' };
    render(
      <IconButton {...sneaky} label="الاسم الصحيح">
        <Pencil />
      </IconButton>
    );
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('الاسم الصحيح');
  });
});

describe('the size: a square, 44 on a phone', () => {
  it('states the width beside the height, in the same two steps', () => {
    const want: Record<'sm' | 'md' | 'lg', string[]> = {
      sm: ['h-11', 'w-11', 'md:h-8', 'md:w-8'],
      md: ['h-11', 'w-11', 'md:h-10', 'md:w-10'],
      lg: ['h-11', 'w-11'],
    };
    for (const size of ['sm', 'md', 'lg'] as const) {
      render(
        <IconButton label="x" size={size}>
          <Pencil />
        </IconButton>
      );
      const set = tokens(screen.getByRole('button'));
      for (const t of want[size]) expect(set.has(t), `${size}: ${t}`).toBe(true);
      // No horizontal padding that could compete with the stated width.
      expect([...set].filter((t) => /^(?:md:)?px-/.test(t)), `${size}: padding أفقي`).toEqual([]);
      cleanup();
    }
  });

  it('is 40 on a desk when no size is named', () => {
    render(
      <IconButton label="x">
        <Pencil />
      </IconButton>
    );
    const set = tokens(screen.getByRole('button'));
    expect(set.has('md:h-10')).toBe(true);
    expect(set.has('md:w-10')).toBe(true);
    expect(set.has('md:h-8')).toBe(false);
  });

  it('has no invisible growth past its edge (the hit area IS the control)', () => {
    render(
      <IconButton label="x">
        <Pencil />
      </IconButton>
    );
    const set = tokens(screen.getByRole('button'));
    // The earlier attempt grew a pseudo-element under the button; it
    // overlapped the next row. Nothing here reaches past the box.
    expect([...set].filter((t) => /(?:^|:)(?:before|after):|-m[xy]?-|^-m/.test(t))).toEqual([]);
    expect(set.has('relative')).toBe(true);
  });

  it('is quiet unless it is told otherwise, and takes the other looks', () => {
    render(
      <IconButton label="x">
        <Pencil />
      </IconButton>
    );
    expect(tokens(screen.getByRole('button')).has('bg-transparent')).toBe(true);
    cleanup();
    render(
      <IconButton label="x" variant="danger">
        <Pencil />
      </IconButton>
    );
    expect(tokens(screen.getByRole('button')).has(j('bg-[var(--sys-', 'destructive)]'))).toBe(true);
  });
});

describe('it is a button underneath', () => {
  it('is pressed by Enter and by Space', async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    render(
      <IconButton label="حذف" onClick={run}>
        <Pencil />
      </IconButton>
    );
    await user.tab();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('disabled is not pressable, loading is busy and not pressable', async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    const { rerender } = render(
      <IconButton label="حذف" disabled onClick={run}>
        <Pencil />
      </IconButton>
    );
    await user.click(screen.getByRole('button'));
    expect(run).not.toHaveBeenCalled();
    rerender(
      <IconButton label="حذف" loading onClick={run}>
        <Pencil />
      </IconButton>
    );
    const btn = screen.getByRole('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    await user.click(btn);
    expect(run).not.toHaveBeenCalled();
  });

  it('a promise locks it against a second press — the same code as Button', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>((r) => (release = r)));
    render(
      <IconButton label="حذف" onClick={run}>
        <Pencil />
      </IconButton>
    );
    await user.click(screen.getByRole('button'));
    await user.click(screen.getByRole('button'));
    expect(run).toHaveBeenCalledTimes(1);
    await act(async () => release());
  });

  it('keeps its name and size inside a right-to-left page', () => {
    render(
      <div dir="rtl">
        <IconButton label="إغلاق">
          <Pencil />
        </IconButton>
      </div>
    );
    expect(screen.getByRole('button', { name: 'إغلاق' })).toBeTruthy();
    expect(tokens(screen.getByRole('button')).has('w-11')).toBe(true);
  });
});
