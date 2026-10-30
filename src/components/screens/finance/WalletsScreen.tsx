'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { Modal } from '@/components/ui/Modal';
import { useConfirm } from '@/components/ui/Confirm';
import { ScreenTitle } from '@/components/shell/ScreenTitle';
import { AdvancedGroup } from '@/components/ui/AdvancedGroup';
import { RiAddCircleLine, RiArrowGoBackLine, RiCheckLine, RiCloseLine, RiDeleteBinLine, RiLoader4Line, RiPencilLine, RiScales3Line, RiShutDownLine, RiWallet3Line } from '@remixicon/react';
import { useToast } from '@/components/ui/Toast';
import { Rows, type Column } from '@/components/ui/Rows';
import { Money } from '@/components/ui/Money';
import { useStoreCurrency } from '@/context/StoreCurrency';
import { moneyDigits } from '@/lib/money';
import { useIsPhone } from '@/hooks/useIsPhone';
import { EmptyState } from '@/components/ui/EmptyState';
import { arDateTime } from '@/lib/format';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';
import { COURIER_MONEY_HINT, OWN_LEDGER, OWN_LEDGER_HINT, handCategoriesFor, ownLedgerCategories } from '@/lib/hand-movement-rules';

/**
 * /finance/wallets — balances and the movement ledger. A recorded movement is
 * never edited or deleted: the only correction is a reversing entry that
 * carries a reason and stays linked to the original, so both lines remain
 * visible forever.
 */

interface WalletRow {
  id: string;
  name: string;
  currencyCode: string;
  isActive: boolean;
  opening: number;
  in: number;
  out: number;
  balance: number;
  movements: number;
  country: { id: string; name: string } | null;
  /** The signed physical count behind `opening`, once one has been taken. */
  openingCount: {
    countedAmount: number;
    countedByName: string;
    countedAt: string;
    note: string | null;
  } | null;
}

interface Movement {
  id: string;
  direction: 'IN' | 'OUT';
  amount: number;
  party: string;
  category: string;
  note: string | null;
  reversalReason: string | null;
  createdAt: string;
  createdByName: string | null;
  isReversal: boolean;
  wasReversed: boolean;
  /** What wrote it: «EXPENSE» is a movement of an expense, whose reversal also cancels the expense. */
  referenceType?: string | null;
}

const CATEGORY_AR: Record<string, string> = {
  COURIER_SETTLEMENT: 'تحصيل شركة شحن',
  COMMISSION: 'عمولة',
  EXPENSE: 'مصروف',
  TRANSFER_IN: 'تحويل وارد',
  TRANSFER_OUT: 'تحويل صادر',
  ADJUSTMENT: 'تسوية',
  OTHER: 'أخرى',
};

export function WalletsScreen() {
  const { currentUser } = useApp();
  // The screen opens on the cash box's VIEW key (PR-9). Managing the wallets and recording the cash are two keys of their
  // own, and a control is drawn only for the key its door asks — so nobody is offered a press that ends in a refusal.
  const mayManage = userCan(currentUser, 'finance.wallets_manage');
  const mayCash = userCan(currentUser, 'finance.cashbox');
  const ask = useConfirm();
  const toast = useToast();
  // The phone draws a different SET of controls (the day's press first, the upkeep folded under it), not the desk's
  // row squeezed into 343px: exactly one copy of each button is drawn, and the desk is the layout it always was.
  const phone = useIsPhone();
  const store = useStoreCurrency();
  /*
   * A FIGURE ON A CARD MUST SHOW WHAT THE DESK SHOWS, TO THE LAST DIGIT.
   * The desk prints the raw number. `Money` rounds to the decimals of the currency it is given, and for a currency
   * that is not the store's it guesses two — which would turn 12.345 into 12.35 on a phone. So the card asks for the
   * currency's own decimals, and never fewer than the figure actually has: formatting is added (separators, a code),
   * a digit is never taken away. Display only; nothing here changes a stored or sent amount.
   */
  const digitsFor = (code: string | null | undefined, ...figures: number[]) =>
    Math.max(
      moneyDigits({ currency: code, store }),
      ...figures.map((n) => (String(n).split('.')[1] ?? '').length)
    );
  const [wallets, setWallets] = useState<WalletRow[] | null>(null);
  const [active, setActive] = useState<string>('');
  const [movements, setMovements] = useState<Movement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState('');
  const [recordOpen, setRecordOpen] = useState(false);
  const [countOpen, setCountOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [reverseFor, setReverseFor] = useState<Movement | null>(null);

  const loadWallets = useCallback(async () => {
    try {
      const data = await apiJson<{ wallets: WalletRow[] }>('/api/finance/wallets');
      setWallets(data.wallets);
      setActive((current) => current || data.wallets[0]?.id || '');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, []);

  const loadMovements = useCallback(async (id: string) => {
    if (!id) return;
    setMovements(null);
    try {
      const data = await apiJson<{ movements: Movement[] }>(`/api/finance/wallets/${id}/movements`);
      setMovements(data.movements);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, []);

  useEffect(() => {
    void loadWallets();
  }, [loadWallets]);

  useEffect(() => {
    void loadMovements(active);
  }, [active, loadMovements]);

  const wallet = wallets?.find((w) => w.id === active) ?? null;

  async function refresh(message: string) {
    setDone(message);
    await Promise.all([loadWallets(), loadMovements(active)]);
  }

  const patchWallet = async (body: Record<string, unknown>, ok: string) => {
    if (!wallet) return;
    setBusy(true);
    setDone(null);
    try {
      await apiJson(`/api/finance/wallets/${wallet.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setDone(ok);
      setRenaming(false);
      await loadWallets();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الحفظ');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Delete asks the server, which decides. A wallet any money has passed
   * through is stopped instead and says what is holding it — its movements
   * ARE the ledger, and there is nothing to re-enter.
   */
  const removeWallet = async () => {
    if (!wallet) return;
    const ok = await ask({
      title: `حذف «${wallet.name}»؟`,
      body: 'إن مرّ بها أي مبلغ فستُوقَف بدل الحذف، والسجلّات تبقى كما هي.',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(true);
    setDone(null);
    try {
      const d = await apiJson<{ message?: string; deleted?: boolean }>(
        `/api/finance/wallets/${wallet.id}`,
        { method: 'DELETE' }
      );
      setDone(d.message ?? null);
      if (d.deleted) setActive('');
      await loadWallets();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الحذف');
    } finally {
      setBusy(false);
    }
  };

  /*
   * THE HEADER'S PRESSES, EACH DRAWN ONCE.
   * They are named here so the desk and the phone can arrange the same four controls differently (see the row below)
   * without a second copy of any of them: a copy is a button two tests and one screen reader cannot tell apart.
   */
  // A STOPPED wallet is the one case where the day's work needs «أعِد تشغيلها»: «record» is disabled until it runs,
  // so the way out must not sit under a fold that says «إيقاف». It is drawn beside the balance, and only while stopped.
  const restartButton =
    wallet && !renaming && !wallet.isActive && mayManage ? (
      <button
        onClick={() => patchWallet({ isActive: true }, 'أُعيد تشغيل المحفظة')}
        disabled={busy}
        className="h-11 md:h-8 px-3 rounded-lg border border-[var(--sys-success)]/60 text-[var(--sys-success)] text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-40"
      >
        <RiShutDownLine className="w-4 h-4" /> أعِد تشغيلها
      </button>
    ) : null;
  // Rename, stop and delete are maintenance, not the day's work: they fold into «متقدم». Nothing is removed.
  const upkeep =
    wallet && !renaming && mayManage ? (
      <AdvancedGroup
        key={wallet.id}
        className={phone ? 'w-full' : undefined}
        holds={wallet.isActive ? 'تعديل الاسم · إيقاف · حذف' : 'تعديل الاسم · حذف'}
      >
        <button
          onClick={() => { setRenaming(true); setNewName(wallet.name); }}
          aria-label="عدّل الاسم" title="عدّل الاسم"
          className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 cursor-pointer rounded-lg p-1.5 text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-primary-soft)] hover:text-[var(--sys-primary)]"
        >
          <RiPencilLine className="w-4 h-4" />
        </button>
        {wallet.isActive && (
          <button
            onClick={() => patchWallet({ isActive: false }, 'أُوقِفت المحفظة')}
            disabled={busy}
            title="أوقف المحفظة" aria-label="أوقف المحفظة"
            className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 cursor-pointer rounded-lg p-1.5 disabled:opacity-40 text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-warning-soft)] hover:text-[var(--sys-warning)]"
          >
            <RiShutDownLine className="w-4 h-4" />
          </button>
        )}
        <button aria-label="احذف"
          onClick={removeWallet}
          disabled={busy}
          title="احذف"
          className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 cursor-pointer rounded-lg p-1.5 text-[var(--sys-muted)] hover:bg-[var(--sys-destructive-soft)] hover:text-[var(--sys-destructive)] disabled:opacity-40"
        >
          <RiDeleteBinLine className="w-4 h-4" />
        </button>
      </AdvancedGroup>
    ) : null;
  // Offered only while it is still true. A wallet that has started moving is reconciled by the daily closing, and the
  // server refuses this outright — so showing the button there would be an invitation to a red error.
  const countButton =
    wallet && !renaming && wallet.movements === 0 && !wallet.openingCount && mayCash ? (
      <button
        onClick={() => setCountOpen(true)}
        disabled={busy}
        title="سجّل العدّ الافتتاحيّ"
        className="h-11 md:h-8 px-3 rounded-lg border border-[var(--sys-warning)]/60 text-[var(--sys-warning)] text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-40"
      >
        <RiScales3Line className="w-4 h-4" /> العدّ الافتتاحيّ
      </button>
    ) : null;
  const recordButton = mayCash ? (
    <button
      disabled={!wallet?.isActive}
      onClick={() => setRecordOpen(true)}
      className="h-11 md:h-8 px-3 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
    >
      <RiAddCircleLine className="w-4 h-4" /> حركة جديدة
    </button>
  ) : null;

  /*
   * THE LEDGER ON A CARD: WHO, HOW MUCH, THEN THE REST.
   * The desk's table keeps its columns (date, party, kind, in, out, by). A card drawn from those printed the date AND
   * the party in bold and then «وارد» and «صادر» as two lines of which one is always empty. On a phone the card is
   * led by the party and ONE signed figure; the note, which can be a sentence, gets the width of the card.
   */
  const movementColumns: Column<Movement>[] = phone
    ? [
        { key: 'c1', label: 'الطرف', primary: true, render: (m) => m.party },
        {
          key: 'amt',
          label: 'المبلغ',
          primary: true,
          // Which way the money went is the sign and the colour — no empty «صادر» line on a card that is an «وارد».
          render: (m) => (
            <span dir="ltr" className="whitespace-nowrap">
              {m.direction === 'IN' ? '+' : '−'}
              <Money
                value={m.amount}
                currency={wallet?.currencyCode}
                minorUnit={digitsFor(wallet?.currencyCode, m.amount)}
                tone={m.direction === 'IN' ? 'collected' : 'lost'}
              />
            </span>
          ),
        },
        { key: 'c0', label: 'التاريخ', render: (m) => arDateTime(m.createdAt) },
        { key: 'c2', label: 'البند', render: (m) => CATEGORY_AR[m.category] ?? m.category },
        {
          key: 'note',
          label: 'الملاحظة',
          wide: true,
          render: (m) => (
            <>
              {m.note ?? '—'}
              {m.reversalReason && (
                <span className="block text-xs text-[var(--sys-destructive)]">قيد عكسي: {m.reversalReason}</span>
              )}
            </>
          ),
        },
      ]
    : [
        { key: 'c0', label: "التاريخ", primary: true,
          render: (m) => (
            <>{arDateTime(m.createdAt)}</>
          ) },
        { key: 'c1', label: "الطرف", primary: true,
          render: (m) => (
            <>{m.party}
              {m.note && <span className="block text-xs text-[var(--sys-muted)]">{m.note}</span>}
              {m.reversalReason && (
                <span className="block text-xs text-[var(--sys-destructive)]">قيد عكسي: {m.reversalReason}</span>
              )}</>
          ) },
        { key: 'c2', label: "البند",
          render: (m) => (CATEGORY_AR[m.category] ?? m.category) },
        { key: 'c3', label: "وارد", align: 'end',
          render: (m) => (m.direction === 'IN' ? m.amount : '') },
        { key: 'c4', label: "صادر", align: 'end',
          render: (m) => (m.direction === 'OUT' ? m.amount : '') },
        { key: 'c5', label: "سجّلها",
          render: (m) => (m.createdByName ?? '—') },
      ];


  return (
    <div className="max-w-6xl space-y-3">
      <ScreenTitle />

      {/* On a phone the sentence takes the whole line and the button sits under it: side by side the sentence was
          squeezed into five lines with the button floating in the middle of them. */}
      <div className={phone ? 'flex flex-col gap-2' : 'flex items-center justify-between gap-3'}>
        <p className="text-xs text-[var(--sys-muted-foreground)]">
          المحفظة تتبع متجراً واحداً وتحمل عملته. حركاتها سجل دائم: ما مرّ بها مبلغ يُوقَف
          ولا يُحذف — ولا يُحذف فعلياً إلا ما لم يمرّ به شيء.
        </p>
        {mayManage && (
        <button
          onClick={() => setCreating(true)}
          className="h-11 md:h-10 px-3 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-xs font-medium inline-flex items-center gap-1.5 shrink-0"
        >
          <RiAddCircleLine className="w-4 h-4" /> محفظة جديدة
        </button>
        )}
      </div>

      {!wallets ? (
        <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-16">
          <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
        </div>
      ) : wallets.length === 0 ? (
        <EmptyState
          icon={RiWallet3Line}
          title="لا محافظ بعد"
          why="المحفظة هي مكان النقد: رصيدها هو ما في الصندوق. أنشئ واحدة ليُسجَّل عليها الداخل والخارج."
          action={mayManage ? { label: 'أنشئ أول محفظة', onClick: () => setCreating(true) } : undefined}
        />
      ) : (
        <>
          <div className={phone ? 'grid gap-2' : 'grid gap-3 sm:grid-cols-2 lg:grid-cols-3'}>
            {wallets.map((w) => (
              <button
                key={w.id}
                onClick={() => setActive(w.id)}
                className={`text-right bg-[var(--sys-card)] border rounded-lg ${phone ? 'p-3' : 'p-4'} transition ${
                  w.id === active ? 'border-[var(--sys-primary)] ring-1 ring-[var(--sys-primary)]/20' : 'border-[var(--sys-border)]'
                }`}
              >
                <span className="flex items-center justify-between">
                  <span className="text-sm font-medium text-[var(--sys-heading)]">{w.name}</span>
                  {!w.isActive && <span className="text-xs text-[var(--sys-muted)] border border-[var(--sys-border)] rounded-full px-2 py-0.5">موقوفة</span>}
                </span>
                {phone ? (
                  /* A card a finger scrolls past, six of them: the balance with its thousands separators and its code,
                     and the three figures behind it each under its own name instead of one dense line of raw numbers. */
                  <>
                    {/* The four figures of one wallet share one count of decimals, so they line up and none loses a digit. */}
                    <Money
                      value={w.balance}
                      currency={w.currencyCode}
                      minorUnit={digitsFor(w.currencyCode, w.balance, w.opening, w.in, w.out)}
                      className="mt-1 block text-lg font-semibold text-[var(--sys-heading)]"
                    />
                    <span className="mt-1 grid grid-cols-3 gap-2 text-xs text-[var(--sys-muted-foreground)]">
                      <span>افتتاحي <Money value={w.opening} currency={null} minorUnit={digitsFor(w.currencyCode, w.balance, w.opening, w.in, w.out)} className="block text-[var(--sys-foreground)]" /></span>
                      <span>وارد <Money value={w.in} currency={null} minorUnit={digitsFor(w.currencyCode, w.balance, w.opening, w.in, w.out)} className="block text-[var(--sys-foreground)]" /></span>
                      <span>صادر <Money value={w.out} currency={null} minorUnit={digitsFor(w.currencyCode, w.balance, w.opening, w.in, w.out)} className="block text-[var(--sys-foreground)]" /></span>
                    </span>
                  </>
                ) : (
                  <>
                    <span className="block text-2xl font-semibold text-[var(--sys-heading)] tabular-nums mt-2">
                      {w.balance} <span className="text-sm font-normal text-[var(--sys-muted-foreground)]">{w.currencyCode}</span>
                    </span>
                    <span className="block text-xs text-[var(--sys-muted-foreground)] mt-1 tabular-nums">
                      افتتاحي {w.opening} · وارد {w.in} · صادر {w.out}
                    </span>
                  </>
                )}
                {/* An opening balance nobody counted is a number somebody
                    typed, and it is a term in every daily closing after it.
                    Said on the card because that is where the number is. */}
                {w.openingCount ? (
                  <span className="mt-1 block text-xs text-[var(--sys-success)]">
                    عُدَّ بمعرفة {w.openingCount.countedByName} · {w.openingCount.countedAt.slice(0, 10)}
                  </span>
                ) : (
                  w.movements === 0 && (
                    <span className="mt-1 block text-xs text-[var(--sys-warning)]">
                      رصيدٌ افتتاحيٌّ غير معدود
                    </span>
                  )
                )}
              </button>
            ))}
          </div>

          {error && <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">{error}</p>}
          {done && <p className="text-sm text-[var(--sys-success)] bg-[var(--sys-success-soft)] border border-[var(--sys-success)]/30 rounded-lg p-3">{done}</p>}

          <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg overflow-hidden">
            {/* The wallet's own actions live here, on the one that is
                selected — not repeated on every card, where they would be
                twelve buttons for one decision. */}
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-[var(--sys-border)]">
              {renaming && wallet ? (
                <span className="flex items-center gap-1.5">
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    className="h-11 md:h-8 w-44 rounded-lg border border-[var(--sys-border-input)] px-2 text-sm"
                  />
                  <button
                    onClick={() => patchWallet({ name: newName.trim() }, 'تم تغيير الاسم')}
                    disabled={busy || newName.trim().length < 2}
                    aria-label="احفظ" title="احفظ"
                    className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 cursor-pointer rounded-lg p-1.5 text-[var(--sys-success)] hover:bg-[var(--sys-success-soft)] disabled:opacity-40"
                  >
                    <RiCheckLine className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setRenaming(false)}
                    aria-label="ألغِ" title="ألغِ"
                    className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 cursor-pointer rounded-lg p-1.5 text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-surface)]"
                  >
                    <RiCloseLine className="w-4 h-4" />
                  </button>
                </span>
              ) : (
                <h2 className="text-sm font-medium text-[var(--sys-heading)]">حركات {wallet?.name ?? ''}</h2>
              )}

              {/* The desk keeps the row it always had: upkeep, the count, a divider, then the day's press. On a phone the
                  press that is the screen's work comes FIRST and the upkeep folds into a line of its own underneath:
                  all of it in one row needed about 500px of a 309px space, so the labels broke inside their boxes and
                  spilled over each other. */}
              <span className={phone ? 'flex w-full flex-wrap items-center gap-1.5' : 'flex items-center gap-1.5'}>
                {phone ? (
                  <>
                    {recordButton}
                    {restartButton}
                    {countButton}
                    {upkeep}
                  </>
                ) : (
                  <>
                    {wallet && !renaming && (
                      <>
                        {restartButton}
                        {upkeep}
                        {countButton}
                        <span className="mx-1 h-5 w-px bg-[var(--sys-border)]" />
                      </>
                    )}
                    {recordButton}
                  </>
                )}
              </span>
            </div>

            {!movements ? (
              <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-12">
                <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
              </div>
            ) : movements.length === 0 ? (
              <p className="text-sm text-[var(--sys-muted-foreground)] py-10 text-center">لا حركات بعد.</p>
            ) : (
                            <Rows
                rows={movements}
                keyOf={(m) => m.id}
                columns={movementColumns}
                empty={
                  <EmptyState
                    title="لا حركاتٍ على هذه المحفظة"
                    why="كلُّ تحصيلٍ وصرفٍ وتحويلٍ يكتب حركةً هنا. فراغُها يعني أنّ المحفظة لم يمرّ بها مال بعد."
                    // The header's button is disabled for a stopped wallet; so is this one — absent, rather.
                    action={wallet?.isActive && mayCash ? { label: 'سجّل أول حركة', onClick: () => setRecordOpen(true) } : undefined}
                  />
                }
                actions={(m) => (
                  <>{m.wasReversed ? (
                          <span className="text-xs text-[var(--sys-muted)]">عُكِست</span>
                        ) : m.isReversal ? (
                          <span className="text-xs text-[var(--sys-muted)]">قيد عكسي</span>
                        ) : !mayCash ? null : (
                          <button
                            onClick={() => setReverseFor(m)}
                            className="text-xs text-[var(--sys-primary)] hover:underline inline-flex items-center gap-1"
                          >
                            <RiArrowGoBackLine className="icon-mirror w-4 h-4" /> قيد عكسي
                          </button>
                        )}</>
                )}
              />
            )}
          </div>
        </>
      )}

      {creating && (
        <CreateWalletDialog
          onClose={() => setCreating(false)}
          onSaved={async (message) => {
            setCreating(false);
            await refresh(message);
          }}
        />
      )}

      {countOpen && wallet && (
        <OpeningCountDialog
          wallet={wallet}
          onClose={() => setCountOpen(false)}
          onDone={(message) => {
            setCountOpen(false);
            setDone(message);
            void loadWallets();
          }}
        />
      )}

      {recordOpen && wallet && (
        <RecordDialog
          wallet={wallet}
          onClose={() => setRecordOpen(false)}
          onSaved={async () => {
            setRecordOpen(false);
            await refresh('سُجِّلت الحركة');
          }}
        />
      )}

      {reverseFor && wallet && (
        <ReverseDialog
          wallet={wallet}
          movement={reverseFor}
          onClose={() => setReverseFor(null)}
          onSaved={async () => {
            setReverseFor(null);
            await refresh('سُجِّل القيد العكسي — القيد الأصلي باقٍ كما هو');
          }}
        />
      )}
    </div>
  );
}

/**
 * THE SIGNED PHYSICAL COUNT.
 *
 * Three fields and one of them is the point: the NAME OF WHOEVER COUNTED. The
 * logged-in user is already recorded separately, and they are usually not the
 * person holding the drawer — so asking for a name is not duplication, it is
 * the difference between «who typed 4,350» and «who counted 4,350».
 *
 * The time defaults to now and can be moved back, because the count is taken
 * at the switch time and entered afterwards; the server refuses a future one.
 */
function OpeningCountDialog({
  wallet,
  onClose,
  onDone,
}: {
  wallet: WalletRow;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [amount, setAmount] = useState('');
  const [countedByName, setCountedByName] = useState('');
  const [countedAt, setCountedAt] = useState(() => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = amount.trim() !== '' && Number.isFinite(Number(amount)) && countedByName.trim().length >= 3 && countedAt !== '';

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await apiJson(`/api/finance/wallets/${wallet.id}/opening-count`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          countedAmount: Number(amount),
          countedByName: countedByName.trim(),
          countedAt: new Date(countedAt).toISOString(),
          note: note.trim() || null,
        }),
      });
      onDone(`سُجّل العدّ الافتتاحيّ لـ«${wallet.name}»`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر الحفظ');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal isOpen onClose={onClose} title={`العدّ الافتتاحيّ — ${wallet.name}`}>
      <div className="space-y-3">
        <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
          المبلغ الموجود فعلاً في المحفظة لحظةَ العدّ. يُسجَّل مرّةً واحدةً ولا يُعاد، وهو حدٌّ في
          كلِّ إغلاقٍ يوميٍّ بعده — فإن بدأت الحركاتُ صار العدُّ شأنَ الإغلاق اليوميّ لا شأنَ هذه
          الشاشة.
        </p>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-[var(--sys-heading)]">
            المبلغ المعدود ({wallet.currencyCode}) *
          </span>
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="h-11 md:h-10 w-full rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-3 text-sm tabular-nums"
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-[var(--sys-heading)]">من عدَّ المبلغ *</span>
          <input
            value={countedByName}
            onChange={(e) => setCountedByName(e.target.value)}
            placeholder="الاسم كما يُوقَّع على ورقة العدّ"
            maxLength={120}
            className="h-11 md:h-10 w-full rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-3 text-sm"
          />
          <span className="mt-1 block text-xs text-[var(--sys-muted-foreground)]">
            اسمُ من عدَّ بيده، لا اسمُك — أنت مُسجَّلٌ أصلاً بوصفك من أدخل العدّ.
          </span>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-[var(--sys-heading)]">وقت العدّ *</span>
          <input
            type="datetime-local"
            value={countedAt}
            onChange={(e) => setCountedAt(e.target.value)}
            className="h-11 md:h-10 w-full rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-3 text-sm"
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-[var(--sys-heading)]">ملاحظة</span>
          <textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            className="w-full rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-3 py-2 text-sm"
          />
        </label>

        {error && (
          <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-sm text-[var(--sys-destructive)]">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="h-11 md:h-10 rounded-lg border border-[var(--sys-border)] px-3 text-sm text-[var(--sys-muted-foreground)]"
          >
            إلغاء
          </button>
          <button
            onClick={() => void submit()}
            disabled={!ready || busy}
            className="h-11 md:h-10 rounded-lg bg-[var(--sys-primary)] px-4 text-sm font-medium text-[var(--sys-primary-foreground)] disabled:opacity-50"
          >
            {busy ? <RiLoader4Line className="h-4 w-4 animate-spin" aria-hidden /> : 'سجّل العدّ'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function RecordDialog({
  wallet,
  onClose,
  onSaved,
}: {
  wallet: WalletRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [direction, setDirection] = useState<'IN' | 'OUT'>('OUT');
  const [amount, setAmount] = useState('');
  const [party, setParty] = useState('');
  const [category, setCategory] = useState(handCategoriesFor('OUT')[0]);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  return (
    <Modal isOpen onClose={onClose} title={`حركة جديدة — ${wallet.name}`}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError(null);
          try {
            await apiJson(`/api/finance/wallets/${wallet.id}/movements`, {
              method: 'POST',
              body: JSON.stringify({
                direction,
                amount: Number(amount),
                party: party.trim(),
                category,
                note: note.trim(),
              }),
            });
            onSaved();
          } catch (err) {
            setError(err instanceof Error ? err.message : 'تعذر الحفظ');
          } finally {
            setSaving(false);
          }
        }}
        className="space-y-3"
      >
        <div className="flex gap-2">
          {(['IN', 'OUT'] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => {
                setDirection(d);
                // The pair must stay one the door accepts.
                if (!handCategoriesFor(d).includes(category)) setCategory(handCategoriesFor(d)[0]);
              }}
              className={`flex-1 h-11 md:h-10 rounded-lg border text-sm font-medium ${
                direction === d
                  ? d === 'IN'
                    ? 'bg-[var(--sys-success-soft)] border-[var(--sys-success)]/60 text-[var(--sys-success)]'
                    : 'bg-[var(--sys-destructive-soft)] border-[var(--sys-destructive-border)] text-[var(--sys-destructive)]'
                  : 'border-[var(--sys-border)] text-[var(--sys-muted-foreground)]'
              }`}
            >
              {d === 'IN' ? 'وارد' : 'صادر'}
            </button>
          ))}
        </div>

        <label className="block">
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">المبلغ ({wallet.currencyCode})</span>
          <input
            type="number"
            step="0.001"
            min="0.001"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
            className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
            dir="ltr"
          />
        </label>

        <label className="block">
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">الطرف</span>
          <input
            value={party}
            onChange={(e) => setParty(e.target.value)}
            required
            minLength={2}
            placeholder="اسم الشخص أو الجهة"
            className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
          />
        </label>

        <label className="block">
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">البند</span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm bg-[var(--sys-card)]"
          >
            {Object.entries(CATEGORY_AR)
              .filter(([key]) => handCategoriesFor(direction).includes(key))
              .map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            {/* Listed, not removed: the pointer beside each one says which door writes it. */}
            {ownLedgerCategories().map((key) => (
              <option key={key} value={key} disabled>{CATEGORY_AR[key]} — {OWN_LEDGER[key].short}</option>
            ))}
          </select>
          <span className="block text-xs text-[var(--sys-muted)] mt-1">{COURIER_MONEY_HINT} {OWN_LEDGER_HINT} التحويلات من شاشة التحويلات.</span>
        </label>

        <label className="block">
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">الملاحظة (إلزامية)</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            required
            minLength={3}
            className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
          />
        </label>

        {error && <p className="text-sm text-[var(--sys-destructive)]">{error}</p>}

        <div className="flex gap-2 justify-end pt-1">
          <button type="button" onClick={onClose} className="h-11 md:h-10 px-4 rounded-lg border border-[var(--sys-border)] text-sm">
            إلغاء
          </button>
          <button
            type="submit"
            disabled={saving}
            className="h-11 md:h-10 px-4 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-medium disabled:opacity-50"
          >
            {saving ? 'جارٍ الحفظ…' : 'تسجيل'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ReverseDialog({
  wallet,
  movement,
  onClose,
  onSaved,
}: {
  wallet: WalletRow;
  movement: Movement;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  return (
    <Modal isOpen onClose={onClose} title="قيد عكسي">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError(null);
          try {
            await apiJson(`/api/finance/wallets/${wallet.id}/movements`, {
              method: 'PATCH',
              body: JSON.stringify({ movementId: movement.id, reason: reason.trim() }),
            });
            onSaved();
          } catch (err) {
            setError(err instanceof Error ? err.message : 'تعذر القيد العكسي');
          } finally {
            setSaving(false);
          }
        }}
        className="space-y-3"
      >
        <p className="text-sm text-[var(--sys-foreground)] bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg p-3">
          سيُسجَّل قيد معاكس بمبلغ <b className="tabular-nums">{movement.amount}</b> {wallet.currencyCode}{' '}
          ({movement.direction === 'IN' ? 'صادر' : 'وارد'}) مرتبطاً بالحركة الأصلية.
          القيد الأصلي لا يُحذف ولا يُعدَّل.
        </p>

        {movement.referenceType === 'EXPENSE' && (
          <p className="text-sm text-[var(--sys-foreground)] bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg p-3">
            هذه حركة مصروف: عكسها يُلغي المصروف من الربح أيضاً، ويبقى في سجل المصاريف مكتوباً «ملغى».
            يحتاج صلاحية «تعديل المالية».
          </p>
        )}

        <label className="block">
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">سبب القيد العكسي (إلزامي)</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            minLength={5}
            rows={3}
            className="w-full p-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
            placeholder="مثال: سُجِّل المبلغ مرتين بالخطأ"
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

/**
 * A TYPED NUMBER, OR «NOTHING» — AND A TYPED `0` IS A NUMBER.
 *
 * `JSON.stringify` DROPS an `undefined` property, so an empty box leaves the
 * field ABSENT on the wire and the door decides what absent means. That is
 * the pattern `17cbe93` and `509306a` established (`CourierFees`'s
 * `typedNumber`, `ManufacturingScreen`'s `onTheWire`), and the reason there
 * is no `0` left in this file: the default lives in `prisma/schema.prisma`
 * (`openingBalance Decimal @default(0)`) and in the door's zod
 * (`wallets/route.ts` `.default(0)`), and a third copy here is a third place
 * to change it.
 *
 * `Number('abc')` is `NaN`, and `JSON.stringify` writes `NaN` as `null` —
 * which the door's `z.number()` REFUSES by name. That is deliberate: the
 * unparseable value is not folded into «empty», because folding it into
 * «empty» is how a silent zero gets written. A `type="number"` box reports
 * `''` for unparseable input, so that branch is unreachable from this form
 * and reachable from any other client.
 */
function typedNumber(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  return Number(raw);
}

/**
 * Creating a wallet.
 *
 * It belongs to a COUNTRY and carries its own currency, which need not be
 * the country's: a Syrian business holding dollars is the normal case, not
 * the exception. The currency is fixed at creation because every movement
 * is recorded in it — changing it later would silently restate history.
 *
 * The opening balance is what is in it today, before any movement is
 * recorded. It is not a movement itself, which is why it never appears in
 * the ledger.
 */
function CreateWalletDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [countries, setCountries] = useState<{ id: string; name: string; currencyCode: string }[]>([]);
  const [countryId, setCountryId] = useState('');
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('');
  const [opening, setOpening] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiJson<{ countries: { id: string; name: string; currencyCode: string }[] }>('/api/geo/countries')
      .then((d) => {
        setCountries(d.countries);
        if (d.countries.length === 1) {
          setCountryId(d.countries[0].id);
          setCurrency(d.countries[0].currencyCode);
        }
      })
      .catch(() => undefined);
  }, []);

  const country = countries.find((c) => c.id === countryId);

  return (
    <Modal isOpen onClose={onClose} title="محفظة جديدة">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError(null);
          try {
            await apiJson('/api/finance/wallets', {
              method: 'POST',
              body: JSON.stringify({
                countryId,
                name: name.trim(),
                currencyCode: currency.trim().toUpperCase(),
                // Absent when the box is empty; the door's `.default(0)` and
                // the column's `@default(0)` decide, not this component.
                openingBalance: typedNumber(opening),
              }),
            });
            onSaved(`أُنشئت المحفظة ${name.trim()}`);
          } catch (err) {
            setError(err instanceof Error ? err.message : 'تعذر الإنشاء');
          } finally {
            setSaving(false);
          }
        }}
        className="space-y-3"
      >
        <label className="block">
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">البلد</span>
          <select
            value={countryId}
            onChange={(e) => {
              setCountryId(e.target.value);
              const picked = countries.find((c) => c.id === e.target.value);
              // Default to the country's currency; it stays editable.
              if (picked && !currency) setCurrency(picked.currencyCode);
            }}
            required
            className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm bg-[var(--sys-card)]"
          >
            <option value="">اختر…</option>
            {countries.map((c) => (
              <option key={c.id} value={c.id}>{c.name} — {c.currencyCode}</option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">اسم المحفظة</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            minLength={2}
            autoFocus
            placeholder="مثال: الصندوق النقدي، حساب البنك العربي"
            className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
          />
        </label>

        <label className="block">
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">العملة</span>
          <input
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            required
            maxLength={4}
            placeholder="USD"
            className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
            dir="ltr"
          />
          <span className="block text-xs text-[var(--sys-muted)] mt-1">
            ثلاثة أحرف (USD) أو أربعة (USDT). لا يمكن تغييرها لاحقاً — كل حركة تُسجَّل بها.
            {country && currency && currency !== country.currencyCode && (
              <span className="block text-[var(--sys-warning)] mt-0.5">
                تختلف عن عملة {country.name} ({country.currencyCode}) — مقبول، وسيُطلب سعر الصرف عند الحاجة.
              </span>
            )}
          </span>
        </label>

        <label className="block">
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">الرصيد الافتتاحي</span>
          <input
            type="number"
            step="0.001"
            value={opening}
            onChange={(e) => setOpening(e.target.value)}
            placeholder="0"
            className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
            dir="ltr"
          />
          <span className="block text-xs text-[var(--sys-muted)] mt-1">
            ما في المحفظة الآن قبل أي حركة. ليس حركة بحد ذاته، فلا يظهر في السجل.
          </span>
        </label>

        {error && <p className="text-sm text-[var(--sys-destructive)]">{error}</p>}

        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="h-11 md:h-10 px-4 rounded-lg border border-[var(--sys-border)] text-sm">
            إلغاء
          </button>
          <button
            type="submit"
            disabled={saving || !countryId}
            className="h-11 md:h-10 px-4 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-medium disabled:opacity-50"
          >
            {saving ? 'جارٍ الإنشاء…' : 'إنشاء'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
