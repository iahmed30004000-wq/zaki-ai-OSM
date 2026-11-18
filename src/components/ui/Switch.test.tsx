// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useState } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Switch } from './Switch';
import { Modal } from './Modal';

/**
 * AN ON/OFF THAT IS A REQUEST (R2b, 18/11).
 *
 * A tick box is held until «save». A switch is already true, so it is a
 * request to the server — and a request can be slow or refused. These pin
 * the three things that follow: it waits, it cannot be pressed twice while
 * it waits, and a refusal is said in words under it rather than swallowed.
 */

const vibrate = vi.fn();
Object.defineProperty(navigator, 'vibrate', { configurable: true, value: vibrate });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function pending<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A switch whose value lives in the screen, set only when `save` says so. */
function Harness({
  save,
  ...rest
}: { save?: (next: boolean) => unknown } & Partial<React.ComponentProps<typeof Switch>>) {
  const [on, setOn] = useState(false);
  return (
    <>
      <Switch
        label="تفعيل الإشعارات"
        {...rest}
        checked={on}
        onChange={(next) => {
          const r = save ? save(next) : undefined;
          if (r && typeof (r as Promise<unknown>).then === 'function') {
            return (r as Promise<unknown>).then(() => setOn(next));
          }
          setOn(next);
          return r;
        }}
      />
      <span data-testid="now">{String(on)}</span>
    </>
  );
}
const now = () => screen.getByTestId('now').textContent;
const box = () => screen.getByRole('switch') as HTMLInputElement;

describe('the switch', () => {
  it('is a real checkbox input that says it is a switch, and what it is set to', () => {
    render(<Harness />);
    expect(box().tagName).toBe('INPUT');
    expect(box().getAttribute('type')).toBe('checkbox');
    expect(box().getAttribute('role')).toBe('switch');
    expect(box().getAttribute('aria-checked')).toBe('false');
    expect(box().checked).toBe(false);
    expect(screen.queryAllByRole('checkbox').length, 'المفتاح يُعلَن مربّعَ اختيار').toBe(0);
  });

  it('follows the screen: aria-checked and the box say the same thing', () => {
    const { rerender } = render(<Switch label="س" checked={false} onChange={() => {}} />);
    expect(box().getAttribute('aria-checked')).toBe('false');
    rerender(<Switch label="س" checked onChange={() => {}} />);
    expect(box().getAttribute('aria-checked')).toBe('true');
    expect(box().checked).toBe(true);
  });

  it('has a name from its words, or from aria-label', () => {
    render(<Harness />);
    expect(screen.getByRole('switch', { name: 'تفعيل الإشعارات' })).toBeTruthy();
    cleanup();
    render(<Harness label={undefined} aria-label="الإشعارات" />);
    expect(screen.getByRole('switch', { name: 'الإشعارات' })).toBeTruthy();
  });

  it('points its label at itself', () => {
    render(<Harness />);
    const label = box().closest('label')!;
    expect(label.getAttribute('for')).toBe(box().id);
    expect(box().id).not.toBe('');
  });
});

describe('pressing it', () => {
  it('toggles when the WORDS are pressed', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByText('تفعيل الإشعارات'));
    expect(now()).toBe('true');
    await user.click(screen.getByText('تفعيل الإشعارات'));
    expect(now()).toBe('false');
  });

  it('toggles on Space, reached with one Tab', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.tab();
    expect(document.activeElement).toBe(box());
    await user.keyboard(' ');
    expect(now(), 'المسطرة لم تقلب المفتاح').toBe('true');
  });

  it('passes the value being asked for, not the value it had', async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    render(<Harness save={save} />);
    await user.click(box());
    await user.click(box());
    expect(save.mock.calls.map((c) => c[0])).toEqual([true, false]);
  });

  it('shows no busy state for a change that is not a promise', async () => {
    const user = userEvent.setup();
    render(<Harness save={() => undefined} />);
    await user.click(box());
    expect(box().getAttribute('aria-busy')).toBeNull();
    expect(box().getAttribute('aria-disabled')).toBeNull();
  });
});

describe('a change still in the air', () => {
  it('shows it is working, says so aloud, and keeps the OLD value until the screen changes it', async () => {
    const p = pending();
    const save = vi.fn(() => p.promise);
    render(<Harness save={save} />);
    await act(async () => {
      fireEvent.click(box());
    });
    expect(box().getAttribute('aria-busy')).toBe('true');
    expect(box().getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('جارٍ الحفظ');
    expect(now(), 'المفتاح قلب قبل أن يردّ الخادم').toBe('false');
    expect(box().checked).toBe(false);

    await act(async () => {
      p.resolve();
    });
    expect(box().getAttribute('aria-busy')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('');
    expect(now()).toBe('true');
    expect(box().checked).toBe(true);
  });

  it('cannot be pressed a second time — even three presses in one breath', async () => {
    const p = pending();
    const save = vi.fn(() => p.promise);
    render(<Harness save={save} />);
    await act(async () => {
      fireEvent.click(box());
      fireEvent.click(box());
      fireEvent.click(box());
    });
    expect(save, 'ضغطةٌ ثانية أرسلت طلباً ثانياً').toHaveBeenCalledTimes(1);
    // And a press on the words, and on the keyboard, while it is still out.
    await act(async () => {
      fireEvent.click(screen.getByText('تفعيل الإشعارات'));
      fireEvent.keyDown(box(), { key: ' ' });
      fireEvent.click(box());
    });
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => {
      p.resolve();
    });
  });

  it('can be pressed again once it has finished', async () => {
    const p1 = pending();
    const p2 = pending();
    const save = vi.fn().mockReturnValueOnce(p1.promise).mockReturnValueOnce(p2.promise);
    render(<Harness save={save} />);
    await act(async () => {
      fireEvent.click(box());
    });
    await act(async () => {
      p1.resolve();
    });
    await act(async () => {
      fireEvent.click(box());
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0], 'الضغطة الثانية طلبت الإيقاف').toBe(false);
    await act(async () => {
      p2.resolve();
    });
  });

  it('keeps the keyboard where it was — a pending switch is not a disabled one', async () => {
    const p = pending();
    render(<Harness save={() => p.promise} />);
    box().focus();
    await act(async () => {
      fireEvent.click(box());
    });
    expect(box().disabled, 'disabled يسحب التركيز من المفتاح').toBe(false);
    expect(document.activeElement).toBe(box());
    await act(async () => {
      p.resolve();
    });
  });

  it('does not touch a screen that has gone away', async () => {
    const p = pending();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = render(<Harness save={() => p.promise} />);
    await act(async () => {
      fireEvent.click(box());
    });
    unmount();
    await act(async () => {
      p.reject(new Error('x'));
    });
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('a change that was refused', () => {
  it('stays where it was and says so in a line under it', async () => {
    const save = vi.fn(() => Promise.reject(new Error('no')));
    render(<Harness save={save} />);
    await act(async () => {
      fireEvent.click(box());
    });
    expect(now(), 'المفتاح قلب رغم الرفض').toBe('false');
    expect(box().getAttribute('aria-busy')).toBeNull();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('تعذّر الحفظ، حاول مرة ثانية');
    expect(box().getAttribute('aria-describedby')).toBe(alert.id);
    expect(alert.className).toContain('destructive');
  });

  it('says what the screen said to say', async () => {
    render(<Harness failureText="الخادم غير متاح" save={() => Promise.reject(new Error('no'))} />);
    await act(async () => {
      fireEvent.click(box());
    });
    expect(screen.getByRole('alert').textContent).toBe('الخادم غير متاح');
  });

  it('is felt as well as seen', async () => {
    render(<Harness save={() => Promise.reject(new Error('no'))} />);
    await act(async () => {
      fireEvent.click(box());
    });
    expect(vibrate, 'لا اهتزاز عند الرفض').toHaveBeenCalled();
  });

  it('a thrown error is a refusal too', async () => {
    render(
      <Harness
        save={() => {
          throw new Error('sync');
        }}
      />
    );
    await act(async () => {
      fireEvent.click(box());
    });
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(box().getAttribute('aria-busy')).toBeNull();
  });

  it('is cleared by the next try, and does not come back if that one works', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('no')).mockResolvedValueOnce(undefined);
    render(<Harness save={save} />);
    await act(async () => {
      fireEvent.click(box());
    });
    expect(screen.queryByRole('alert')).not.toBeNull();
    await act(async () => {
      fireEvent.click(box());
    });
    expect(screen.queryByRole('alert'), 'الفشل القديم بقي بعد نجاح').toBeNull();
    expect(now()).toBe('true');
  });

  it('a success says nothing in red', async () => {
    render(<Harness save={() => Promise.resolve()} />);
    await act(async () => {
      fireEvent.click(box());
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(vibrate).toHaveBeenCalled();
  });
});

describe('a switch that cannot be pressed', () => {
  it('ignores the label, the box and the keyboard', async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    render(<Harness disabled save={save} />);
    expect(box().disabled).toBe(true);
    await user.click(screen.getByText('تفعيل الإشعارات'));
    await user.click(box());
    await user.tab();
    await user.keyboard(' ');
    expect(save, 'المعطَّل استجاب').not.toHaveBeenCalled();
    expect(now()).toBe('false');
  });
});

describe('the hint and the error', () => {
  it('a hint is tied to the switch', () => {
    render(<Harness hint="يصلك التنبيه على الجوال" />);
    const hint = screen.getByText('يصلك التنبيه على الجوال');
    expect(box().getAttribute('describedby') ?? box().getAttribute('aria-describedby')).toBe(hint.id);
    expect(screen.queryByRole('alert'), 'التلميح أُعلن كتنبيه').toBeNull();
  });

  it('an error from the screen replaces the hint and is announced', () => {
    render(<Harness hint="تلميح" error="لا تملك الصلاحية" />);
    const err = screen.getByText('لا تملك الصلاحية');
    expect(err.getAttribute('role')).toBe('alert');
    expect(box().getAttribute('aria-describedby')).toBe(err.id);
    expect(screen.queryByText('تلميح')).toBeNull();
  });

  it('says nothing and points at nothing when there is neither', () => {
    render(<Harness />);
    expect(box().getAttribute('aria-describedby')).toBeNull();
  });

  it('keeps a description the caller tied on', () => {
    render(
      <>
        <p id="outside">ملاحظة</p>
        <Harness hint="تلميح" aria-describedby="outside" />
      </>
    );
    expect((box().getAttribute('aria-describedby') ?? '').split(' ')).toContain('outside');
  });
});

describe('inside a dialog', () => {
  function Dialog({ save }: { save: () => Promise<void> }) {
    const [on, setOn] = useState(false);
    return (
      <Modal isOpen onClose={() => {}} title="الإعدادات">
        <Switch label="تفعيل" checked={on} onChange={() => save().then(() => setOn(true))} />
        <button type="button">زر آخر</button>
      </Modal>
    );
  }

  it('works, and keeps the keyboard inside the dialog while it saves', async () => {
    const p = pending();
    render(<Dialog save={() => p.promise} />);
    const sw = screen.getByRole('switch') as HTMLInputElement;
    sw.focus();
    await act(async () => {
      fireEvent.click(sw);
    });
    expect(sw.getAttribute('aria-busy')).toBe('true');
    expect(document.activeElement, 'التركيز خرج من الحوار').toBe(sw);
    await act(async () => {
      p.resolve();
    });
    expect(sw.checked).toBe(true);
  });
});

describe('a thumb', () => {
  it('hits a 44px row on a phone, and the desk goes back to its own height', () => {
    render(<Harness />);
    const row = box().closest('label')!;
    expect(row.className).toContain('min-h-11');
    expect(row.className).toContain('md:min-h-0');
  });

  it('is a plain row — no pseudo-element, no tap-safe', () => {
    render(<Harness />);
    expect(box().closest('label')!.className).not.toContain('absolute');
    expect(box().className).not.toContain('tap-safe');
  });

  it('keeps the track beside the first line of a long label, and lets the words wrap', () => {
    const long = 'أرسل لي تنبيهاً عند كل طلب جديد وعند كل طلب مؤجَّل وعند كل مرتجع مهما طالت هذه الجملة الطويلة';
    render(<Harness label={long} />);
    const row = box().closest('label')!;
    expect(row.className).toContain('items-start');
    expect(row.className).toContain('max-w-full');
    const words = screen.getByText(long);
    expect(words.className).toContain('min-w-0');
    // One 24px line, so the first line sits on the middle of the 24px track.
    expect(words.className).toContain('leading-6');
  });

  it('is a 24 by 44 track that never shrinks in a flex row', () => {
    render(<Harness />);
    expect(box().className).toContain('h-6');
    expect(box().className).toContain('w-11');
    expect(box().className).toContain('shrink-0');
  });
});

describe('the look', () => {
  it('keeps its pill shape while it has the focus ring', () => {
    // system.css gives a focused input the card radius, unlayered, over the
    // utility class. Only an inline radius survives that.
    render(<Harness />);
    expect(box().style.borderRadius).toBe('9999px');
  });

  it('puts the knob at the END when on, whichever way the page reads', () => {
    const { rerender } = render(<Switch label="س" checked={false} onChange={() => {}} />);
    const knob = () => box().parentElement!.querySelector('[aria-hidden]') as HTMLElement;
    const off = knob().style.insetInlineStart;
    rerender(<Switch label="س" checked onChange={() => {}} />);
    const on = knob().style.insetInlineStart;
    expect(off).toBe('0.125rem');
    expect(on, 'الزرّ لا يتحرك عند التفعيل').toBe('1.375rem');
  });

  it('colours the track from the system, never a literal colour', () => {
    const { rerender } = render(<Switch label="س" checked={false} onChange={() => {}} />);
    const bg = () => box().style.backgroundColor;
    const off = bg();
    rerender(<Switch label="س" checked onChange={() => {}} />);
    expect(bg()).not.toBe(off);
    const src = readFileSync(join(process.cwd(), 'src/components/ui/Switch.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).toContain('var(--sys-primary)');
    expect(src, 'لون حرفي في المفتاح').not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(/);
  });
});
