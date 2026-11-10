'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { readTransfer, transferRefusal, type TransferSide } from '@/lib/transfer-kind';
import {
  boxTextFor,
  currencyWord,
  dealOf,
  formatRate,
  latinFigure,
  orientation,
  type DealInput,
  type Face,
  type PreviousRate,
} from '@/lib/transfer-rate';
import { minorUnitFor } from '@/lib/currencies';
import { ScreenTitle } from '@/components/shell/ScreenTitle';
import { RiArrowUpDownLine, RiLoader4Line, RiRepeatLine } from '@remixicon/react';
import { Rows } from '@/components/ui/Rows';
import { EmptyState } from '@/components/ui/EmptyState';
import { WalletChip } from '@/components/ui/WalletChip';
import { arDateTime } from '@/lib/format';
import { Money } from '@/components/ui/Money';
import { useIsPhone } from '@/hooks/useIsPhone';

/**
 * /finance/transfers — moving money between wallets, or changing one currency
 * for another. One transfer writes two movements in a single transaction, so a
 * transfer can never leave one side recorded and the other not. Across
 * currencies the exchange is given in whichever of three ways the person holds
 * it — the rate one way, the rate the other way, or the amount that arrived —
 * and what is stored with the transfer is the amount (see lib/transfer-rate).
 */

interface WalletRow {
  id: string;
  name: string;
  currencyCode: string;
  isActive: boolean;
  balance: number;
  countryId: string;
  storeId: string | null;
  store: { id: string; name: string } | null;
  country: { id: string; name: string; minorUnit?: number };
}

interface TransferRow {
  id: string;
  amountOut: number;
  amountIn: number;
  exchangeRate: number;
  note: string | null;
  createdAt: string;
  kindLabel?: string;
  from: { id: string; name: string; currencyCode: string; store?: { name: string } | null } | null;
  to: { id: string; name: string; currencyCode: string; store?: { name: string } | null } | null;
}

/** A wallet row, as the reader of the four transfer kinds needs it. */
const asSide = (w: WalletRow): TransferSide => ({
  id: w.id,
  name: w.name,
  currencyCode: w.currencyCode,
  storeId: w.storeId,
  countryId: w.countryId,
  storeName: w.store?.name ?? null,
  countryName: w.country?.name ?? null,
});

/** The decimals of a wallet's money: its country's, as the door counts them; the currency's own when the list did not say. */
const minorOf = (w: WalletRow) => w.country?.minorUnit ?? minorUnitFor(w.currencyCode) ?? 2;

const inputClass = 'w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm';

export function TransfersScreen() {
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [rows, setRows] = useState<TransferRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [amountOut, setAmountOut] = useState('');
  /**
   * What the person TYPED to say the exchange, and in which face — the truth the deal is worked from — and the pair of
   * currencies it was typed for. A figure belongs to the pair it was typed beside: choose another currency and it is
   * forgotten, because «13,000» typed for dollars and lira is not a rate for dollars and dinars.
   */
  const [typedFor, setTypedFor] = useState<{ face: Face; text: string; pair: string }>({ face: 'A', text: '', pair: '' });
  /** Which of the three boxes is showing. Flipping it changes the view, never the deal. */
  const [view, setView] = useState<Face>('A');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  /**
   * ONE ID PER ATTEMPT, KEPT ACROSS RETRIES.
   *
   * The 15-second timeout can lose the answer to a transfer that was written, and the button is pressed again. This id
   * is what lets the door tell a retry from a second transfer of the same sum: it survives a failed press and is
   * renewed only after a transfer is actually saved. (The same arrangement as a receipt's `receiptId`.)
   */
  const attemptId = useRef('');
  /** A second press while the first is on the wire: state is read after the next paint, this is read now. */
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    try {
      const [w, t] = await Promise.all([
        // Every wallet in the company: a transfer between stores, or
        // between countries, has to see both ends of itself.
        apiJson<{ wallets: WalletRow[] }>('/api/finance/wallets?scope=transfer'),
        apiJson<{ transfers: TransferRow[] }>('/api/finance/transfers'),
      ]);
      setWallets(w.wallets.filter((x) => x.isActive));
      setRows(t.transfers);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const from = wallets.find((w) => w.id === fromId);
  const to = wallets.find((w) => w.id === toId);

  /**
   * The wallets grouped the way the money is actually arranged: country,
   * then store, then the wallets in it. The picker is the only place this
   * shape needs to exist — it makes which kind of transfer you are about to
   * do visible before you have chosen anything.
   */
  const grouped = wallets.reduce<Map<string, Map<string, WalletRow[]>>>((acc, w) => {
    const country = w.country?.name ?? '—';
    const store = w.store?.name ?? 'بلا متجر';
    if (!acc.has(country)) acc.set(country, new Map());
    const byStore = acc.get(country)!;
    if (!byStore.has(store)) byStore.set(store, []);
    byStore.get(store)!.push(w);
    return acc;
  }, new Map());

  /** One side's wallets as chips; the one the other side holds is dimmed, because a wallet cannot send to itself. */
  const chips = (side: 'from' | 'to') => {
    const mine = side === 'from' ? fromId : toId;
    const theirs = side === 'from' ? toId : fromId;
    const pick = side === 'from' ? setFromId : setToId;
    return (
      <div className="space-y-2">
        {[...grouped].flatMap(([country, byStore]) =>
          [...byStore].map(([store, ws]) => (
            <div key={`${country}/${store}`} className="space-y-1">
              <p className="text-xs text-[var(--sys-muted)]">{`${country} · ${store}`}</p>
              <div className="flex flex-wrap gap-2">
                {ws.map((w) => (
                  <WalletChip
                    key={w.id}
                    wallet={w}
                    selected={w.id === mine}
                    disabled={w.id === theirs}
                    onPick={pick}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    );
  };

  const phone = useIsPhone();

  /** The two currencies, unordered: turning the transfer round keeps the pair, so it keeps what was typed. */
  const pair = from && to ? [from.currencyCode, to.currencyCode].map((c) => c.trim().toUpperCase()).sort().join('|') : '';
  const typed = typedFor.pair === pair ? typedFor : { face: typedFor.face, text: '', pair };

  /** What this pair of wallets IS. Read here, and checked again server-side. */
  const reading = from && to ? readTransfer(asSide(from), asSide(to)) : null;
  const refusal = from && to ? transferRefusal(asSide(from), asSide(to)) : null;
  const crossCurrency = !!reading?.needsRate;

  /**
   * THE DEAL, from what is typed — by the same functions the door judges with.
   *
   * Which of the two currencies is «the strong one» decides how a rate is said (always «weak per one strong»); it
   * is read from the table of currencies, and from the history for a currency the table does not know.
   */
  const previous: PreviousRate[] = (rows ?? []).flatMap((t) =>
    t.from && t.to ? [{ from: t.from.currencyCode, to: t.to.currencyCode, rate: t.exchangeRate }] : []
  );
  const o = from && to ? orientation(from.currencyCode, to.currencyCode, previous) : null;
  const dealInput: DealInput | null =
    from && to && o
      ? {
          from: from.currencyCode,
          to: to.currencyCode,
          fromName: from.name,
          toName: to.name,
          fromMinor: minorOf(from),
          toMinor: minorOf(to),
          amountOutText: amountOut,
          face: typed.face,
          text: typed.text,
          orientation: o,
        }
      : null;
  const deal = dealInput ? dealOf(dealInput) : null;
  const verdict = deal?.verdict ?? null;

  const strongWord = o ? currencyWord(o.strong, o.weak) : '';
  const weakWord = o ? currencyWord(o.weak, o.strong) : '';
  const faceLabel: Record<Face, string> = {
    A: `سعر الصرف: ${weakWord} لكل 1 ${strongWord}`,
    B: `سعر الصرف: ${strongWord} لكل 1 ${weakWord}`,
    C: 'المبلغ المستلم',
  };

  /** Reverse the direction and keep the deal: what arrived becomes what leaves, and the rate stays the same rate. */
  const swap = () => {
    if (!from || !to) return;
    // Only a deal the door would accept is carried over: a refused one (a rate that leaves nothing, an amount with too
    // many decimals) has no «what arrived» to turn into «what leaves».
    if (deal && verdict?.ok && deal.amountIn !== null && deal.amountOut !== null) {
      // The amount that arrived was typed: the two figures change places. A rate is tied to the currencies,
      // not to the direction, so it stays as it is.
      if (typed.face === 'C') setTypedFor({ face: 'C', text: String(deal.amountOut), pair });
      setAmountOut(String(deal.amountIn));
    }
    setFromId(to.id);
    setToId(from.id);
  };

  const problem = (): string | null => {
    if (!from || !to) return 'اختر المحفظتين';
    if (refusal) return refusal;
    if (!deal || deal.amountOut === null) return 'اكتب المبلغ اللي بدك تحوّلو';
    if (crossCurrency && deal.amountIn === null) return `اكتب ${faceLabel[view]}`;
    if (verdict && !verdict.ok) return verdict.error;
    return null;
  };

  return (
    <div className="max-w-5xl space-y-3">
      <ScreenTitle />

      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (inFlight.current) return;
          const said = problem();
          if (said) {
            setError(said);
            setDone(null);
            return;
          }
          inFlight.current = true;
          if (!attemptId.current) attemptId.current = crypto.randomUUID();
          setSaving(true);
          setError(null);
          setDone(null);
          try {
            await apiJson('/api/finance/transfers', {
              method: 'POST',
              body: JSON.stringify({
                transferId: attemptId.current,
                fromWalletId: fromId,
                toWalletId: toId,
                amountOut: deal!.amountOut,
                // The amount that arrives is what the card says; the door stores it as the record and derives the rate.
                ...(crossCurrency ? { amountIn: deal!.amountIn } : {}),
                note: note.trim(),
                // What the screen told the person they were doing. If the
                // server reads it differently, it refuses rather than
                // recording something nobody can explain later.
                expectKind: reading?.kind,
              }),
            });
            setDone(`تم ${reading?.label ?? 'التحويل'} — سُجِّلت حركتان: صادر من الأولى ووارد إلى الثانية`);
            setAmountOut('');
            setTypedFor({ face: typed.face, text: '', pair });
            setNote('');
            // The next transfer is a new attempt.
            attemptId.current = '';
            await load();
          } catch (err) {
            setError(err instanceof Error ? err.message : 'تعذر التحويل');
          } finally {
            inFlight.current = false;
            setSaving(false);
          }
        }}
        className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4 space-y-3"
      >
        <div role="group" aria-label="من محفظة" className="space-y-1">
          <span className="block text-xs font-medium text-[var(--sys-foreground)]">من محفظة</span>
          {chips('from')}
        </div>

        <button
          type="button"
          onClick={swap}
          disabled={!from || !to}
          className="h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border)] text-sm inline-flex items-center gap-2 disabled:opacity-50"
        >
          <RiArrowUpDownLine className="w-4 h-4" />
          عكس الاتجاه
        </button>

        <div role="group" aria-label="إلى محفظة" className="space-y-1">
          <span className="block text-xs font-medium text-[var(--sys-foreground)]">إلى محفظة</span>
          {chips('to')}
        </div>

        {/* What you are about to do, said before you do it. The four
            transfers are four different acts — one crosses two sets of
            books, one crosses a currency as well, one changes a currency
            inside the house — so the screen names the one in front of you
            rather than making you pick it first. */}
        {reading && !refusal && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] px-3 py-2">
            <span className="rounded-full bg-[var(--sys-primary)] px-2 py-0.5 text-xs font-semibold text-[var(--sys-primary-foreground)]">
              {reading.label}
            </span>
            <span className="text-xs text-[var(--sys-foreground)]">{reading.detail}</span>
          </div>
        )}

        <label className="block">
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">
            المبلغ اللي بدك تحوّلو {from ? `(${from.currencyCode})` : ''}
          </span>
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={amountOut}
            onChange={(e) => setAmountOut(latinFigure(e.target.value))}
            required
            className={inputClass}
            dir="ltr"
          />
        </label>

        {crossCurrency && o && (
          <fieldset className="space-y-2">
            <legend className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">كيف بدك تحدد القيمة؟</legend>
            <div className="flex flex-wrap gap-2">
              {(['A', 'B', 'C'] as const).map((f) => (
                <label
                  key={f}
                  className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 min-h-11 md:min-h-0 text-sm ${
                    view === f ? 'border-[var(--sys-primary)] bg-[var(--sys-surface)] font-semibold' : 'border-[var(--sys-border)] bg-[var(--sys-card)]'
                  }`}
                >
                  <input type="radio" name="transfer-face" checked={view === f} onChange={() => setView(f)} />
                  {faceLabel[f]}
                </label>
              ))}
            </div>

            <label className="block">
              <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">
                {view === 'C' ? `المبلغ المستلم (${to?.currencyCode})` : faceLabel[view]}
              </span>
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={dealInput && deal ? boxTextFor(view, dealInput, deal) : typed.text}
                onChange={(e) => setTypedFor({ face: view, text: latinFigure(e.target.value), pair })}
                required
                className={inputClass}
                dir="ltr"
              />
            </label>
          </fieldset>
        )}

        {from && to && (
          <div className="grid gap-2 md:grid-cols-3">
            <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-3">
              <p className="text-xs text-[var(--sys-muted)]">المحوَّل</p>
              <p className="text-sm font-medium tabular-nums">
                {deal?.amountOut != null ? <Money value={deal.amountOut} currency={from.currencyCode} minorUnit={minorOf(from)} /> : '—'}
              </p>
            </div>
            {crossCurrency && (
              <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-3">
                <p className="text-xs text-[var(--sys-muted)]">السعر اللي بينحفظ</p>
                <p className="text-sm font-medium tabular-nums">
                  {deal?.rate ? `${formatRate(deal.rate.weakPerStrong)} ${weakWord} لكل 1 ${strongWord}` : '—'}
                </p>
                {deal?.rate && (
                  <p className="text-xs text-[var(--sys-muted)] tabular-nums">
                    {`${formatRate(deal.rate.strongPerWeak)} ${strongWord} لكل 1 ${weakWord}`}
                  </p>
                )}
              </div>
            )}
            <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-3">
              <p className="text-xs text-[var(--sys-muted)]">المستلم</p>
              <p className="text-sm font-medium tabular-nums">
                {deal?.amountIn != null && deal.amountIn > 0 ? <Money value={deal.amountIn} currency={to.currencyCode} minorUnit={minorOf(to)} /> : '—'}
              </p>
            </div>
          </div>
        )}

        {verdict && !verdict.ok && (
          <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] px-3 py-2 text-xs text-[var(--sys-destructive)]">
            {verdict.error}
          </p>
        )}

        <label className="block">
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">الملاحظة (إلزامية)</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            required
            minLength={3}
            placeholder="سبب التحويل"
            className={inputClass}
          />
        </label>

        {error && <p className="text-sm text-[var(--sys-destructive)]">{error}</p>}
        {done && <p className="text-sm text-[var(--sys-success)]">{done}</p>}

        {/* On a phone the button is a line of its own, the width of it. */}
        <div className={phone ? 'flex flex-col gap-2' : 'flex justify-end'}>
          {refusal && (
            <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] px-3 py-2 text-xs text-[var(--sys-destructive)]">
              {refusal}
            </p>
          )}

          <button
            type="submit"
            disabled={saving || !!refusal}
            className={`h-11 md:h-10 px-4 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-medium inline-flex items-center gap-2 disabled:opacity-50 ${
              phone ? 'w-full justify-center' : ''
            }`}
          >
            {saving ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiRepeatLine className="w-4 h-4" />}
            تحويل
          </button>
        </div>
      </form>

      <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg overflow-hidden">
        <h2 className="text-sm font-medium text-[var(--sys-heading)] px-4 py-3 border-b border-[var(--sys-border)]">آخر التحويلات</h2>
        {!rows ? (
          <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-12">
            <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
          </div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-[var(--sys-muted-foreground)] py-10 text-center">لا تحويلات بعد.</p>
        ) : (
                    <Rows
            rows={rows}
            keyOf={(t) => t.id}
            columns={[
              { key: 'c0', label: "التاريخ", primary: true,
                render: (t) => (
                  <>{arDateTime(t.createdAt)}</>
                ) },
              { key: 'c1', label: "النوع", primary: true,
                render: (t) => (
                  <><span className="rounded-full border border-[var(--sys-border)] bg-[var(--sys-surface)] px-2 py-0.5 text-xs text-[var(--sys-foreground)] whitespace-nowrap">
                      {t.kindLabel ?? '—'}
                    </span></>
                ) },
              { key: 'c2', label: "من",
                render: (t) => (
                  <>{t.from?.name ?? '—'}
                    {t.from?.store && (
                      <span className="block text-xs text-[var(--sys-muted)]">{t.from.store.name}</span>
                    )}</>
                ) },
              { key: 'c3', label: "إلى",
                render: (t) => (
                  <>{t.to?.name ?? '—'}
                    {t.to?.store && (
                      <span className="block text-xs text-[var(--sys-muted)]">{t.to.store.name}</span>
                    )}</>
                ) },
              { key: 'c4', label: "الصادر", align: 'end',
                render: (t) => (
                  <Money value={t.amountOut} currency={t.from?.currencyCode} />
                ) },
              { key: 'c5', label: "الوارد", align: 'end',
                render: (t) => (
                  <>
                    <Money value={t.amountIn} currency={t.to?.currencyCode} />
                    {/* A card has no room for a rate column that reads «1» on every same-currency transfer; the rate
                        is said under the amount only when it is a rate (the desk's table keeps its own column). */}
                    {phone && t.exchangeRate !== 1 && (
                      <span className="block text-xs text-[var(--sys-muted)]">السعر {t.exchangeRate}</span>
                    )}
                  </>
                ) },
              { key: 'c6', label: "السعر", align: 'end', hideOnPhone: true,
                render: (t) => (t.exchangeRate) },
              { key: 'c7', label: "الملاحظة", wide: true,
                render: (t) => (t.note ?? '—') },
            ]}
            empty={
              <EmptyState
                title="لا تحويلاتٍ في هذه الفترة"
                why="التحويل ينقل مالاً بين محفظتين. فراغُ القائمة يعني أنّ لا مالَ تحرّك بين المحافظ هنا."
              />
            }
          />
        )}
      </div>
    </div>
  );
}
