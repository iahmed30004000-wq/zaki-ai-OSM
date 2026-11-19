'use client';

import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';
import { RiAlertLine, RiCheckLine, RiFileCopyLine, RiInformationLine } from '@remixicon/react';

/**
 * ASKING BEFORE, AND TELLING AFTER — inside the app.
 *
 * `confirm()` and `alert()` are the operating system interrupting the
 * person: a grey box with the hostname at the top, Latin buttons, and the
 * same alarmed look whatever it says. A question about deleting one row
 * arrives looking exactly like a browser security warning.
 *
 * This is the same question in the app's own dialog, in Arabic, with the
 * dangerous button coloured as dangerous. Sixteen places called the native
 * ones; a component each would have been sixteen dialogs to keep in step,
 * so it is one hook:
 *
 *     const confirm = useConfirm();
 *     if (!(await confirm({ title: 'حذف…؟', tone: 'danger' }))) return;
 *
 * It returns a promise so the calling code keeps reading top to bottom,
 * the way `confirm()` let it.
 *
 * Three questions, one dialog. The browser offered three — confirm, prompt
 * and alert — and the app still called them in thirteen places, including
 * the decision on a change request, where a reason typed into a grey system
 * box went straight into the audit log. So the same provider now answers
 * all three, and nothing mounts a second dialog:
 *
 *     useConfirm()  yes or no                      → boolean
 *     useAsk()      a line of text, maybe required → string | null
 *     useTell()     something to read, or to copy  → void
 */

export interface ConfirmOptions {
  title: string;
  /** The consequence, in one sentence. */
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` for anything destructive — it colours the button. */
  tone?: 'danger' | 'normal';
}

export interface AskOptions extends ConfirmOptions {
  input: {
    label: string;
    placeholder?: string;
    /** The confirm button stays disabled until something is typed. */
    required?: boolean;
    /** Several lines — for a reason, not for a name. */
    multiline?: boolean;
    initial?: string;
    maxLength?: number;
  };
}

export interface TellOptions {
  title: string;
  body?: string;
  tone?: 'danger' | 'normal';
  /**
   * Something the person has to copy — a link, a secret shown once. Shown in
   * a read-only field with its own copy button, which is what the old
   * `prompt('انسخ الرابط يدوياً:', url)` was improvising.
   */
  value?: string;
  okLabel?: string;
}

type Confirm = (options: ConfirmOptions) => Promise<boolean>;
type Ask = (options: AskOptions) => Promise<string | null>;
type Tell = (options: TellOptions) => Promise<void>;

type Open =
  | { kind: 'confirm'; options: ConfirmOptions }
  | { kind: 'ask'; options: AskOptions }
  | { kind: 'tell'; options: TellOptions };

interface Dialogs {
  confirm: Confirm;
  ask: Ask;
  tell: Tell;
}

const ConfirmContext = createContext<Dialogs | null>(null);

const FIELD =
  'w-full rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] px-3 py-2 text-sm text-[var(--sys-heading)] outline-none focus:border-[var(--sys-primary)]';

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState<Open | null>(null);
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  // One pending answer at a time; whichever kind is open resolves it.
  const answer = useRef<((value: unknown) => void) | null>(null);

  const show = useCallback(<T,>(next: Open): Promise<T> => {
    setOpen(next);
    setCopied(false);
    setText(next.kind === 'ask' ? next.options.input.initial ?? '' : '');
    return new Promise<T>((resolve) => {
      answer.current = resolve as (value: unknown) => void;
    });
  }, []);

  const dialogs = useMemo<Dialogs>(
    () => ({
      confirm: (options) => show<boolean>({ kind: 'confirm', options }),
      ask: (options) => show<string | null>({ kind: 'ask', options }),
      tell: (options) => show<void>({ kind: 'tell', options }),
    }),
    [show]
  );

  /**
   * Dismissing IS declining. A dialog closed by Escape must never be read as
   * a yes, and an ask closed by Escape returns null rather than whatever was
   * half-typed — the whole point of asking is that silence is not consent.
   */
  const close = (accepted: boolean) => {
    const current = open;
    setOpen(null);
    let value: unknown = undefined;
    if (current?.kind === 'confirm') value = accepted;
    else if (current?.kind === 'ask') value = accepted ? text.trim() : null;
    answer.current?.(value);
    answer.current = null;
  };

  const tone = open?.options.tone;
  const danger = tone === 'danger';
  const input = open?.kind === 'ask' ? open.options.input : null;
  const blocked = Boolean(input?.required && text.trim().length === 0);

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard refused (an insecure origin, a denied permission). The
      // field selects itself on focus, so Ctrl+C still works.
    }
  }

  return (
    <ConfirmContext.Provider value={dialogs}>
      {children}
      <Modal isOpen={Boolean(open)} onClose={() => close(false)} title="" maxWidth="sm">
        {open && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!blocked) close(true);
            }}
          >
            <div className="flex items-start gap-3">
              <span
                className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                  danger ? 'bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)]' : 'bg-[var(--sys-surface-strong)] text-[var(--sys-foreground)]'
                }`}
              >
                {danger ? <RiAlertLine className="h-4 w-4" /> : <RiInformationLine className="h-4 w-4" />}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-[var(--sys-heading)]">{open.options.title}</p>
                {open.options.body && (
                  <p className="mt-1 whitespace-pre-line text-xs leading-6 text-[var(--sys-muted-foreground)]">{open.options.body}</p>
                )}
              </div>
            </div>

            {input && (
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-[var(--sys-foreground)]">
                  {input.label}
                  {input.required && <span className="text-[var(--sys-destructive)]"> *</span>}
                </span>
                {input.multiline ? (
                  <textarea
                    autoFocus
                    rows={3}
                    value={text}
                    maxLength={input.maxLength ?? 500}
                    placeholder={input.placeholder}
                    onChange={(e) => setText(e.target.value)}
                    className={`${FIELD} resize-none`}
                  />
                ) : (
                  <input
                    autoFocus
                    value={text}
                    maxLength={input.maxLength ?? 200}
                    placeholder={input.placeholder}
                    onChange={(e) => setText(e.target.value)}
                    className={FIELD}
                  />
                )}
              </label>
            )}

            {open.kind === 'tell' && open.options.value && (
              <div className="flex gap-2">
                <input
                  readOnly
                  dir="ltr"
                  value={open.options.value}
                  onFocus={(e) => e.currentTarget.select()}
                  className={`${FIELD} font-mono text-xs`}
                />
                <Button type="button" variant="secondary" size="sm" onClick={() => void copy(open.options.value!)}>
                  {copied ? <RiCheckLine className="h-4 w-4 text-[var(--sys-success)]" /> : <RiFileCopyLine className="h-4 w-4" />}
                  {copied ? 'نُسخ' : 'انسخ'}
                </Button>
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              {open.kind !== 'tell' && (
                <Button type="button" variant="secondary" size="sm" onClick={() => close(false)}>
                  {open.options.cancelLabel ?? 'إلغاء'}
                </Button>
              )}
              <Button
                type="submit"
                size="sm"
                disabled={blocked}
                variant={danger && open.kind !== 'tell' ? 'danger' : 'primary'}
              >
                {open.kind === 'tell'
                  ? open.options.okLabel ?? 'حسناً'
                  : open.options.confirmLabel ?? (danger ? 'احذف' : 'تابع')}
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </ConfirmContext.Provider>
  );
}

/**
 * Each hook falls back to the browser's own dialog if the provider is
 * missing, so a screen mounted outside it still asks rather than silently
 * going ahead — a missing provider must never turn a question into a yes.
 */
export function useConfirm(): Confirm {
  const d = useContext(ConfirmContext);
  return (
    d?.confirm ??
    (async (o) =>
      typeof window !== 'undefined' &&
      window.confirm(`${o.title}${o.body ? `\n\n${o.body}` : ''}`))
  );
}

/** Ask for a line of text. Null means the person declined. */
export function useAsk(): Ask {
  const d = useContext(ConfirmContext);
  return (
    d?.ask ??
    (async (o) => {
      if (typeof window === 'undefined') return null;
      const v = window.prompt(`${o.title}\n${o.input.label}`, o.input.initial ?? '');
      if (v === null) return null;
      // Same rule as the dialog: a required answer left empty is a refusal.
      return o.input.required && !v.trim() ? null : v.trim();
    })
  );
}

/** Tell the person something, or hand them something to copy. */
export function useTell(): Tell {
  const d = useContext(ConfirmContext);
  return (
    d?.tell ??
    (async (o) => {
      if (typeof window === 'undefined') return;
      if (o.value) window.prompt(o.title, o.value);
      else window.alert(`${o.title}${o.body ? `\n\n${o.body}` : ''}`);
    })
  );
}
