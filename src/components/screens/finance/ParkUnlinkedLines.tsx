'use client';

import React, { useState } from 'react';
import { RiLoader4Line } from '@remixicon/react';
import { apiJson } from '@/lib/api-client';
import { useToast } from '@/components/ui/Toast';
import { useConfirm } from '@/components/ui/Confirm';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EXPLANATION_SENTENCE, explanationOf } from '@/lib/decision-words';
import { isParkableLine, type LineAnswer } from '@/lib/statement-open-lines';

/**
 * «ركّن كل السطور بلا طلب» — ONE REASON FOR EVERY LINE OF THIS STATEMENT THAT NO ORDER OF OURS CARRIES.
 *
 * Sits above the «في الكشف وليس عندنا» queue. It says how many lines it would park BEFORE the press (the same rule the door
 * parks by, `isParkableLine`), takes the reason under the single door's rule, and asks once. The door decides: it parks the
 * lines it finds still open at that moment, all or none, and answers how many.
 *
 * Drawn only when there is something to park; the screen draws it only for whoever holds «مراجعة المطابقات» and only while the
 * statement's matching is open.
 */
export function ParkUnlinkedLines({
  statementId,
  rows,
  onDone,
}: {
  statementId: string;
  rows: LineAnswer[];
  onDone: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const count = rows.filter(isParkableLine).length;
  if (count === 0) return null;

  const submit = async () => {
    const explanation = explanationOf(note);
    if (!explanation) {
      setError(EXPLANATION_SENTENCE);
      return;
    }
    setError(null);
    const yes = await confirm({
      title: `ركّن ${count} سطراً بلا طلب؟`,
      body: 'كلها بتصير «قيد المراجعة» بنفس السبب، وما بتعلّق الاعتماد. ما بتتحرّك مصاري ولا بيتسوّى أي طلب.',
      confirmLabel: 'ركّن',
      cancelLabel: 'تراجع',
    });
    if (!yes) return;
    setBusy(true);
    try {
      const res = await apiJson<{ parked: number; message: string }>(`/api/finance/statements/${statementId}/park-unlinked`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: explanation }),
      });
      toast.done(res.message);
      setNote('');
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر الحفظ');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="md">
      <div className="flex flex-wrap gap-3 items-end">
        <p className="w-full text-sm text-[var(--sys-foreground)]">
          {count} سطراً بالكشف ما إلهن طلب عندنا ولا انبتّ فيهن. إذا كلهن مش إلنا، اكتب السبب مرة وحدة وركّنهن.
        </p>
        <div className="flex-1 min-w-[220px]">
          <Input
            label="السبب"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={EXPLANATION_SENTENCE}
          />
        </div>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => void submit()}>
          {busy ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : null}
          ركّن كل السطور بلا طلب ({count})
        </Button>
        {error && <p className="w-full text-note text-[var(--sys-destructive)]">{error}</p>}
      </div>
    </Card>
  );
}
