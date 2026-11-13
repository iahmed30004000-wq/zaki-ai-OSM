'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { Modal } from '@/components/ui/Modal';
import { useConfirm } from '@/components/ui/Confirm';
import { ScreenTitle } from '@/components/shell/ScreenTitle';
import { AdvancedGroup } from '@/components/ui/AdvancedGroup';
import { RiAddCircleLine, RiArrowGoBackLine, RiCheckLine, RiCloseLine, RiDeleteBinLine, RiImageEditLine, RiLoader4Line, RiPencilLine, RiScales3Line, RiShutDownLine, RiWallet3Line } from '@remixicon/react';
import { useToast } from '@/components/ui/Toast';
import { Rows, type Column } from '@/components/ui/Rows';
import { Money } from '@/components/ui/Money';
import { WalletPicture } from '@/components/ui/WalletPicture';
import { WalletLookDialog } from './WalletLookDialog';
import { useStoreCurrency } from '@/context/StoreCurrency';
import { moneyDigits } from '@/lib/money';
import { useIsPhone } from '@/hooks/useIsPhone';
import { EmptyState } from '@/components/ui/EmptyState';
import { arDateTime } from '@/lib/format';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';
import { COURIER_MONEY_HINT, EXPENSE_HERE_HINT, OWN_LEDGER, OWN_LEDGER_HINT, handCategoriesFor, ownLedgerCategories } from '@/lib/hand-movement-rules';
import { afterDraw, type PartnerStatement } from '@/lib/partner-statement-core';
import { onTheWire, typedFigure } from '@/lib/typed-box';
import {
  EXPENSE_CATEGORY_AR,
  EXPENSE_FORM_HINT,
  EXPENSE_FORM_LABEL,
  EXPENSE_FORM_ORDER,
  type ExpenseCategory,
} from '@/lib/expense-grade';

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
  /** The look saved on the wallet (lib/wallet-look): each null until somebody chooses, and `walletLook` fills the gap. */
  imageKey?: string | null;
  iconKey?: string | null;
  colorKey?: string | null;
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
  // «السحوبات لازم تنضاف بند» (13/11): a partner's withdrawal, written by its own door and counted in the partners' statement.
  PARTNER_DRAW: 'سحب شريك',
};

/** The movement category the dialog opens the EXPENSE door for — the key `OWN_LEDGER` lists it under. */
const EXPENSE = 'EXPENSE';

/** The movement category the dialog opens the PARTNERS' door for: «سحب شريك», offered only to the holders of `finance.partners`. */
const PARTNER_DRAW = 'PARTNER_DRAW';

/** The type the expense box opens on: the profit screen's own default, so the two forms start the same way. */
const DEFAULT_EXPENSE_TYPE: ExpenseCategory = 'MARKETING';

/** What the greyed «مصروف» says when it is greyed ONLY because the money is coming IN (the person holds the key). */
const EXPENSE_IN_POINTER = 'صادر فقط — الراجع «تسوية» واردة';

/**
 * TODAY, AS THE PERSON'S OWN CALENDAR READS IT — what a date box holds.
 * `toISOString` is UTC: after midnight in Amman it still says yesterday, and an expense typed at 01:00 on the first
 * of the month would land in the month before.
 */
function todayForTheBox(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function WalletsScreen() {
  const { currentUser } = useApp();
  // The screen opens on the cash box's VIEW key (PR-9). Managing the wallets and recording the cash are two keys of their
  // own, and a control is drawn only for the key its door asks — so nobody is offered a press that ends in a refusal.
  const mayManage = userCan(currentUser, 'finance.wallets_manage');
  const mayCash = userCan(currentUser, 'finance.cashbox');
  // «مصروف» in the movement dialog is written by the EXPENSE door, whose key is `finance.create` — a third key, asked by that
  // door and not by the movements one. The dialog opens on the cash key; the option inside it is offered for this one.
  const mayExpense = userCan(currentUser, 'finance.create');
  // «سحب شريك» in the same dialog is written by the PARTNERS' door (`finance.partners`, and the cash box's key the dialog already
  // opened on). The dialog is offered it only when the person holds that key.
  const mayPartners = userCan(currentUser, 'finance.partners');
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
  // The same dialog opened from the TOP of the screen, where no wallet has been picked yet (see `RecordFromTop`).
  const [topOpen, setTopOpen] = useState(false);
  const [countOpen, setCountOpen] = useState(false);
  const [lookOpen, setLookOpen] = useState(false);
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
        holds={wallet.isActive ? 'تعديل الاسم · الشكل · إيقاف · حذف' : 'تعديل الاسم · الشكل · حذف'}
      >
        <button
          onClick={() => { setRenaming(true); setNewName(wallet.name); }}
          aria-label="عدّل الاسم" title="عدّل الاسم"
          className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 cursor-pointer rounded-lg p-1.5 text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-primary-soft)] hover:text-[var(--sys-primary)]"
        >
          <RiPencilLine className="w-4 h-4" />
        </button>
        {/* The wallet's face — a picture, or an icon and a colour. Drawn for the same key as the rename beside it. */}
        <button
          onClick={() => setLookOpen(true)}
          className="h-11 md:h-8 px-3 rounded-lg border border-[var(--sys-border)] text-[var(--sys-muted-foreground)] text-xs font-medium inline-flex items-center gap-1.5 hover:border-[var(--sys-primary)] hover:text-[var(--sys-primary)]"
        >
          <RiImageEditLine className="w-4 h-4" /> تعديل شكل المحفظة
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
   * «حركة جديدة» AT THE TOP, BESIDE «محفظة جديدة» (the owner, 13/11, over a phone screenshot: «زر حركة جديدة بالاعلى»).
   * The wallet's own press (above) sits in the ledger's header, under the wallet cards, and records on the wallet that is open. This
   * one is where the screen starts: it opens THE SAME dialog and first asks which wallet (`RecordFromTop`). The same key draws it —
   * `mayCash`, not widened — and it appears at the moment the wallet's own press does (once there are wallets), grey while every
   * wallet is stopped, as the wallet's own press is for a stopped one. A stopped wallet is never offered in it.
   */
  const recordable = (wallets ?? []).filter((w) => w.isActive);
  const topRecordButton =
    mayCash && wallets && wallets.length > 0 ? (
      <button
        disabled={recordable.length === 0}
        onClick={() => setTopOpen(true)}
        className={`h-11 md:h-10 px-3 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-50 ${
          phone ? 'flex-1 justify-center' : 'shrink-0'
        }`}
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
        {/* The day's press first, then the upkeep's: two presses of one row. On a phone they SHARE it, 44px each; on a desk they
            sit side by side at its end — never one button squeezed to make room for the other. */}
        {(topRecordButton || mayManage) && (
          <span className={phone ? 'flex gap-2' : 'flex items-center gap-2 shrink-0'}>
            {topRecordButton}
            {mayManage && (
              <button
                onClick={() => setCreating(true)}
                className={`h-11 md:h-10 px-3 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-xs font-medium inline-flex items-center gap-1.5 ${
                  phone ? 'flex-1 justify-center' : 'shrink-0'
                }`}
              >
                <RiAddCircleLine className="w-4 h-4" /> محفظة جديدة
              </button>
            )}
          </span>
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
                {/* The wallet's face, then who it is: the name, and «البلد · العملة» as the transfer chips say it. */}
                <span className="flex items-center gap-3">
                  <WalletPicture wallet={w} size="md" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between">
                      <span className="text-sm font-medium text-[var(--sys-heading)]">{w.name}</span>
                      {!w.isActive && <span className="text-xs text-[var(--sys-muted)] border border-[var(--sys-border)] rounded-full px-2 py-0.5">موقوفة</span>}
                    </span>
                    <span className="block text-xs text-[var(--sys-muted-foreground)]">
                      {[w.country?.name, w.currencyCode].filter(Boolean).join(' · ')}
                    </span>
                  </span>
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
                <h2 className="flex items-center gap-2 text-sm font-medium text-[var(--sys-heading)]">
                  {wallet && <WalletPicture wallet={wallet} size="sm" />}
                  <span>حركات {wallet?.name ?? ''}</span>
                </h2>
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
          mayExpense={mayExpense}
          mayPartners={mayPartners}
          storeCurrency={store?.code ?? null}
          onClose={() => setRecordOpen(false)}
          onSaved={async (message) => {
            setRecordOpen(false);
            await refresh(message);
          }}
        />
      )}

      {/* The same dialog, from the top of the screen: it asks which wallet first. Only the press that holds the key opens it. */}
      {topOpen && (
        <RecordFromTop
          wallets={recordable}
          openId={active}
          mayExpense={mayExpense}
          storeCurrency={store?.code ?? null}
          onClose={() => setTopOpen(false)}
          onSaved={async (message) => {
            setTopOpen(false);
            await refresh(message);
          }}
        />
      )}

      {lookOpen && wallet && (
        <WalletLookDialog
          wallet={wallet}
          onClose={() => setLookOpen(false)}
          onSaved={(message) => {
            setLookOpen(false);
            setDone(message);
            void loadWallets();
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

/**
 * «حركة جديدة» FROM THE TOP OF THE SCREEN — THE WALLET'S OWN DIALOG, AND THE ONE QUESTION ITS OWN PRESS NEVER ASKS: WHICH WALLET.
 *
 * The owner, 13/11, over a phone screenshot with only «محفظة جديدة» at the top: «زر حركة جديدة بالاعلى». The press beside the ledger
 * records on the wallet that is open, so it is only to be found after a wallet has been picked and scrolled to. This one is where the
 * screen starts. It opens THE SAME `RecordDialog` — nothing of it is copied, so the kinds, the currency sentence, the validation and
 * the request are the dialog's, identical whichever press opened it — with a drop-down of the wallets above its first field.
 *
 *   · only RUNNING wallets are offered: the wallet's own press is grey for a stopped one, and a movement on it is refused;
 *   · the wallet that is open is preselected when it is one of them, and so is the only running wallet there is;
 *   · otherwise nothing is chosen for the person: money must not land on a wallet nobody named. The form is not drawn until one is
 *     picked, so it cannot be submitted without one.
 *
 * What it records on is the wallet picked, and nothing about the screen follows it: the wallet that is open stays open, as after
 * the wallet's own press, and the wallets' figures are read again.
 */
function RecordFromTop({
  wallets,
  openId,
  mayExpense,
  storeCurrency,
  onClose,
  onSaved,
}: {
  /** The wallets a movement may be recorded on — the RUNNING ones. */
  wallets: WalletRow[];
  /** The wallet the screen has open: offered first, when it is one of them. */
  openId: string;
  mayExpense: boolean;
  storeCurrency: string | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [pickedId, setPickedId] = useState(() => wallets.find((w) => w.id === openId)?.id ?? (wallets.length === 1 ? wallets[0].id : ''));
  const picked = wallets.find((w) => w.id === pickedId) ?? null;
  const chooser = (
    <label className="block">
      <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">المحفظة</span>
      <select
        value={picked?.id ?? ''}
        onChange={(e) => setPickedId(e.target.value)}
        className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm bg-[var(--sys-card)]"
      >
        {!picked && <option value="">اختر المحفظة…</option>}
        {wallets.map((w) => (
          <option key={w.id} value={w.id}>{w.name} — {w.currencyCode}</option>
        ))}
      </select>
    </label>
  );
  if (!picked) {
    return (
      <Modal isOpen onClose={onClose} title="حركة جديدة">
        <div className="space-y-3">
          {chooser}
          <p className="text-xs text-[var(--sys-muted)]">اختر المحفظة أول، وبعدها بيطلع نموذج الحركة.</p>
          <div className="flex gap-2 justify-end pt-1">
            <button type="button" onClick={onClose} className="h-11 md:h-10 px-4 rounded-lg border border-[var(--sys-border)] text-sm">
              إلغاء
            </button>
          </div>
        </div>
      </Modal>
    );
  }
  return (
    <RecordDialog wallet={picked} mayExpense={mayExpense} storeCurrency={storeCurrency} chooser={chooser} onClose={onClose} onSaved={onSaved} />
  );
}

/**
 * «حركة جديدة» — A MOVEMENT TYPED BY HAND, OR A REAL EXPENSE.
 *
 * Two doors sit behind this one dialog and the category chosen picks between them:
 *
 *   · «تسوية» and «أخرى» go to the MOVEMENTS door: a person writing down money that has no ledger of its own.
 *   · «مصروف» goes to the EXPENSE door (`POST /api/finance`, the key `finance.create`). That door writes the expense
 *     row AND this wallet's movement in ONE transaction, so the profit subtracts it once and the wallet loses it once.
 *     A movement filed under EXPENSE and typed at the movements door would leave the profit untouched — or count it
 *     twice — which is why that door refuses it, and why this dialog never sends one there.
 *
 * «عمولة» stays greyed: its ledger is the commission entries, paid from «صرف».
 *
 * Two presses open it: the wallet's own, which knows the wallet, and the one at the top of the screen (`RecordFromTop`), which hands
 * it a wallet picked in a `chooser` above the first field — nothing else of the dialog differs between them.
 */
function RecordDialog({
  wallet,
  mayExpense,
  mayPartners,
  storeCurrency,
  chooser,
  onClose,
  onSaved,
}: {
  wallet: WalletRow;
  /** `finance.create`, the key the EXPENSE door asks. The server asks it again; this only decides what is offered. */
  mayExpense: boolean;
  /** `finance.partners`, the key of the PARTNERS' door — «سحب شريك» is offered to nobody without it. The server asks it again. */
  mayPartners: boolean;
  /** The selected store's currency, when the shell knows it — used only to say so when the wallet's is another. */
  storeCurrency: string | null;
  /** «المحفظة» — which wallet, drawn above the first field. Only the press at the top of the screen passes one. */
  chooser?: React.ReactNode;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [direction, setDirection] = useState<'IN' | 'OUT'>('OUT');
  const [amount, setAmount] = useState('');
  const [party, setParty] = useState('');
  const [category, setCategory] = useState(handCategoriesFor('OUT')[0]);
  const [note, setNote] = useState('');
  const [expenseType, setExpenseType] = useState<ExpenseCategory>(DEFAULT_EXPENSE_TYPE);
  const [expenseDate, setExpenseDate] = useState(todayForTheBox);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // «سحب شريك»: which partner, and what the draw is worth in the STORE's currency when the wallet holds another.
  const [partnerId, setPartnerId] = useState('');
  const [storeValue, setStoreValue] = useState('');
  const [statement, setStatement] = useState<PartnerStatement | null>(null);
  const [statementFailed, setStatementFailed] = useState(false);
  // Read once, when the dialog opens, and only for the people who are offered the kind: nobody else asks the partners' door anything.
  useEffect(() => {
    if (!mayPartners) return;
    let alive = true;
    apiJson<PartnerStatement>('/api/finance/partners/statement')
      .then((answer) => {
        if (alive && answer && Array.isArray(answer.lines)) setStatement(answer);
        else if (alive) setStatementFailed(true);
      })
      .catch(() => {
        if (alive) setStatementFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [mayPartners]);

  // Offered going OUT only, and only to who holds the key of the expense door.
  const expenseHere = mayExpense && direction === 'OUT';
  const isExpense = category === EXPENSE;
  // Offered going OUT only, and only to who holds the partners' key.
  const drawHere = mayPartners && direction === 'OUT';
  const isDraw = category === PARTNER_DRAW && drawHere;
  // The expense row carries no currency, so the profit subtracts the typed number as it is, whatever the wallet holds.
  // That is how the door has always behaved and it is not this dialog's to change — it is said once, before saving.
  const otherCurrency = isExpense && !!storeCurrency && storeCurrency !== wallet.currencyCode;

  // A draw's value is counted in the STORE's currency (the profit's). The server says which that is; the shell's answer is the fallback.
  const storeCode = statement?.currency ?? storeCurrency;
  const drawOtherCurrency = isDraw && !!storeCode && storeCode !== wallet.currencyCode;
  const partners = (statement?.lines ?? []).filter((l) => l.isActive);
  const partner = partners.find((l) => l.id === partnerId) ?? null;
  const drawAmount = typedFigure(amount);
  const drawValue = drawOtherCurrency ? typedFigure(storeValue) : drawAmount;
  // «بعد هالسحب»: the statement's own subtraction (`afterDraw`), asked of the figures the server sent — nothing is worked out here.
  const hint = isDraw && statement && partner && drawValue !== undefined && drawValue > 0 ? afterDraw(partner, drawValue, statement.minorUnit) : null;
  const drawReady = !!statement && !!partner && drawAmount !== undefined && drawAmount > 0 && (!drawOtherCurrency || (drawValue !== undefined && drawValue > 0));

  return (
    <Modal isOpen onClose={onClose} title={`حركة جديدة — ${wallet.name}`}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError(null);
          try {
            if (isDraw) {
              // THE PARTNERS' DOOR, never the movements one: it names the partner, writes the draw as an OUT movement worth its
              // equivalent in the store's currency, and asks its own key. The boxes' characters go on the wire as typed.
              await apiJson('/api/finance/partners/draws', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  walletId: wallet.id,
                  partnerId,
                  amount: onTheWire(amount),
                  ...(drawOtherCurrency ? { valueInStoreCurrency: onTheWire(storeValue) } : {}),
                  ...(note.trim() ? { note: note.trim() } : {}),
                }),
              });
              onSaved('سُجِّل السحب — ما دخل بالمصاريف ولا غيّر الربح، وانحسب على نصيب الشريك');
              return;
            }
            if (isExpense) {
              // THE EXPENSE DOOR, never the movements one. The wallet is the one this dialog was opened on; the door
              // checks it is this store's and answers in Arabic when it is not, and so does it for the key.
              await apiJson('/api/finance', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  title: party.trim(),
                  category: expenseType,
                  amount: Number(amount),
                  expenseDate,
                  notes: note.trim(),
                  walletId: wallet.id,
                }),
              });
              onSaved('سُجِّل المصروف — خُصم من الربح وخرج من المحفظة');
              return;
            }
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
            onSaved('سُجِّلت الحركة');
          } catch (err) {
            setError(err instanceof Error ? err.message : 'تعذر الحفظ');
          } finally {
            setSaving(false);
          }
        }}
        className="space-y-3"
      >
        {chooser}
        {/* Whose money moves, by its face — the title above says the name, and a wallet is recognised by what it looks like. */}
        <div className="flex items-center gap-3 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-2.5">
          <WalletPicture wallet={wallet} size="sm" />
          <span className="text-xs text-[var(--sys-muted-foreground)]">
            {[wallet.country?.name, wallet.currencyCode].filter(Boolean).join(' · ')}
          </span>
        </div>

        <div className="flex gap-2">
          {(['IN', 'OUT'] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => {
                setDirection(d);
                // The pair must stay one a door accepts: a movement typed for this direction, or the expense going OUT
                // for who may write it, or a partner's draw going OUT for who holds the partners' key. Anything else goes back to
                // the first category of the direction.
                const stays =
                  handCategoriesFor(d).includes(category) ||
                  (category === EXPENSE && d === 'OUT' && mayExpense) ||
                  (category === PARTNER_DRAW && d === 'OUT' && mayPartners);
                if (!stays) setCategory(handCategoriesFor(d)[0]);
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

        {otherCurrency && (
          <p className="text-xs text-[var(--sys-warning)]">
            انتبه: عملة هالمحفظة ({wallet.currencyCode}) غير عملة المتجر ({storeCurrency}) — المبلغ بينخصم من الربح بنفس رقمو بلا تحويل.
          </p>
        )}

        {/* «سحب شريك»: what the draw is worth in the STORE's currency, asked only when the wallet holds another — the profit is in the
            store's currency, and a silent 1:1 between dinars and dollars would put a wrong number in a partner's account. */}
        {isDraw && drawOtherCurrency && (
          <label className="block">
            <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">ما يعادله بعملة المتجر ({storeCode})</span>
            <input
              type="number"
              step="0.001"
              min="0.001"
              value={storeValue}
              onChange={(e) => setStoreValue(e.target.value)}
              required
              className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
              dir="ltr"
            />
            <span className="block text-xs text-[var(--sys-warning)] mt-1">
              عملة هالمحفظة ({wallet.currencyCode}) غير عملة المتجر ({storeCode}) — اكتب كم بيساوي المبلغ بعملة المتجر، وهاد الرقم اللي بينحسب على نصيب الشريك.
            </span>
          </label>
        )}

        {isDraw ? (
          <div>
            <label className="block">
              <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">الشريك</span>
              <select
                value={partnerId}
                onChange={(e) => setPartnerId(e.target.value)}
                required
                className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm bg-[var(--sys-card)]"
              >
                <option value="">اختر الشريك…</option>
                {partners.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
            {statementFailed && (
              <p className="text-xs text-[var(--sys-destructive)] mt-1">تعذّر تحميل الشركاء — سكّر النافذة وافتحها من جديد.</p>
            )}
            {statement && partners.length === 0 && (
              <p className="text-xs text-[var(--sys-warning)] mt-1">ما في شركاء فعّالين — سجّلهم من «إعدادات النظام».</p>
            )}
            {/* «نصيبه من الصافي X · سحب لحد هلق Y · بعد هالسحب: مكسور عليه Z» — and the draw goes through either way. */}
            {statement && partner && (
              <p className="text-xs text-[var(--sys-muted)] mt-1">
                {partner.entitlement === null ? (
                  'الصافي ما انقسم لأن مجموع النسب مش 100 — السحب بيتسجّل وبيتحسب لما تنصلّح النسب.'
                ) : (
                  <>
                    نصيبه من الصافي <Money value={partner.entitlement} currency={statement.currency} minorUnit={statement.minorUnit} /> · سحب لحد هلق{' '}
                    <Money value={partner.draws} currency={statement.currency} minorUnit={statement.minorUnit} />
                    {hint && hint.broken !== null && hint.balance !== null && (
                      hint.broken > 0 ? (
                        <span className="text-[var(--sys-destructive)]">
                          {' '}· بعد هالسحب: مكسور عليه <Money value={hint.broken} currency={statement.currency} minorUnit={statement.minorUnit} />
                        </span>
                      ) : (
                        <>
                          {' '}· بعد هالسحب: بيضل له <Money value={hint.balance} currency={statement.currency} minorUnit={statement.minorUnit} />
                        </>
                      )
                    )}
                  </>
                )}
              </p>
            )}
          </div>
        ) : (
          <label className="block">
            {/* An expense's statement is the party its movement is written under, so the one box serves both. */}
            <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">{isExpense ? 'البيان' : 'الطرف'}</span>
            <input
              value={party}
              onChange={(e) => setParty(e.target.value)}
              required
              minLength={2}
              placeholder={isExpense ? 'مثلاً: إيجار المستودع، حملة تيك توك رقم 4' : 'اسم الشخص أو الجهة'}
              className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
            />
          </label>
        )}

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
            {/* Listed, not removed: the pointer beside each one says which door writes it. The expense is the one that
                opens here — going OUT, for who holds the key of its door. «سحب شريك» sits right after it, going OUT, for who
                holds the partners' key — and is not there at all for anybody else. */}
            {ownLedgerCategories().map((key) => {
              const option =
                key === EXPENSE && expenseHere ? (
                  <option key={key} value={key}>{CATEGORY_AR[key]}</option>
                ) : (
                  <option key={key} value={key} disabled>{CATEGORY_AR[key]} — {key === EXPENSE && mayExpense ? EXPENSE_IN_POINTER : OWN_LEDGER[key].short}</option>
                );
              return key === EXPENSE && drawHere ? (
                <React.Fragment key={key}>
                  {option}
                  <option value={PARTNER_DRAW}>{CATEGORY_AR[PARTNER_DRAW]}</option>
                </React.Fragment>
              ) : (
                option
              );
            })}
          </select>
          <span className="block text-xs text-[var(--sys-muted)] mt-1">{COURIER_MONEY_HINT} {mayExpense ? EXPENSE_HERE_HINT : OWN_LEDGER_HINT} التحويلات من شاشة التحويلات.</span>
          {mayPartners && (
            <span className="block text-xs text-[var(--sys-muted)] mt-1">
              سحب الشريك من «سحب شريك»: بيتحسب على نصيبه من صافي الربح، ولو زاد بيتسجّل «مكسور عليه» وما بينمنع.
            </span>
          )}
        </label>

        {isExpense && (
          <>
            <label className="block">
              <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">نوع المصروف</span>
              <select
                value={expenseType}
                onChange={(e) => setExpenseType(e.target.value as ExpenseCategory)}
                className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm bg-[var(--sys-card)]"
              >
                {/* The profit screen's own list: the two types the profit already counts on a delivered order say so. */}
                {EXPENSE_FORM_ORDER.map((c) => (
                  <option key={c} value={c}>{EXPENSE_FORM_LABEL[c] ?? EXPENSE_CATEGORY_AR[c]}</option>
                ))}
              </select>
              {EXPENSE_FORM_HINT[expenseType] && (
                <span className="block text-xs text-[var(--sys-muted)] mt-1">{EXPENSE_FORM_HINT[expenseType]}</span>
              )}
            </label>

            <label className="block">
              <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">التاريخ</span>
              <input
                type="date"
                value={expenseDate}
                onChange={(e) => setExpenseDate(e.target.value)}
                required
                className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
                dir="ltr"
              />
            </label>
          </>
        )}

        <label className="block">
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">{isExpense || isDraw ? 'الملاحظة (اختيارية)' : 'الملاحظة (إلزامية)'}</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            required={!isExpense && !isDraw}
            minLength={isExpense || isDraw ? undefined : 3}
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
            disabled={saving || (isDraw && !drawReady)}
            className="h-11 md:h-10 px-4 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-medium disabled:opacity-50"
          >
            {saving ? 'جارٍ الحفظ…' : isDraw ? 'تسجيل السحب' : isExpense ? 'تسجيل المصروف' : 'تسجيل'}
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
