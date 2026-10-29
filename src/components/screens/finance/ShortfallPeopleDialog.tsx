'use client';

import React, { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Money } from '@/components/ui/Money';
import { ON_THE_COMPANY } from '@/lib/shortfall';

/**
 * «من يتحمّل الفرق؟» — the question the approval asks when the company paid LESS than we expected and the door
 * has no name for the parcel.
 *
 * The approval stopped, and nothing was written: no wallet movement, no order settled. Each line below is an order
 * whose parcel nobody recorded as delivered (a statement that is the first proof of delivery, an order that was
 * never ticked at the door). The approver says who followed it, or says «على الشركة» — the loss stays with the
 * company and nobody is charged. The confirmer and the moderator never appear: they sold the order, they did not
 * follow the parcel. The answer is sent back with the same approval.
 */

export interface UnnamedShortfall {
  matchId: string;
  orderNumber: string;
  amount: number;
  currencyCode: string;
}

export interface ShortfallPerson {
  id: string;
  name: string;
  role: string;
}

export function ShortfallPeopleDialog({
  sentence,
  lines,
  candidates,
  busy,
  onClose,
  onConfirm,
}: {
  sentence: string;
  lines: UnnamedShortfall[];
  candidates: ShortfallPerson[];
  busy: boolean;
  onClose: () => void;
  onConfirm: (people: Record<string, string>) => void;
}) {
  const [people, setPeople] = useState<Record<string, string>>({});
  const complete = lines.every((l) => !!people[l.matchId]);

  return (
    <Modal isOpen onClose={onClose} title="من يتحمّل الفرق؟">
      <div className="space-y-3">
        <p className="text-sm text-[var(--sys-foreground)]">{sentence}</p>
        <ul className="space-y-2">
          {lines.map((l) => (
            <li key={l.matchId} className="text-xs bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg p-3 space-y-1">
              <p className="text-[var(--sys-foreground)]">
                {l.orderNumber} — الفرق <Money value={l.amount} currency={l.currencyCode} />
              </p>
              <select
                value={people[l.matchId] ?? ''}
                onChange={(e) => setPeople((p) => ({ ...p, [l.matchId]: e.target.value }))}
                className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm bg-[var(--sys-card)]"
              >
                <option value="">اختر…</option>
                <option value={ON_THE_COMPANY}>على الشركة</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </li>
          ))}
        </ul>
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="h-11 md:h-10 px-4 rounded-lg border border-[var(--sys-border)] text-sm">
            رجوع
          </button>
          <button
            type="button"
            disabled={busy || !complete}
            onClick={() => onConfirm(people)}
            className="h-11 md:h-10 px-4 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-medium disabled:opacity-50"
          >
            اعتمد
          </button>
        </div>
      </div>
    </Modal>
  );
}
