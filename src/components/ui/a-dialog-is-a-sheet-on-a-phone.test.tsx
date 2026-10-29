// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { Modal } from './Modal';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A DIALOG IS A SHEET FROM THE BOTTOM ON A PHONE — AND ITS BUTTONS STAY.
 *
 * At 375px the centred dialog lost 80px to margins before any card inside
 * it added its own, `90vh` reached under the browser's toolbar on iOS, and
 * a form tall enough to scroll had «حفظ» at the very bottom of the part
 * that scrolls — the last thing to reach with the keyboard open.
 *
 * jsdom draws no layout, so the measurement lives in the PR. What is pinned
 * here is what the measurement came down to, read off the RENDERED dialog:
 * the classes that make it a sheet below `sm` and a dialog from it, the
 * unit that follows the visible screen, and the footer that sits OUTSIDE
 * the scrolling body.
 *
 * The retired unit is spelled from parts: this file is scanned by the
 * stylesheet's generator, and a literal here would put the class back.
 * ═══════════════════════════════════════════════════════════════════════
 */

afterEach(cleanup);

const OLD_VH = ['max-h-[90', 'vh]'].join('');
const NEW_DVH = ['max-h-[90', 'dvh]'].join('');

function open(props: Partial<Omit<React.ComponentProps<typeof Modal>, 'children'>> = {}) {
  render(
    <Modal isOpen onClose={() => {}} title="عنوان" {...props}>
      <p>المحتوى</p>
    </Modal>
  );
  const panel = screen.getByRole('dialog');
  const scrim = panel.parentElement as HTMLElement;
  const body = panel.querySelector('[data-modal-body]') as HTMLElement;
  return { panel, scrim, body };
}

describe('the centred dialog', () => {
  it('sits at the bottom edge with no margin on a phone, and centres with a margin from sm', () => {
    const { scrim } = open();
    expect(scrim.classList.contains('items-end'), 'لا ورقة سفلية على الجوال').toBe(true);
    expect(scrim.classList.contains('sm:items-center')).toBe(true);
    expect(scrim.classList.contains('sm:p-4')).toBe(true);
    // The old fixed margin and the old centring at every width are gone.
    expect(scrim.classList.contains('p-4'), 'الهامش بقي على الجوال').toBe(false);
    expect(scrim.classList.contains('items-center')).toBe(false);
  });

  it('is rounded on top only on a phone, all round from sm, and clears the home bar', () => {
    const { panel } = open();
    expect(panel.classList.contains('rounded-t-lg')).toBe(true);
    expect(panel.classList.contains('sm:rounded-lg')).toBe(true);
    expect(panel.classList.contains('rounded-lg')).toBe(false);
    expect(panel.classList.contains('pb-[env(safe-area-inset-bottom)]')).toBe(true);
  });

  it('is as tall as the VISIBLE screen allows, not the one with the toolbar tucked away', () => {
    const { panel } = open();
    expect(panel.classList.contains(NEW_DVH), 'الارتفاع لا يتبع الشاشة المرئية').toBe(true);
    expect(panel.classList.contains(OLD_VH), 'الوحدة القديمة رجعت').toBe(false);
  });

  it('keeps 16px of margin inside on a phone, 24px from sm — header and body alike', () => {
    const { panel, body } = open();
    expect(body.classList.contains('p-4')).toBe(true);
    expect(body.classList.contains('sm:p-6')).toBe(true);
    expect(body.classList.contains('p-6'), 'هامش الجسم 24 على الجوال').toBe(false);
    const header = panel.querySelector('h3')!.parentElement!.parentElement as HTMLElement;
    expect(header.classList.contains('px-4')).toBe(true);
    expect(header.classList.contains('sm:px-6')).toBe(true);
    expect(header.classList.contains('px-6'), 'هامش الرأس 24 على الجوال').toBe(false);
  });

  it('marks its scrolling body, so nobody has to find it by the class names it wears', () => {
    const { body } = open();
    expect(body).toBeTruthy();
    expect(body.classList.contains('overflow-y-auto')).toBe(true);
    expect(body.textContent).toContain('المحتوى');
  });
});

describe('the footer', () => {
  it('is drawn outside the scrolling body, inside the dialog', () => {
    const { panel, body } = open({ footer: <button type="button">احفظ</button> });
    const save = screen.getByText('احفظ');
    expect(panel.contains(save), 'الزر خارج الحوار').toBe(true);
    expect(body.contains(save), 'الزر داخل الجزء الذي يتمرّر — يضيع بالتمرير').toBe(false);
    const footer = save.parentElement as HTMLElement;
    expect(footer.classList.contains('border-t')).toBe(true);
    expect(footer.classList.contains('shrink-0'), 'التذييل ينضغط').toBe(true);
  });

  it('is not drawn at all when the dialog has none — no empty bar, no stray border', () => {
    const { panel } = open();
    expect(panel.querySelectorAll('.border-t').length).toBe(0);
    // header + body, nothing else.
    expect(panel.children.length).toBe(2);
  });

  it('and a submit button out there still submits the form in the body', () => {
    let sent = 0;
    render(
      <Modal
        isOpen
        onClose={() => {}}
        title="عنوان"
        footer={
          <button type="submit" form="f1">
            أرسل
          </button>
        }
      >
        <form
          id="f1"
          onSubmit={(e) => {
            e.preventDefault();
            sent += 1;
          }}
        >
          <input aria-label="حقل" />
        </form>
      </Modal>
    );
    screen.getByText('أرسل').click();
    expect(sent, 'زر التذييل ما أرسل النموذج').toBe(1);
  });
});

describe('the other two edges are left as they were', () => {
  it('a bottom sheet is still a bottom sheet, with its own height', () => {
    const { panel } = open({ side: 'bottom' });
    expect(panel.classList.contains('rounded-t-lg')).toBe(true);
    expect(panel.classList.contains(NEW_DVH)).toBe(false);
  });

  it('a side panel is still full height', () => {
    const { panel } = open({ side: 'end' });
    expect(panel.classList.contains('h-full')).toBe(true);
  });
});
