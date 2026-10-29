// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE ROW THAT ENDS A CONFIRMATION DIALOG IS IN ITS FOOTER, AT 44px.
 *
 * Postpone, issue, change-request and cancel are the dialogs an agent opens
 * most on a phone, and their buttons were two hand-made `py-2` boxes —
 * about 36px tall, eight apart — at the bottom of the scrolling form. They
 * now go through the shared Button (44px on a phone, locked while the
 * request is in the air) and into the Modal's footer.
 *
 * Moving the row OUT of the `<form>` is the risk this file is about: a
 * submit button outside its form submits nothing unless it names it. So
 * every claim here presses the button and reads what the dialog sent.
 * ═══════════════════════════════════════════════════════════════════════
 */

vi.mock('@/hooks/useProducts', () => ({ useProducts: () => ({ products: [], loading: false }) }));
vi.mock('@/hooks/useRegions', () => ({ useRegions: () => ({ regions: [], loading: false }) }));

import { PostponeDialog, IssueDialog, RejectDialog, ChangeRequestDialog } from './ActionDialogs';

afterEach(cleanup);

const dialog = () => screen.getByRole('dialog');
const formOf = () => dialog().querySelector('form') as HTMLFormElement;
const has = (el: Element, c: string) => el.classList.contains(c);

describe('the submit button is out of the form and still submits it', () => {
  it('postpone: pressing «تأجيل» sends the form', () => {
    const onSubmit = vi.fn();
    render(<PostponeDialog open orderNumber="ORD-1" postponeCount={0} onClose={() => {}} onSubmit={onSubmit} />);
    const send = screen.getByRole('button', { name: 'تأجيل' });
    expect(formOf().contains(send), 'الزر داخل النموذج').toBe(false);
    expect((send as HTMLButtonElement).form, 'الزر لا ينتمي للنموذج').toBe(formOf());
    send.click();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('issue: pressing «فتح الإشكال» sends the form', () => {
    const onSubmit = vi.fn();
    render(<IssueDialog open orderNumber="ORD-1" onClose={() => {}} onSubmit={onSubmit} />);
    const send = screen.getByRole('button', { name: 'فتح الإشكال' });
    expect(formOf().contains(send)).toBe(false);
    send.click();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ reason: 'MISSING_DATA' });
  });

  it('cancel: pressing «ألغِ الطلب» sends the form, with its reason', () => {
    const onSubmit = vi.fn();
    render(<RejectDialog open orderNumber="ORD-1" onClose={() => {}} onSubmit={onSubmit} />);
    const send = screen.getByRole('button', { name: 'ألغِ الطلب' });
    expect(formOf().contains(send)).toBe(false);
    send.click();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ rejectionReason: 'CUSTOMER_CHANGED_MIND' });
  });

  it('Enter in a field still sends it — the form has a submit button of its own, out in the footer', () => {
    const onSubmit = vi.fn();
    render(<IssueDialog open orderNumber="ORD-1" onClose={() => {}} onSubmit={onSubmit} />);
    fireEvent.submit(formOf());
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('change request: «إرسال الطلب» stays shut until an EDIT has a new value, as before', () => {
    render(<ChangeRequestDialog open orderNumber="ORD-1" onClose={() => {}} onSubmit={() => {}} />);
    const send = screen.getByRole('button', { name: 'إرسال الطلب' }) as HTMLButtonElement;
    expect(formOf().contains(send)).toBe(false);
    expect(send.disabled, 'فُتح بلا قيمة جديدة').toBe(true);
  });
});

describe('the row itself', () => {
  it('is two 44px buttons that share the phone’s width', () => {
    render(<PostponeDialog open orderNumber="ORD-1" postponeCount={0} onClose={() => {}} onSubmit={() => {}} />);
    for (const name of ['تأجيل', 'إلغاء']) {
      const b = screen.getByRole('button', { name });
      expect(has(b, 'h-11'), `${name}: أقل من 44`).toBe(true);
      expect(has(b, 'flex-1'), `${name}: ما تقاسم العرض`).toBe(true);
      expect(has(b, 'md:flex-none')).toBe(true);
    }
  });

  it('cancelling a dialog closes it', () => {
    const onClose = vi.fn();
    render(<PostponeDialog open orderNumber="ORD-1" postponeCount={0} onClose={onClose} onSubmit={() => {}} />);
    screen.getByRole('button', { name: 'إلغاء' }).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('while the request is in the air the submit is locked, and cancel is not', () => {
    render(<PostponeDialog open busy orderNumber="ORD-1" postponeCount={0} onClose={() => {}} onSubmit={() => {}} />);
    const send = screen.getByRole('button', { name: 'تأجيل' }) as HTMLButtonElement;
    expect(send.disabled, 'ضغطة ثانية ممكنة').toBe(true);
    expect(send.getAttribute('aria-busy')).toBe('true');
    expect((screen.getByRole('button', { name: 'إلغاء' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('the cancellation is drawn as a destructive decision, with its own word for backing out', () => {
    render(<RejectDialog open orderNumber="ORD-1" onClose={() => {}} onSubmit={() => {}} />);
    const send = screen.getByRole('button', { name: 'ألغِ الطلب' });
    expect(send.className).toContain('--sys-destructive');
    expect(screen.getByRole('button', { name: 'تراجع' })).toBeTruthy();
  });
});
