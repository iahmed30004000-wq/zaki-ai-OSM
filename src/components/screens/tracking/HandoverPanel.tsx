'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RiCheckDoubleLine, RiHandCoinLine } from '@remixicon/react';
import { apiJson } from '@/lib/api-client';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';
import { minorUnitFor } from '@/lib/currencies';
import { receiptsInStatementCurrency } from '@/lib/receipt-conversion';
import type { CurrencyRow } from '@/lib/handover';
import { Input, Select } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Money } from '@/components/ui/Money';

/**
 * «تسليم المندوب» — the courier's handover, drawn as the statement it now is (F9, 23/11).
 *
 * The owner on the old dialog: «افرض استلمت دولار وليرة، ما في نظام التسوية زي الكشف، وما بقدر اعمل استلامات، وبحطلي
 * محافظ الأردن وأنا بسوريا». So this panel is a THIN DOOR onto the doors every statement already has:
 *
 *   · each payment is a receipt (`POST …/receipts`) — its own currency, wallet, amount, rate and optional paper, with ONE id
 *     per line kept across retries, so a double press lands on the row already written;
 *   · «استلمت / باقي» is the statement's own gap (`receiptGap`, read from the server), and a payment above it says «زيادة» in red;
 *   · «اعتماد» is the existing approval: the matching is run (`…/match`) and then `PATCH {approve:true}` — which writes the
 *     money ONCE, one IN per receipt. Until then the panel says «مستلَم — لم يُعتمد بعد».
 *
 * Nothing here adds money up. The per-currency table and the gap come from the server; the one figure worked out here is
 * the «يساوي» under a typed rate, with the SAME function the gap is computed with — said before saving, because a rate typed
 * upside down is the mistake that looks right until the gap appears (the statement screen says it the same way).
 *
 * The keys are the statement's: «رفع تقارير الشحن» (settlement.upload) records a payment, «مراجعة المطابقات» +
 * «اعتماد كشف شركة الشحن» (settlement.review + settlement.approve) approve. A person without them reads which key, here.
 */

/** The ceiling the server holds (`MAX_PROOF_BYTES` in settlement-proof.ts); pinned equal by `the-handover-is-a-statement`. */
export const HANDOVER_MAX_PROOF_MB = 4;

export interface HandoverView {
  id: string;
  reference: string;
  courier: string;
  currencyCode: string;
  orders: number;
  gap: { claimed: number; received: number; gap: number; unconvertible: number; needsExplanation: boolean };
  standing: { claimed: number; received: number; remaining: number; over: number };
  receipts: {
    id: string;
    amount: number;
    currencyCode: string;
    exchangeRate: number | null;
    receivedAt: string;
    proofName: string | null;
    wallet: string;
  }[];
  table: CurrencyRow[];
}

interface CollectWallet {
  id: string;
  name: string;
  currencyCode: string;
  unassigned?: boolean;
}

/** The sentences a person without the key reads instead of a dead button. */
export const NO_UPLOAD_SENTENCE =
  'تسجيل دفعات المندوب صار متل الكشف، وبدّه صلاحية «رفع تقارير الشحن». اطلبها من المالك — ما انكتب شي.';
export const NO_APPROVE_SENTENCE =
  'الاعتماد بدّه صلاحيتي «مراجعة المطابقات» و«اعتماد كشف شركة الشحن». الدفعات محفوظة وبتستنى مين معه المفتاح.';
export const NOT_APPROVED_YET = 'مستلَم — لم يُعتمد بعد';

/** What the card says about an open handover: «{المندوب} — باقي X». */
export function handoverLine(h: Pick<HandoverView, 'courier' | 'currencyCode' | 'standing'>): string {
  if (h.standing.over > 0) return `${h.courier} — زيادة ${h.standing.over} ${h.currencyCode}`;
  if (h.standing.remaining > 0) return `${h.courier} — باقي ${h.standing.remaining} ${h.currencyCode}`;
  return `${h.courier} — مكتمل، بانتظار الاعتماد`;
}

/**
 * The person at the screen, or nobody. The dialog is drawn inside the shell (with the app's context) and, in isolation, without
 * it: `useApp` reads the context unconditionally and only then throws, so catching the throw keeps the hooks' order fixed.
 * Nobody means no key — the refusal sentences are drawn, never a dead button.
 */
export function useCurrentUserIfAny() {
  try {
    return useApp().currentUser;
  } catch {
    return undefined;
  }
}

/** The file as base64, in chunks: one spread of four megabytes blows the argument limit. */
async function fileToBase64(picked: File): Promise<string> {
  const bytes = new Uint8Array(await picked.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export function HandoverPanel({ statementId, onApproved }: { statementId: string; onApproved: (message: string) => void }) {
  const user = useCurrentUserIfAny();
  // UX only: every door below asks its own key again.
  const mayUpload = userCan(user, 'settlement.upload');
  const mayApprove = userCan(user, 'settlement.approve') && userCan(user, 'settlement.review');

  const [handover, setHandover] = useState<HandoverView | null>(null);
  const [gone, setGone] = useState(false);
  const [wallets, setWallets] = useState<CollectWallet[]>([]);

  const read = useCallback(
    () =>
      apiJson<{ handovers: HandoverView[] }>(`/api/finance/statements/manual?id=${statementId}`).then((d) => {
        const found = (Array.isArray(d?.handovers) ? d.handovers : []).find((h) => h.id === statementId) ?? null;
        setHandover(found);
        setGone(!found);
      }),
    [statementId]
  );

  useEffect(() => {
    apiJson<{ handovers: HandoverView[] }>(`/api/finance/statements/manual?id=${statementId}`)
      .then((d) => {
        const found = (Array.isArray(d?.handovers) ? d.handovers : []).find((h) => h.id === statementId) ?? null;
        setHandover(found);
        setGone(!found);
      })
      .catch(() => setGone(true));
    apiJson<{ wallets: CollectWallet[] }>('/api/finance/wallets?scope=collect')
      .then((d) => setWallets(Array.isArray(d?.wallets) ? d.wallets : []))
      .catch(() => undefined);
  }, [statementId]);
  const load = read;

  if (gone) {
    return <p className="text-note text-[var(--sys-muted-foreground)]">هالتسليم مش مفتوح — يمكن انعتمد أو انشال.</p>;
  }
  if (!handover) return <p className="text-note text-[var(--sys-muted-foreground)]">جارٍ التحميل…</p>;

  return (
    <div className="space-y-3">
      <Standing handover={handover} />
      {handover.table.length > 0 && <CurrencyTable handover={handover} />}
      {mayUpload ? (
        <ReceiptLine handover={handover} wallets={wallets} onSaved={() => load()} />
      ) : (
        <Card plain padding="sm" className="text-note">
          <p role="alert" className="text-[var(--sys-destructive)]">{NO_UPLOAD_SENTENCE}</p>
        </Card>
      )}
      <Approve handover={handover} mayApprove={mayApprove} onApproved={onApproved} />
    </div>
  );
}

function Standing({ handover }: { handover: HandoverView }) {
  const s = handover.standing;
  const cur = handover.currencyCode;
  return (
    <Card plain padding="sm" className="text-note space-y-1">
      <p className="text-[var(--sys-foreground)]">
        {handover.reference} · {handover.orders} طلب
      </p>
      <p className="tabular-nums text-[var(--sys-foreground)]">
        المطلوب <b><Money value={s.claimed} currency={cur} /></b> · استلمت <b><Money value={s.received} currency={cur} /></b>
        {s.remaining > 0 && <> · باقي <b><Money value={s.remaining} currency={cur} /></b></>}
      </p>
      {s.over > 0 && (
        <p className="tabular-nums text-[var(--sys-destructive)]">
          زيادة <Money value={s.over} currency={cur} /> عن المطلوب
        </p>
      )}
      {handover.receipts.length > 0 && <p className="text-[var(--sys-warning)]">{NOT_APPROVED_YET}</p>}
    </Card>
  );
}

/**
 * One line per currency — the amount, the rate(s) it was typed at, and what it is worth in the orders' currency. Lines, not a
 * table: four short figures fit a phone's width, and a list of records drawn by hand as a table is what the one-table guard forbids.
 */
function CurrencyTable({ handover }: { handover: HandoverView }) {
  return (
    <ul aria-label="حسب العملة" className="border border-[var(--sys-border)] rounded-lg divide-y divide-[var(--sys-border)]">
      {handover.table.map((row) => (
        <li key={row.currencyCode} className="flex items-center justify-between px-3 py-1.5 text-note">
          <span className="tabular-nums text-[var(--sys-foreground)]">
            {row.currencyCode} <span dir="ltr">{row.amount}</span>
            {row.rates.length > 0 && <span className="text-[var(--sys-muted-foreground)]"> · السعر <span dir="ltr">{row.rates.join(' / ')}</span></span>}
          </span>
          <span className="tabular-nums">
            {row.equivalent === null ? (
              <span className="text-[var(--sys-destructive)]">بلا سعر صرف</span>
            ) : (
              <>يعادل <Money value={row.equivalent} currency={handover.currencyCode} /></>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ReceiptLine({ handover, wallets, onSaved }: { handover: HandoverView; wallets: CollectWallet[]; onSaved: () => unknown }) {
  const currencies = [...new Set(wallets.map((w) => w.currencyCode))];
  const [currency, setCurrency] = useState(handover.currencyCode);
  const [walletId, setWalletId] = useState('');
  const [amount, setAmount] = useState('');
  const [rate, setRate] = useState('');
  const [proof, setProof] = useState<{ fileName: string; content: string } | null>(null);
  /*
   * «رقم الحوالة / إثبات» — plain text, optional for EVERY wallet (23/11, the owner: some companies pay through «شام كاش»).
   * A transfer's reference (a Shamcash transaction number, a bank reference) travels in the receipts door's own `note` field;
   * cash may leave it empty. No wallet is assumed to be cash: any active wallet of this country and this currency is offered.
   */
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  /*
   * ONE ID PER LINE, KEPT ACROSS RETRIES. A courier pays twice the same 50 and that is two receipts; a press that timed out
   * and is pressed again is ONE. Only this id tells the server which: it survives a failure and a second press, and is
   * renewed only once the receipt is saved.
   */
  const lineId = useRef(crypto.randomUUID());

  const offered = wallets.filter((w) => w.currencyCode === currency);
  const needsRate = currency !== handover.currencyCode;
  const converted =
    needsRate && Number(amount) > 0 && Number(rate) > 0
      ? receiptsInStatementCurrency(
          [{ amount: Number(amount), currencyCode: currency, exchangeRate: Number(rate) }],
          handover.currencyCode,
          minorUnitFor(handover.currencyCode) ?? 2
        ).received
      : null;

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (saving) return;
        setSaving(true);
        setError(null);
        setSaid(null);
        try {
          await apiJson(`/api/finance/statements/${handover.id}/receipts`, {
            method: 'POST',
            body: JSON.stringify({
              receiptId: lineId.current,
              walletId,
              amount: Number(amount),
              ...(needsRate && rate ? { exchangeRate: Number(rate) } : {}),
              ...(reference.trim() ? { note: reference.trim() } : {}),
              ...(proof ? { proof } : {}),
            }),
          });
          lineId.current = crypto.randomUUID();
          setAmount('');
          setRate('');
          setProof(null);
          setReference('');
          setSaid('انسجّلت الدفعة — المحفظة ما بتتحرك قبل «اعتماد».');
          await onSaved();
        } catch (err) {
          setError(err instanceof Error ? err.message : 'تعذّر تسجيل الدفعة');
        } finally {
          setSaving(false);
        }
      }}
      className="space-y-2"
    >
      <p className="text-note font-medium text-[var(--sys-foreground)]">سجّل دفعة</p>
      <div className="grid grid-cols-2 gap-2">
        <Select
          label="العملة"
          value={currency}
          onChange={(e) => {
            setCurrency(e.target.value);
            setWalletId('');
          }}
        >
          {[...new Set([handover.currencyCode, ...currencies])].map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </Select>
        <Select label="المحفظة" value={walletId} onChange={(e) => setWalletId(e.target.value)} required>
          <option value="">اختر…</option>
          {offered.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
              {w.unassigned ? ' (غير مخصّصة)' : ''}
            </option>
          ))}
        </Select>
        <Input
          label={`المبلغ (${currency})`}
          type="number"
          step="0.001"
          min="0.001"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
          dir="ltr"
        />
        {needsRate && (
          <Input
            label={`سعر الصرف (${handover.currencyCode} → ${currency})`}
            type="number"
            step="0.000001"
            min="0.000001"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            required
            dir="ltr"
            helperText={converted !== null ? `يساوي ${converted} ${handover.currencyCode}` : undefined}
          />
        )}
      </div>
      {offered.length === 0 && (
        <p className="text-note text-[var(--sys-destructive)]">ما في محفظة فعّالة بعملة {currency} من بلد هالمتجر.</p>
      )}
      <Input
        label="رقم الحوالة / إثبات (اختياري)"
        value={reference}
        onChange={(e) => setReference(e.target.value)}
        maxLength={300}
        placeholder="مثال: رقم عملية شام كاش — أو فاضي للنقد"
      />
      <label className="block">
        <span className="mb-1 block text-note text-[var(--sys-muted-foreground)]">صورة أو PDF (اختياري)</span>
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          onChange={async (e) => {
            const picked = e.target.files?.[0];
            setError(null);
            if (!picked) return setProof(null);
            if (picked.size > HANDOVER_MAX_PROOF_MB * 1024 * 1024) {
              setProof(null);
              e.target.value = '';
              setError(`حجم الملف أكبر من ${HANDOVER_MAX_PROOF_MB} ميجابايت`);
              return;
            }
            setProof({ fileName: picked.name, content: await fileToBase64(picked) });
          }}
          className="w-full text-note"
        />
      </label>
      {error && <p role="alert" className="text-sm text-[var(--sys-destructive)]">{error}</p>}
      {said && <p className="text-note text-[var(--sys-success)]">{said}</p>}
      <div className="flex justify-end">
        <Button type="submit" variant="secondary" disabled={saving || !walletId || !amount}>
          <RiHandCoinLine className="w-4 h-4" aria-hidden />
          {saving ? 'جارٍ التسجيل…' : 'سجّل الدفعة'}
        </Button>
      </div>
    </form>
  );
}

function Approve({
  handover,
  mayApprove,
  onApproved,
}: {
  handover: HandoverView;
  mayApprove: boolean;
  onApproved: (message: string) => void;
}) {
  const [explanation, setExplanation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hasReceipts = handover.receipts.length > 0;
  const needsWhy = handover.gap.needsExplanation;
  const why = explanation.trim();

  if (!mayApprove) {
    return (
      <Card plain padding="sm" className="text-note">
        <p role="alert" className="text-[var(--sys-muted-foreground)]">{NO_APPROVE_SENTENCE}</p>
      </Card>
    );
  }

  return (
    <div className="space-y-2 border-t border-[var(--sys-border)] pt-3">
      {needsWhy && hasReceipts && (
        <Input
          label="تفسير الفرق (إلزامي للاعتماد)"
          value={explanation}
          onChange={(e) => setExplanation(e.target.value)}
          placeholder="مثال: باقي يدفعه بكرا، أو زيادة رجعناها"
          minLength={5}
        />
      )}
      {error && <p role="alert" className="text-sm text-[var(--sys-destructive)]">{error}</p>}
      <div className="flex justify-end">
        <Button
          type="button"
          variant="primary"
          disabled={busy || !hasReceipts || (needsWhy && why.length < 5)}
          onClick={async () => {
            if (busy) return;
            setBusy(true);
            setError(null);
            try {
              await apiJson(`/api/finance/statements/${handover.id}/match`, { method: 'POST' });
              await apiJson(`/api/finance/statements/${handover.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ approve: true, ...(needsWhy && why ? { gapExplanation: why } : {}) }),
              });
              onApproved(`انعتمد «${handover.reference}» — انكتب المبلغ بالمحافظ مرة وحدة.`);
            } catch (err) {
              setError(err instanceof Error ? err.message : 'تعذّر الاعتماد');
            } finally {
              setBusy(false);
            }
          }}
        >
          <RiCheckDoubleLine className="w-4 h-4" aria-hidden />
          {busy ? 'جارٍ الاعتماد…' : 'اعتماد'}
        </Button>
      </div>
      {!hasReceipts && <p className="text-note text-[var(--sys-muted-foreground)]">سجّل دفعة أولاً — الاعتماد بيجي بعدها.</p>}
    </div>
  );
}
