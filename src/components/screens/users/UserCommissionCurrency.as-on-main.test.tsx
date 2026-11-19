// @vitest-environment jsdom
'use client';
/* eslint-disable */
// ═══════════════════════════════════════════════════════════════════════
// A FROZEN COPY — NOT A SCREEN. src/components/screens/users/UserCommissionCurrency.tsx exactly as it stood on main at 7638cf10 (R16b2, 19/11), before it moved
// onto the kit. The differential test beside it (the-employee-money-sends-what-it-sent.test.tsx) draws THIS and the live
// file through the same presses and asks for byte-identical figures and request bodies. Its name ends in «.test.tsx» so no
// census, ratchet or menu ever counts it as a screen. Do not edit it: a copy that drifts proves nothing. When the
// differential has served its purpose it is deleted whole.
// ═══════════════════════════════════════════════════════════════════════
import { describe, expect, it } from 'vitest';

import React, { useState } from 'react';
import { CurrencyPicker, currencyChoiceReady, type CurrencyChoice } from '@/components/ui/CurrencyPicker';
import { minorUnitFor } from '@/lib/currencies';
import { RiCopperCoinLine } from '@remixicon/react';

/**
 * WHAT THIS PERSON'S COMMISSION IS COUNTED IN.
 *
 * Every entry used to be written in the order's currency, so an Egyptian
 * moderator working a Syrian store's orders was owed Syrian pounds — a
 * figure meaning nothing to them, and a balance nobody could hand over.
 *
 * Counting is one question; paying is another. There may be no Egyptian
 * wallet at all: the money leaves whichever wallet has it, at a rate the
 * owner writes when they pay. That is why this field names a CURRENCY and
 * not a wallet — a wallet chosen here would be a promise the business might
 * not be able to keep.
 *
 * Empty means the store's own currency, which is how it always worked and
 * stays right for everyone local.
 */
export function UserCommissionCurrency({
  userId,
  initial,
  canEdit,
}: {
  userId: string;
  initial: string | null;
  canEdit: boolean;
}) {
  const [choice, setChoice] = useState<CurrencyChoice>({
    code: initial ?? '',
    minorUnit: initial ? minorUnitFor(initial) ?? 2 : null,
  });
  const [saved, setSaved] = useState(initial ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const code = choice.code.trim().toUpperCase();
  const changed = code !== saved;
  // Clearing it is always allowed; setting one needs a real ISO code.
  const valid = code === '' || currencyChoiceReady(choice);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'updateContact', commissionCurrency: code }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'تعذّر الحفظ');
      setSaved(code);
      setMsg({ ok: true, text: 'حُفظ.' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذّر الحفظ' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg bg-[var(--sys-surface)] px-3 py-2.5">
      <p className="flex items-center gap-1 text-xs text-[var(--sys-muted)]">
        <RiCopperCoinLine className="h-4 w-4" /> عملة العمولة
      </p>

      {canEdit ? (
        <>
          <div className="mt-1">
            <CurrencyPicker value={choice} onChange={setChoice} />
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={!changed || !valid || busy}
              className="h-11 md:h-8 rounded-md bg-[var(--sys-primary)] px-3 text-xs font-bold text-[var(--sys-primary-foreground)] disabled:opacity-40"
            >
              حفظ
            </button>
            {code !== '' && (
              <button
                type="button"
                onClick={() => { setChoice({ code: '', minorUnit: null }); }}
                className="text-xs text-[var(--sys-muted-foreground)] hover:text-[var(--sys-destructive)]"
              >
                استخدم عملة المتجر
              </button>
            )}
            {msg && <span className={`text-xs ${msg.ok ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'}`}>{msg.text}</span>}
          </div>
        </>
      ) : (
        <p className="mt-1 text-xs font-bold text-[var(--sys-heading)]">{saved || 'عملة المتجر'}</p>
      )}

      <p className="mt-1 text-xs leading-relaxed text-[var(--sys-muted)]">
        تُحتسب عمولته بهذه العملة ويُقال له رقمه بها. المحفظة التي يخرج منها المال تُختار وقت الصرف — قد
        تكون بعملة أخرى، ويُكتب سعر الصرف حينها.
      </p>
    </div>
  );
}

describe('the copy of UserCommissionCurrency as it stood on main', () => {
  it('is a component the differential can draw', () => {
    expect(typeof UserCommissionCurrency).toBe('function');
  });
});
