// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE RAISE DIALOG ASKS NOTHING OF AN ORDER ON AN OPEN TROLLEY (the owner's ruling 4/11).
 *
 * The door refuses every intent with ON_OPEN_TROLLEY, and the dialog reads the same gate (`refusalFor`): each of the three
 * buttons is greyed with the sentence, the sentence is said once, and nothing is sent — not by the button, not by Enter.
 * Without the flag it is the dialog it always was.
 * ═══════════════════════════════════════════════════════════════════════
 */

vi.mock('@/hooks/useProducts', () => ({ useProducts: () => ({ products: [], loading: false }) }));
vi.mock('@/hooks/useRegions', () => ({ useRegions: () => ({ regions: [], loading: false }) }));

import { ON_TROLLEY_AR } from '@/lib/order-seal';
import { ChangeRequestDialog } from './ActionDialogs';

afterEach(cleanup);

const formOf = () => screen.getByRole('dialog').querySelector('form') as HTMLFormElement;
const intentButton = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('on an open trolley', () => {
  it('greys all three asks with the one sentence, and says it', () => {
    render(<ChangeRequestDialog open orderNumber="ORD-2026-1584" onOpenTrolley onClose={() => {}} onSubmit={() => {}} />);

    for (const name of ['تعديل', 'إلغاء', 'تأجيل']) {
      const b = screen.getAllByRole('button', { name }).find((el) => el.getAttribute('title') !== null) as HTMLButtonElement;
      expect(b, name).toBeTruthy();
      expect(b.disabled, name).toBe(true);
      expect(b.title, name).toBe(ON_TROLLEY_AR);
    }
    expect(screen.getByRole('alert').textContent).toBe(ON_TROLLEY_AR);
  });

  it('sends nothing — the button is shut even with a value typed, and Enter submits nothing', () => {
    const onSubmit = vi.fn();
    render(<ChangeRequestDialog open orderNumber="ORD-2026-1584" onOpenTrolley onClose={() => {}} onSubmit={onSubmit} />);

    const value = screen.getByRole('dialog').querySelector('input:not([type="hidden"])') as HTMLInputElement | null;
    if (value) fireEvent.change(value, { target: { value: 'شارع جديد' } });
    const send = intentButton('إرسال الطلب');
    expect(send.disabled).toBe(true);
    send.click();
    fireEvent.submit(formOf());

    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('NEGATIVE: off the trolley', () => {
  it('the three asks are offered as before, and no trolley sentence is said', () => {
    render(<ChangeRequestDialog open orderNumber="ORD-1" onClose={() => {}} onSubmit={() => {}} />);

    for (const name of ['تعديل', 'تأجيل']) {
      const b = screen.getAllByRole('button', { name })[0] as HTMLButtonElement;
      expect(b.disabled, name).toBe(false);
    }
    expect(screen.queryByText(ON_TROLLEY_AR)).toBeNull();
  });
});
