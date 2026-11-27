'use client';

import React, { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Segmented } from '@/components/ui/Segmented';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';
import { apiJson } from '@/lib/api-client';

/**
 * «كل إشي قديم من قدسيا» — the one press that gives the old stock its warehouse (the owner, 27/11). The rules are
 * `lib/old-stock-home.ts`; the door is `/api/inventory/old-stock`.
 *
 * THIS FILE DOES NO ARITHMETIC ON A FIGURE: the «before» and the «after» of every warehouse are the server's, asked again
 * after every change of the home or of a returned figure. The boxes only carry what was typed.
 */

interface Figure {
  onHand: number;
  held: number;
  free: number;
}
interface Row {
  productId: string;
  name: string;
  unplaced: number;
  oldHeld: number;
  warehouses: { id: string; before: Figure; after: Figure; restore: number; suggested: number }[];
}
interface Preview {
  warehouses: { id: string; name: string }[];
  orders: number;
  rows: Row[];
}

const WHOLE = /^\d{1,8}$/;
const keyOf = (productId: string, warehouseId: string) => `${productId}:${warehouseId}`;

export function OldStockBanner({ onDone }: { onDone: () => void }) {
  const { currentUser } = useApp();
  /** UX only: the door asks `inventory.adjust` itself. */
  const may = userCan(currentUser, 'inventory.adjust');
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--sys-warning)]/50 bg-[var(--sys-warning-soft)] px-3 py-2.5">
        <p className="text-note leading-relaxed text-[var(--sys-warning)]">
          في بضاعة قديمة لسا بلا مخزن، وكل تسليم قديم ممكن ينخصم من مخزن غلط. اختار المخزن اللي طلعت منه.
          {!may && ' بيعملها اللي معه صلاحية تعديل المخزون.'}
        </p>
        {may && (
          <Button type="button" className="shrink-0" onClick={() => setOpen(true)}>
            ضمّ القديم لمخزنه
          </Button>
        )}
      </div>
      {open && (
        <OldStockSheet
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            onDone();
          }}
        />
      )}
    </>
  );
}

function OldStockSheet({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [home, setHome] = useState('');
  const [preview, setPreview] = useState<(Preview & { key: string }) | null>(null);
  const [warehouses, setWarehouses] = useState<Preview['warehouses']>([]);
  /** What was typed, per product and warehouse; a box never touched shows the server's suggestion. */
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const bad = Object.values(typed).some((v) => v.trim() !== '' && !WHOLE.test(v.trim()));
  const touched = Object.keys(typed).length > 0;
  // The figures the press will send: what was typed, else what the server suggested.
  const restores = (preview?.rows ?? []).flatMap((r) =>
    r.warehouses.flatMap((w) => {
      const box = typed[keyOf(r.productId, w.id)];
      const quantity = box === undefined ? w.restore : Number(box.trim() || 0);
      return w.id !== home && Number.isInteger(quantity) && quantity > 0 ? [{ productId: r.productId, warehouseId: w.id, quantity }] : [];
    })
  );
  const typedKey = JSON.stringify(typed);
  const key = `${home}|${typedKey}`;

  useEffect(() => {
    if (bad) return;
    let live = true;
    const query = new URLSearchParams();
    if (home) query.set('warehouse', home);
    if (home && touched) {
      query.set('edited', '1');
      for (const r of restores) query.append('r', `${r.productId}:${r.warehouseId}:${r.quantity}`);
    }
    const timer = setTimeout(() => {
      apiJson<Preview>(`/api/inventory/old-stock?${query.toString()}`).then(
        (p) => {
          if (!live) return;
          setError(null);
          setWarehouses(p.warehouses ?? []);
          setPreview({ ...p, key });
        },
        (e) => live && setError(e instanceof Error ? e.message : 'تعذّرت المعاينة')
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `key` is the home and the boxes: the preview is asked again when either changes, and only then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // The press is open only on a preview of exactly what is on the screen.
  const ready = !!home && !bad && !busy && preview?.key === key && !error;
  const name = (id: string) => warehouses.find((w) => w.id === id)?.name ?? 'مخزن';

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await apiJson('/api/inventory/old-stock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ warehouseId: home, restores }),
        timeoutMs: 60_000,
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر التنفيذ');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="ضمّ البضاعة القديمة لمخزنها"
      subtitle="مرة وحدة لهالمتجر. أرقام المتجر ما بتتغيّر، بس بيتحدّد كل إشي بأي مخزن"
      maxWidth="4xl"
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            إلغاء
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={!ready} loading={busy}>
            نفّذ — مرة وحدة
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <span className="block text-sm font-medium text-[var(--sys-foreground)]">القديم طلع من مخزن</span>
          <Segmented
            aria-label="القديم طلع من مخزن"
            value={home}
            onChange={(v) => {
              setHome(v);
              setTyped({});
            }}
            options={warehouses.map((w) => ({ value: w.id, label: w.name }))}
          />
        </div>

        {error && (
          <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-sm text-[var(--sys-destructive)]">{error}</p>
        )}
        {bad && <p className="text-note text-[var(--sys-destructive)]">«بيرجعلو» لازم رقم صحيح من صفر وطالع.</p>}

        {home && preview && (
          <>
            <p className="text-note leading-relaxed text-[var(--sys-muted-foreground)]">
              طلبات قديمة لسا ما خلصت رح تتسجّل إنها من «{name(home)}»: {preview.orders}. «بيرجعلو» = قطع انخصمت من مخزن تاني
              بالغلط، وبترجعله من «{name(home)}». الأرقام تحت هي «بعد التنفيذ».
            </p>
            {preview.rows.map((r) => (
              <Card key={r.productId} padding="md">
                <p className="text-sm font-bold text-[var(--sys-heading)]">{r.name}</p>
                <ul className="mt-1 space-y-2">
                  {r.warehouses.map((w) => (
                    <li key={w.id} data-warehouse={w.id} className="rounded-lg bg-[var(--sys-surface)] px-2 py-1.5 text-note">
                      <p className="font-bold text-[var(--sys-heading)]">
                        {name(w.id)} <span className="font-normal text-[var(--sys-muted-foreground)]">— هلق على الرف {w.before.onHand}</span>
                      </p>
                      <p className="text-[var(--sys-foreground)]">
                        بعد التنفيذ: على الرف {w.after.onHand} · محجوز {w.after.held} ·{' '}
                        <span className={`font-bold ${w.after.free < 0 ? 'text-[var(--sys-destructive)]' : ''}`}>متاح {w.after.free}</span>
                      </p>
                      {w.id !== home && (
                        <Input
                          label="بيرجعلو"
                          aria-label={`بيرجع لـ${name(w.id)} من ${r.name}`}
                          inputMode="numeric"
                          dir="ltr"
                          value={typed[keyOf(r.productId, w.id)] ?? String(w.restore)}
                          onChange={(e) => setTyped((t) => ({ ...t, [keyOf(r.productId, w.id)]: e.target.value }))}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </>
        )}
      </div>
    </Modal>
  );
}
