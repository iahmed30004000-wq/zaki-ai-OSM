'use client';

import React, { useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { Modal } from '@/components/ui/Modal';
import { Money } from '@/components/ui/Money';

/** The two ends of a transfer as the dialog names them. */
interface End {
  id: string;
  name: string;
  currencyCode: string;
  /** A wallet's name is unique only inside its store («الصندوق» can be two wallets), so the dialog says the store too. */
  store?: { name: string } | null;
}

export interface ReversibleTransfer {
  id: string;
  amountOut: number;
  amountIn: number;
  from: End | null;
  to: End | null;
  /** The wallets whose leg is already reversed: that half is standing no more, and the dialog says so. */
  reversedWalletIds?: string[];
}

/**
 * «قيد عكسي» ON A TRANSFER — ONE PRESS, BOTH LEGS (14/11: «هل لازم أعمل قيد عكسي بالمكانين؟»).
 *
 * A transfer is two movements, one in each wallet, and its correction is one act: the door (`PATCH /api/finance/transfers/:id`)
 * writes the opposite entry of each leg still standing, in one transaction, with the one reason typed here. The figures
 * this dialog names are the transfer's own two amounts, as stored — it computes nothing.
 */
export function ReverseTransferDialog({
  transfer,
  onClose,
  onSaved,
}: {
  transfer: ReversibleTransfer;
  onClose: () => void;
  /** Awaited: the dialog stays (its button busy) until the screen has read the list again. */
  onSaved: () => void | Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reversed = new Set(transfer.reversedWalletIds ?? []);
  const fromStands = !!transfer.from && !reversed.has(transfer.from.id);
  const toStands = !!transfer.to && !reversed.has(transfer.to.id);
  const half = (transfer.from ? reversed.has(transfer.from.id) : false) || (transfer.to ? reversed.has(transfer.to.id) : false);

  return (
    <Modal isOpen onClose={onClose} title="قيد عكسي">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError(null);
          try {
            await apiJson(`/api/finance/transfers/${transfer.id}`, {
              method: 'PATCH',
              body: JSON.stringify({ reason: reason.trim() }),
            });
            await onSaved();
          } catch (err) {
            setError(err instanceof Error ? err.message : 'تعذر القيد العكسي');
          } finally {
            setSaving(false);
          }
        }}
        className="space-y-3"
      >
        <div className="text-sm text-[var(--sys-foreground)] bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg p-3 space-y-1">
          <p>
            {half
              ? 'أحد طرفي هذا التحويل معكوس من قبل، فيُعكس الطرف الباقي فقط ويكتمل عكس التحويل:'
              : 'سيُسجَّل قيدان معاكسان بمرة واحدة، واحد في كل محفظة:'}
          </p>
          {fromStands && transfer.from && (
            <p>
              <b>{transfer.from.name}</b>
              {transfer.from.store ? <span className="text-[var(--sys-muted)]"> ({transfer.from.store.name})</span> : null}: يرجع إليها{' '}
              <Money value={transfer.amountOut} currency={transfer.from.currencyCode} />
            </p>
          )}
          {toStands && transfer.to && (
            <p>
              <b>{transfer.to.name}</b>
              {transfer.to.store ? <span className="text-[var(--sys-muted)]"> ({transfer.to.store.name})</span> : null}: يخرج منها{' '}
              <Money value={transfer.amountIn} currency={transfer.to.currencyCode} />
            </p>
          )}
          <p className="text-xs text-[var(--sys-muted)]">القيدان الأصليان لا يُحذفان ولا يُعدَّلان، ويبقى التحويل ظاهراً في القائمة مكتوباً عليه «معكوس».</p>
        </div>

        <label className="block">
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">سبب القيد العكسي (إلزامي)</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            minLength={5}
            rows={3}
            className="w-full p-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
            placeholder="مثال: سُجِّل التحويل بالخطأ"
          />
        </label>

        {error && <p className="text-sm text-[var(--sys-destructive)]">{error}</p>}

        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="h-11 md:h-10 px-4 rounded-lg border border-[var(--sys-border)] text-sm">
            إلغاء
          </button>
          <button
            type="submit"
            disabled={saving}
            className="h-11 md:h-10 px-4 rounded-lg bg-[var(--sys-destructive)] text-[var(--sys-primary-foreground)] text-sm font-medium disabled:opacity-50"
          >
            {saving ? 'جارٍ التسجيل…' : 'تسجيل القيد العكسي'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
