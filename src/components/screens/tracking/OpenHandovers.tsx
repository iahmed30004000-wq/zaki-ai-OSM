'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { RiHandCoinLine } from '@remixicon/react';
import { apiJson } from '@/lib/api-client';
import { userCan } from '@/lib/can';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { HandoverPanel, handoverLine, useCurrentUserIfAny, type HandoverView } from './HandoverPanel';

/**
 * THE OPEN HANDOVERS — «{المندوب} — باقي X — سجّل دفعة» (F9, 23/11).
 *
 * A courier who pays over several days has ONE open statement; this is where the next payment is recorded, on the tracking
 * screen and on manual matching alike. One card per gathered manual statement not yet approved (`GET …/statements/manual`).
 * Drawn only for whoever holds «رفع تقارير الشحن» — the key that records a payment; for anybody else it draws nothing (and
 * the door would refuse the read).
 */
export function OpenHandovers() {
  const user = useCurrentUserIfAny();
  const mayUpload = userCan(user, 'settlement.upload');
  const [list, setList] = useState<HandoverView[]>([]);
  const [open, setOpen] = useState<HandoverView | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const load = useCallback(async () => {
    const d = await apiJson<{ handovers: HandoverView[] }>('/api/finance/statements/manual');
    setList(Array.isArray(d?.handovers) ? d.handovers : []);
  }, []);

  useEffect(() => {
    if (!mayUpload) return;
    apiJson<{ handovers: HandoverView[] }>('/api/finance/statements/manual')
      .then((d) => setList(Array.isArray(d?.handovers) ? d.handovers : []))
      .catch(() => undefined);
  }, [mayUpload]);

  if (!mayUpload || (list.length === 0 && !said)) return null;

  return (
    <>
      {list.map((h) => (
        <Card key={h.id} padding="sm" className="flex flex-wrap items-center gap-3">
          <span className="text-note text-[var(--sys-foreground)] tabular-nums">{handoverLine(h)}</span>
          <span className="text-note text-[var(--sys-muted-foreground)]">{h.reference}</span>
          <Button type="button" variant="secondary" size="sm" className="mr-auto" onClick={() => setOpen(h)}>
            <RiHandCoinLine className="w-4 h-4" aria-hidden /> سجّل دفعة
          </Button>
        </Card>
      ))}
      {said && (
        <p role="status" className="text-note text-[var(--sys-success)]">{said}</p>
      )}
      {open && (
        <Modal
          isOpen
          onClose={() => {
            setOpen(null);
            load().catch(() => undefined);
          }}
          title="تسليم المندوب"
          subtitle={`${open.courier} · ${open.reference}`}
        >
          <HandoverPanel
            statementId={open.id}
            onApproved={(message) => {
              setOpen(null);
              setSaid(message);
              load().catch(() => undefined);
            }}
          />
        </Modal>
      )}
    </>
  );
}
