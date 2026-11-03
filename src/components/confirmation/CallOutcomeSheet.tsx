'use client';

import React, { useState } from 'react';
import {
  RiArrowGoBackLine,
  RiArrowRightLine,
  RiCheckboxCircleLine,
  RiCloseCircleLine,
  RiCloseLine,
  RiLoader4Line,
  RiPhoneLine,
  RiPhoneLockLine,
  RiTimerLine,
  RiWifiOffLine,
} from '@remixicon/react';
import { awayClock, callbackChips, outcomeOrder, type CallbackChip, type CallOutcome, type OutgoingState } from '@/lib/call-outcome';

/**
 * «شو صار؟» — THE SHEET THAT WAITS AT THE BOTTOM OF HER PHONE WHILE SHE IS ON THE CALL.
 *
 * It opens the moment «اتصل» is pressed and is still there when she comes back from the dialler. One tap says what
 * happened; the buttons are the height of a thumb and sit where the thumb is. Every answer goes to a door the desk
 * already has, through the screen (`ConfirmationMineScreen`), and this file decides nothing about any of them.
 *
 * Three moments:
 *   · «شو صار؟» — the answers, the likeliest first (by how long she was away, `outcomeOrder`);
 *   · «رد» — the desk's own three: «تأكيد الطلب» · «تأجيل» · «ألغِ», with the same locks the card has;
 *   · after an answer — five seconds to take it back, WhatsApp after a call nobody answered, and «التالي».
 */

const WORDS: Record<CallOutcome, string> = {
  ANSWERED: 'رد',
  NO_ANSWER: 'ما رد',
  BUSY: 'مشغول',
  UNREACHABLE: 'مسكّر',
  WRONG_NUMBER: 'رقم غلط',
  CALLBACK: 'اتصل لاحقاً',
  NOT_CALLED: 'ما اتصلت',
};

/** A thumb is wider than a mouse: every button on the sheet is at least this tall. */
const THUMB = { minHeight: 48 };

/** The sheet's buttons — the card's own look (`Action`), in the size a thumb needs. */
function SheetButton({
  children,
  onClick,
  tone,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone?: 'primary' | 'danger';
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-disabled={disabled || undefined}
      style={THUMB}
      className={`w-full justify-center inline-flex items-center gap-1.5 px-3 rounded-lg text-sm font-medium border disabled:opacity-50 ${
        tone === 'primary'
          ? 'bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] border-[var(--sys-primary)]'
          : tone === 'danger'
            ? 'bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)] border-[var(--sys-destructive-border)]'
            : 'bg-[var(--sys-card)] text-[var(--sys-foreground)] border-[var(--sys-border)]'
      }`}
    >
      {children}
    </button>
  );
}

const ICON: Record<CallOutcome, React.ReactNode> = {
  ANSWERED: <RiPhoneLine className="w-4 h-4" />,
  NO_ANSWER: <RiPhoneLockLine className="w-4 h-4" />,
  BUSY: <RiPhoneLockLine className="w-4 h-4" />,
  UNREACHABLE: <RiPhoneLockLine className="w-4 h-4" />,
  WRONG_NUMBER: <RiCloseCircleLine className="w-4 h-4" />,
  CALLBACK: <RiTimerLine className="w-4 h-4" />,
  NOT_CALLED: <RiCloseLine className="w-4 h-4" />,
};

export type LoggedOutcome = 'NO_ANSWER' | 'BUSY' | 'UNREACHABLE' | 'WRONG_NUMBER';

export function CallOutcomeSheet({
  customerName,
  awayMs,
  closesOnNext,
  confirmLock,
  waiting,
  refused,
  offline,
  canPull,
  pulling,
  whatsapp,
  onAnswered,
  onLogged,
  onCallback,
  onNotCalled,
  onConfirm,
  onPostpone,
  onReject,
  onUndo,
  onNext,
  onClose,
}: {
  /**
   * Whom she rang. The order's number is not printed here: it is on the card right under the sheet, and a number on a
   * second surface would have to be `OrderRef` — a link that opens the order, the way around «افتح وعدّل».
   */
  customerName: string;
  /** How long she was away; `null` while she has not come back (or the browser never said). */
  awayMs: number | null;
  /** The next unanswered call closes this order by the rule of three — said before she taps, not after. */
  closesOnNext: boolean;
  /** Why «تأكيد الطلب» is shut, in the card's words — or null when it is open. */
  confirmLock: string | null;
  /**
   * The answer on its way: still in its five seconds (`countdown` — the only state «تراجع» is offered in), on its way
   * (`sending`), or waiting for the line (`line`); null when nothing is waiting.
   */
  waiting: { label: string; state: OutgoingState; secondsLeft: number } | null;
  /** The door said no to the answer she gave, in its own words — said here, not «انحفظ». */
  refused: string | null;
  offline: boolean;
  canPull: boolean;
  pulling: boolean;
  /** The contact strip's own WhatsApp button, for this order. */
  whatsapp: React.ReactNode;
  /** «رد» was tapped: the desk is read again, so the card's locks reflect the call just logged. */
  onAnswered: () => void;
  /** `false` when the screen refused it (this call's answer already left) — the sheet then stays where it is. */
  onLogged: (outcome: LoggedOutcome) => boolean;
  onCallback: (chip: CallbackChip) => boolean;
  onNotCalled: () => void;
  onConfirm: () => void;
  onPostpone: () => void;
  onReject: () => void;
  /** `false` when it had already left — nothing was taken back, and the sheet does not pretend it was. */
  onUndo: () => boolean;
  onNext: () => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<'ask' | 'answered' | 'callback' | { after: LoggedOutcome | 'CALLBACK' }>('ask');
  // Read once, as the chips are drawn: «اليوم 6 م» is left out once six is past.
  const [chips] = useState(() => callbackChips(new Date()));
  const order = outcomeOrder(awayMs);

  const tap = (o: CallOutcome) => {
    if (o === 'NOT_CALLED') return onNotCalled();
    if (o === 'ANSWERED') {
      onAnswered();
      return setStep('answered');
    }
    if (o === 'CALLBACK') return setStep('callback');
    if (onLogged(o)) setStep({ after: o });
  };

  const button = (o: CallOutcome, first: boolean) => (
    <SheetButton key={o} onClick={() => tap(o)} tone={first ? 'primary' : undefined}>
      {ICON[o]}
      {WORDS[o]}
    </SheetButton>
  );

  return (
    <>
      <div className="fixed inset-0 z-30 bg-[var(--sys-sidebar)]/20" aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="شو صار؟"
        dir="rtl"
        data-call-sheet
        style={{ maxHeight: '85vh' }}
        className="fixed inset-x-2 bottom-2 z-40 overflow-y-auto rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] shadow-overlay p-3 space-y-3"
      >
        <header className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[var(--sys-heading)]">شو صار؟</p>
            <p className="text-xs text-[var(--sys-muted-foreground)]">
              <span dir="auto">{customerName}</span>
              {awayMs !== null && (
                <>
                  {' · '}
                  <span className="tabular-nums">غبتِ <span dir="ltr">{awayClock(awayMs)}</span></span>
                </>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="سكّر"
            aria-label="سكّر"
            style={{ minHeight: 48, minWidth: 48 }}
            className="inline-flex items-center justify-center rounded-lg border border-[var(--sys-border)] text-[var(--sys-muted-foreground)]"
          >
            <RiCloseLine className="w-4 h-4" />
          </button>
        </header>

        {offline && (
          <p role="status" className="flex items-center gap-2 text-xs text-[var(--sys-warning)]">
            <RiWifiOffLine className="w-4 h-4" /> ما في إنترنت — المحفوظ بيستنى وبينبعت لحاله لما يرجع الخط.
          </p>
        )}

        {refused && (
          <p role="alert" className="text-xs text-[var(--sys-destructive)]">{refused}</p>
        )}

        {step === 'ask' && (
          <div className="space-y-2">
            {button(order[0], true)}
            <div className="grid grid-cols-2 gap-2">{order.slice(1).map((o) => button(o, false))}</div>
            {closesOnNext && (
              <p className="text-xs text-[var(--sys-warning)]">«ما رد» أو «مشغول» أو «مسكّر» هلق بيسكّر الطلب تلقائياً.</p>
            )}
          </div>
        )}

        {step === 'answered' && (
          <div className="space-y-2">
            <SheetButton onClick={onConfirm} tone="primary" disabled={!!confirmLock} title={confirmLock ?? undefined}>
              <RiCheckboxCircleLine className="w-4 h-4" />
              تأكيد الطلب
            </SheetButton>
            {confirmLock && <p className="text-xs text-[var(--sys-warning)]">{confirmLock}</p>}
            <div className="grid grid-cols-2 gap-2">
              <SheetButton onClick={onPostpone}>
                <RiTimerLine className="w-4 h-4" />
                تأجيل
              </SheetButton>
              <SheetButton onClick={onReject} tone="danger">
                <RiCloseCircleLine className="w-4 h-4" />
                ألغِ
              </SheetButton>
            </div>
            <SheetButton onClick={() => setStep('ask')}>
              <RiArrowGoBackLine className="icon-mirror w-4 h-4" />
              رجوع
            </SheetButton>
          </div>
        )}

        {step === 'callback' && (
          <div className="space-y-2">
            <p className="text-xs text-[var(--sys-muted-foreground)]">إيمتى نتصل؟ الطلب بيتأجّل للموعد وبيرجع لعندك فيه.</p>
            <div className="grid grid-cols-2 gap-2">
              {chips.map((c) => (
                <SheetButton
                  key={c.label}
                  onClick={() => {
                    if (onCallback(c)) setStep({ after: 'CALLBACK' });
                  }}
                >
                  <span dir="auto">{c.label}</span>
                </SheetButton>
              ))}
            </div>
            <SheetButton onClick={() => setStep('ask')}>
              <RiArrowGoBackLine className="icon-mirror w-4 h-4" />
              رجوع
            </SheetButton>
          </div>
        )}

        {typeof step === 'object' && (
          <div className="space-y-2">
            {/* «تراجع» only while nothing has left: once the send is on its way it cannot be taken back, and saying it can
                would let a second answer of the same call reach the log. */}
            {waiting?.state === 'countdown' ? (
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-[var(--sys-muted-foreground)]">
                  بينحفظ «{waiting.label}» بعد <span className="tabular-nums" dir="ltr">{waiting.secondsLeft}</span>
                </p>
                <SheetButton
                  onClick={() => {
                    if (onUndo()) setStep('ask');
                  }}
                >
                  <RiArrowGoBackLine className="icon-mirror w-4 h-4" />
                  تراجع
                </SheetButton>
              </div>
            ) : waiting?.state === 'sending' ? (
              <p role="status" className="text-xs text-[var(--sys-muted-foreground)]">عم ينبعت «{waiting.label}»…</p>
            ) : waiting?.state === 'line' ? (
              <p role="status" className="text-xs text-[var(--sys-warning)]">«{waiting.label}» بيستنى الخط — بينبعت لحاله لما يرجع.</p>
            ) : refused ? null : (
              <p role="status" className="text-xs text-[var(--sys-success)]">انبعت.</p>
            )}
            {(step.after === 'NO_ANSWER' || step.after === 'BUSY' || step.after === 'UNREACHABLE') && (
              <div className="space-y-1">
                <p className="text-xs text-[var(--sys-muted-foreground)]">ابعت واتساب</p>
                {whatsapp}
              </div>
            )}
            {step.after === 'WRONG_NUMBER' && (
              <SheetButton onClick={onReject} tone="danger">
                <RiCloseCircleLine className="w-4 h-4" />
                ألغِ
              </SheetButton>
            )}
            {canPull ? (
              <SheetButton onClick={onNext} tone="primary" disabled={pulling}>
                {pulling ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiArrowRightLine className="icon-mirror w-4 h-4" />}
                التالي
              </SheetButton>
            ) : (
              <SheetButton onClick={onClose}>
                <RiCloseLine className="w-4 h-4" />
                سكّر
              </SheetButton>
            )}
          </div>
        )}
      </div>
    </>
  );
}
