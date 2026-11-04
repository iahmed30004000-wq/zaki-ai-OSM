'use client';

import React, { useState } from 'react';
import { RiChat3Line, RiCheckboxCircleLine, RiLoader4Line } from '@remixicon/react';
import { apiJson } from '@/lib/api-client';

/** Does a refusal already speak to her? (the Arabic block, as `api-error.ts` asks it) */
const ARABIC = /[؀-ۿ]/;

/**
 * «ابعت واتساب» ON THE CALL SHEET — FROM WHOSE WHATSAPP (`after-no-answer.ts`).
 *
 * `fromCompany` is the desk's answer (`whatsappRoute` on `/api/confirmation/mine`): this country is set to the company's
 * number, a template is named, and the number is connected. Without it the slot is exactly what it always was — the agent's
 * own WhatsApp (`children`, the contact strip's button).
 *
 * With it, one press sends the approved template from the company's number. Any refusal or failure is said in one line and
 * the agent's own WhatsApp is put under it, so a press never ends in nothing.
 */
export function WhatsAppAfterNoAnswer({
  fromCompany,
  orderId,
  children,
}: {
  fromCompany: boolean;
  orderId: string;
  /** The agent's own WhatsApp button for this order — what renders when the company's number is not the way. */
  children: React.ReactNode;
}) {
  const [state, setState] = useState<
    { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent'; logged: boolean } | { kind: 'failed'; why: string }
  >({ kind: 'idle' });

  if (!fromCompany) return <>{children}</>;

  const send = async () => {
    setState({ kind: 'sending' });
    try {
      const d = await apiJson<{ ok: true; logged: boolean }>('/api/confirmation/whatsapp-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId }),
      });
      setState({ kind: 'sent', logged: d.logged !== false });
    } catch (e: unknown) {
      const said = e instanceof Error && ARABIC.test(e.message) ? e.message : 'ما انبعتت من رقم الشركة.';
      setState({ kind: 'failed', why: said });
    }
  };

  if (state.kind === 'sent') {
    return (
      <div className="space-y-1">
        <p role="status" className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--sys-success)]">
          <RiCheckboxCircleLine className="w-4 h-4" />
          انبعت من رقم الشركة
        </p>
        {!state.logged && <p className="text-xs text-[var(--sys-muted)]">ما انسجّلت المحاولة على الطلب.</p>}
      </div>
    );
  }

  if (state.kind === 'failed') {
    return (
      <div className="space-y-1">
        <p role="alert" className="text-xs text-[var(--sys-destructive)]">
          {state.why}
        </p>
        <p className="text-xs text-[var(--sys-muted-foreground)]">ابعت من واتساب</p>
        {children}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void send()}
      disabled={state.kind === 'sending'}
      className="min-h-11 w-full justify-center inline-flex items-center gap-1.5 px-3 rounded-lg text-sm font-medium border disabled:opacity-50 bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] border-[var(--sys-primary)]"
    >
      {state.kind === 'sending' ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiChat3Line className="w-4 h-4" />}
      ابعت من رقم الشركة
    </button>
  );
}
