'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { apiJson } from '@/lib/api-client';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';
import { ScreenTitle } from '@/components/shell/ScreenTitle';
import { RiGitBranchLine, RiLoader4Line, RiScales3Line } from '@remixicon/react';
import { EmptyState } from '@/components/ui/EmptyState';
import { NextStepButton } from '@/components/ui/NextStep';
import { DifferenceActions } from '@/components/screens/finance/DifferenceActions';
import { BulkDecide } from '@/components/screens/finance/BulkDecide';
import { DifferencesByPerson } from '@/components/screens/finance/DifferencesByPerson';
import { NotMentionedActions } from '@/components/screens/finance/NotMentionedActions';
import { LinkLineDialog } from '@/components/screens/finance/LinkLineDialog';
import { SwapDialog } from '@/components/screens/finance/SwapDialog';
import { mayCorrectStatus } from '@/lib/not-mentioned';
import { useToast } from '@/components/ui/Toast';
import { Rows, type Column } from '@/components/ui/Rows';
import { Money } from '@/components/ui/Money';
import { Tabs } from '@/components/ui/Tabs';
import { ManualMatching } from '@/components/screens/finance/ManualMatching';
import { STATEMENT_CLOSED_SENTENCE, isApproved } from '@/lib/settlement-gates';
import { countOpenLines } from '@/lib/statement-open-lines';

/**
 * /finance/matching — the outcome of matching, read as four queues: agreed,
 * different amount, in the statement but not in the system, and orders no
 * statement names. Nothing is edited here; a difference is resolved on the
 * order or by a reversing entry, never by overwriting.
 *
 * Two of the four are a difference in MONEY and two are not. Only «فرق في المبلغ» has two
 * figures to choose between, so only it offers «رقمنا / رقمهم». A line with no order and an
 * order with no line have one figure each: they show what the company WROTE (its status word
 * and its whole row, in its own words) or what the order's own outcome is, and the second
 * offers three actions on the order — see `NotMentionedActions`.
 *
 * «يدوي — بلا كشف» is the other half of the word «مطابقة»: a courier or a company
 * that sends no statement and no file is matched by a person naming the orders —
 * see `ManualMatching`. It is a second tab beside the first, drawn only for somebody
 * who can follow a parcel (`ops.track`), because the list it works from is that
 * permission's. `?mode=manual` opens it, for the pointers that lead here.
 */

interface Match {
  id: string;
  result: 'MATCHED' | 'MISMATCHED' | 'MISSING_IN_SYSTEM' | 'MISSING_IN_STATEMENT';
  matchedBy: string | null;
  /** The order the line is tied to, or null for a line no order carries. */
  orderId?: string | null;
  expectedAmount: string | number | null;
  statementAmount: string | number | null;
  difference: string | number | null;
  expectedFee: string | number | null;
  statementFee: string | number | null;
  feeDifference: string | number | null;
  note: string | null;
  /** ACCEPTED_COURIER | OURS_STANDS | UNDER_REVIEW — null while nobody has answered. */
  resolution: string | null;
  resolutionNote: string | null;
  /** What may be said about this order as it is now (settlement-decisions), or null on a row that is no difference. */
  decisions?: Record<string, { allowed: boolean; why: string | null }> | null;
  /** The key a bulk answer groups the lines by: the same courier word. */
  wordGroup?: string | null;
  /** What the company still owes, on a row answered «رقمنا هو المعتمد». */
  claim?: number | null;
  order: { id: string; orderNumber: string; merchantRef: string | null; shippingStatus: string } | null;
  statementLine: {
    merchantRef: string | null;
    barcode: string | null;
    amount: string | number;
    /** The company's own status cell, and the whole row as it wrote it (notes column included). */
    status: string | null;
    rawRow: string | null;
  } | null;
  /** The status word read through the one phrase table: what it says, and whether the table knows it. */
  courierWord: { phrase: string; outcome: string; known: boolean; label: string } | null;
  /** The order's own outcome word (order-outcome), for the orders no statement names. */
  orderOutcome: { key: string; label: string } | null;
  /** The last answer a person recorded on the order about not being on a statement. */
  followUp: { action: string; at: string } | null;
}

interface StatementRow {
  id: string;
  reference: string;
  status: string;
  /** Set when the money moved. Matching is refused after it. */
  approvedAt: string | null;
  /** An open manual draft has nothing to match yet: it is gathered on the collection screen first. */
  draft?: boolean;
  currencyCode: string;
  counts: { lines: number; receipts: number; matches: number; openLines?: number };
}

const num = (v: string | number | null | undefined) => (v === null || v === undefined ? null : Number(v));

export function MatchingScreen() {
  const toast = useToast();
  const { currentUser } = useApp();
  const mayManual = userCan(currentUser, 'ops.track');
  const mayReview = userCan(currentUser, 'settlement.review');
  const [mode, setMode] = useState<'statement' | 'manual'>(useSearchParams().get('mode') === 'manual' ? 'manual' : 'statement');
  const [statements, setStatements] = useState<StatementRow[] | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void apiJson<{ statements: StatementRow[] }>('/api/finance/statements')
      .then((payload) => {
        const d = { statements: payload.statements.filter((s) => !s.draft) };
        setStatements(d.statements);
        const withMatches = d.statements.find((s) => s.counts.matches > 0) ?? d.statements[0];
        if (withMatches) setSelected(withMatches.id);
      })
      .catch((e) => toast.failed(e instanceof Error ? e.message : 'تعذر التحميل'));
  }, []);

  const load = useCallback(async (id: string) => {
    if (!id) return;
    setMatches(null);
    try {
      const data = await apiJson<{ statement: { matches: Match[] } }>(`/api/finance/statements/${id}`);
      setMatches(data.statement.matches);
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, []);

  useEffect(() => {
    void load(selected);
  }, [selected, load]);

  const statement = statements?.find((s) => s.id === selected);
  const queue = (result: Match['result']) => (matches ?? []).filter((m) => m.result === result);

  /**
   * MATCHING IS REFUSED AFTER APPROVAL, AND THE BUTTON SAYS SO.
   *
   * Re-running it rewrites the rows that decide which orders were settled and
   * whose commission became payable — and it used to write `status` back to
   * MATCHED, which reopened the approval and let the courier's cash be posted
   * into the wallet a second time. The server refuses it now; this is the same
   * rule, read from the same function, so the button is grey instead of red.
   */
  const closed = statement ? isApproved(statement) : false;
  const noReceipt = (statement?.counts.receipts ?? 0) === 0;
  const whyNot = closed
    ? STATEMENT_CLOSED_SENTENCE
    : noReceipt
      ? 'سجّل إيصال الاستلام أولاً'
      : 'إعادة تشغيل المطابقة';

  /*
   * THE CHOICE IS DRAWN BEFORE ANYTHING ELSE, SO IT NEEDS NO CLICK TO BE FOUND.
   *
   * «المطابقة اليدوية شو؟» — the owner could not tell that a company without a statement
   * had a way here at all. Two named tabs at the top say it: with a statement, or without.
   * Somebody who cannot follow a parcel sees neither the tabs nor the manual half, and the
   * screen is exactly what it was.
   */
  const modeTabs = mayManual ? (
    <Tabs
      tabs={[
        { key: 'statement', label: 'بكشف من الشركة' },
        { key: 'manual', label: 'يدوي — بلا كشف' },
      ]}
      value={mode}
      onChange={(k) => setMode(k === 'manual' ? 'manual' : 'statement')}
    />
  ) : null;

  if (mayManual && mode === 'manual') {
    return (
      <div className="max-w-6xl space-y-3">
        <ScreenTitle />
        {modeTabs}
        <ManualMatching />
      </div>
    );
  }

  return (
    <div className="max-w-6xl space-y-3">
      <ScreenTitle />
      {modeTabs}
      <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4 flex flex-wrap gap-3 items-end">
        <label className="flex-1 min-w-[220px]">
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">الكشف</span>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm bg-[var(--sys-card)]"
          >
            <option value="">اختر كشفاً…</option>
            {(statements ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.reference} — {s.counts.matches} مطابقة{!isApproved(s) && (s.counts.openLines ?? 0) > 0 ? ` · ${s.counts.openLines} بلا بتّ` : ''}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={!selected || busy || noReceipt || closed}
          title={whyNot}
          onClick={async () => {
            setBusy(true);
            try {
              await apiJson(`/api/finance/statements/${selected}/match`, { method: 'POST' });
              await load(selected);
            } catch (e) {
              toast.failed(e instanceof Error ? e.message : 'تعذرت المطابقة');
            } finally {
              setBusy(false);
            }
          }}
          className="h-10 px-4 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-medium inline-flex items-center gap-2 disabled:opacity-50"
        >
          {busy ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiGitBranchLine className="w-4 h-4" />}
          تشغيل المطابقة
        </button>
      </div>

      {closed && (
        <p className="text-xs text-[var(--sys-muted-foreground)] bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg p-3">
          {STATEMENT_CLOSED_SENTENCE}. مالُه في المحفظة وتُقرأ نتيجتُه هنا فقط: لا بتّ ولا ربط ولا إعادة مطابقة.
          كشف التسوية كشفٌ يدويّ بمرجعه، يبدأ من «يدوي — بلا كشف» ويُجمَّع ويُعتمد في «التحصيل والكشوف».
        </p>
      )}

      {!selected ? null : !matches ? (
        <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-16">
          <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
        </div>
      ) : matches.length === 0 ? (
        <EmptyState
          icon={RiScales3Line}
          title="لم تُشغَّل المطابقة على هذا الكشف بعد"
          why="الكشف مستورد لكن لم يُقابَل بأي طلب بعد. ابدأ المطابقة لترى من دفع ومن بقي عليه."
        />
      ) : (
        <div className="space-y-3">
          {/* The sum of the answers given below it: who keeps arriving short. */}
          <DifferencesByPerson currency={statement?.currencyCode ?? ''} />
          <Queue
            title="مطابق"
            tone="emerald"
            currency={statement?.currencyCode ?? ''}
            rows={queue('MATCHED')}
            hint="المبلغ في الكشف يساوي المتوقَّع — تُعتمد هذه الطلبات وتصبح عمولتها مستحقة عند اعتماد الكشف."
          />
          {mayReview && !closed && (
            <BulkDecide
              statementId={selected}
              onDone={() => void load(selected!)}
              rows={queue('MISMATCHED').map((m) => ({
                id: m.id,
                wordGroup: m.wordGroup ?? null,
                word: m.courierWord?.phrase ?? null,
                answered: !!m.resolution,
              }))}
            />
          )}
          <Queue
            title="فرق في المبلغ"
            resolvable
            swappable={mayReview && !closed}
            locked={closed}
            reason
            statementId={selected}
            onResolved={() => void load(selected!)}
            tone="rose"
            currency={statement?.currencyCode ?? ''}
            rows={queue('MISMATCHED')}
            hint="راجع الطلب نفسه: تسليم جزئي غير مسجَّل، أو أجرة توصيل أعلى من المتفق عليه. التصحيح يكون على الطلب، وبعد الاعتماد بكشف تسوية — لا بتعديل الكشف."
          />
          <Queue
            title="في الكشف وليس عندنا"
            reason
            linkable={mayReview && !closed}
            parkable={mayReview}
            locked={closed}
            statementId={selected}
            onResolved={() => void load(selected!)}
            tone="amber"
            currency={statement?.currencyCode ?? ''}
            rows={queue('MISSING_IN_SYSTEM')}
            hint="مرجع لا يقابله طلب في هذا المتجر — غالباً كشف شركة أخرى أو مرجع مكتوب خطأً. لا رقمين هنا يُختار بينهما؛ اقرأ سبب الشركة بكلامها، أو اربط السطر بطلبه: بهاتف الزبون أو برقم طلبنا. وإن لم يكن لنا فاكتب سببه وقل «قيد المراجعة» ليتابع الاعتماد."
          />
          <Queue
            title="طلبات لم يذكرها أي كشف"
            unmentioned
            canUnlock={userCan(currentUser, 'orders.unlock')}
            statementId={selected}
            onResolved={() => void load(selected!)}
            tone="amber"
            currency={statement?.currencyCode ?? ''}
            rows={queue('MISSING_IN_STATEMENT')}
            hint="طلبات سُلِّمت عندنا ولم يذكرها أي كشف من الشركة بعد. لكل طلب كلمة نتيجته، وما تقرره بشأنه يُسجَّل على الطلب نفسه ولا يُحسب فرقاً في المبلغ."
          />
        </div>
      )}

      {/* The money road goes on from here: «الإغلاق». */}
      <NextStepButton />
    </div>
  );
}

const TONE: Record<string, string> = {
  emerald: 'bg-[var(--sys-success-soft)] text-[var(--sys-success)] border-[var(--sys-success)]/40',
  rose: 'bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)] border-[var(--sys-destructive-border)]',
  amber: 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] border-[var(--sys-warning)]/40',
};

function Queue({
  title,
  tone,
  rows,
  hint,
  currency,
  resolvable,
  swappable,
  reason,
  unmentioned,
  linkable,
  parkable,
  canUnlock,
  locked,
  statementId,
  onResolved,
}: {
  title: string;
  tone: string;
  rows: Match[];
  hint: string;
  currency: string;
  /** A difference in money: two figures, and the person says which one stands. Only «فرق في المبلغ». */
  resolvable?: boolean;
  /** The courier handed the box to another customer: «كان من طرد طلب آخر». Only a line with money and no answer yet. */
  swappable?: boolean;
  /** Show the company's own reason: its status word and its whole row. */
  reason?: boolean;
  /** Orders no statement names: no company figure, so the order's outcome word and three actions on the order. */
  unmentioned?: boolean;
  /** A line with no order of ours: a person may tie it to one by hand (never after approval). */
  linkable?: boolean;
  /** A line no order carries may be parked with its reason — the answer that lets the approval go on without it. */
  parkable?: boolean;
  /** May this person correct a delivered order's status (the door the third action leads to)? */
  canUnlock?: boolean;
  /** The statement is closed for good: an answer is read, no longer changed. */
  locked?: boolean;
  statementId?: string | null;
  onResolved?: () => void;
}) {
  const [open, setOpen] = useState(rows.length > 0 && tone !== 'emerald');
  // The lines of this queue still a question — by the same rule the approval counts (`statement-open-lines`).
  const unanswered = resolvable || parkable ? countOpenLines(rows) : 0;

  const columns: Column<Match>[] = [
    {
      key: 'barcode',
      label: 'باركود الشحنة',
      primary: true,
      // The barcode IS the reference: the courier assigns it and
      // writes their statement in it. Our own number sits under
      // it, smaller, as the fallback key.
      render: (m) => (
        <span dir="ltr">
          <span className="block font-medium">{m.statementLine?.barcode ?? '—'}</span>
          {(m.statementLine?.merchantRef ?? m.order?.merchantRef) && (
            <span className="block text-xs text-[var(--sys-muted)]">
              {m.statementLine?.merchantRef ?? m.order?.merchantRef}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'order',
      label: 'الطلب',
      primary: true,
      render: (m) =>
        m.order ? (
          <a href={`/orders/${m.order.id}`} className="text-[var(--sys-primary)] hover:underline" dir="ltr">
            {m.order.orderNumber}
          </a>
        ) : (
          <span className="text-[var(--sys-muted)]">—</span>
        ),
    },
    {
      key: 'expected',
      label: 'المتوقَّع',
      align: 'end',
      render: (m) => (num(m.expectedAmount) === null ? '—' : <Money value={num(m.expectedAmount)!} currency={currency} />),
    },
    // The order's OWN outcome word — «تم التسليم — بانتظار التحصيل», «مغلق» — read from the order, never stored.
    ...(unmentioned
      ? [
          {
            key: 'outcome',
            label: 'كلمة نتيجته',
            render: (m: Match) => m.orderOutcome?.label ?? '—',
          },
        ]
      : [
          {
            key: 'stated',
            label: 'في الكشف',
            align: 'end' as const,
            render: (m: Match) =>
              num(m.statementAmount) === null ? '—' : <Money value={num(m.statementAmount)!} currency={currency} />,
          },
          {
            key: 'gap',
            label: 'الفرق',
            align: 'end' as const,
            render: (m: Match) => {
              const diff = num(m.difference);
              return diff === null ? '—' : <Money value={diff} currency={currency} tone={diff ? 'lost' : undefined} />;
            },
          },
          {
            key: 'fee',
            label: 'أجرة التوصيل',
            align: 'end' as const,
            render: (m: Match) => {
              const feeDiff = num(m.feeDifference);
              if (num(m.statementFee) === null) return <span className="text-[var(--sys-muted)]">—</span>;
              return feeDiff ? (
                <span className="text-xs font-medium text-[var(--sys-destructive)]">
                  {num(m.statementFee)} بدل {num(m.expectedFee)}
                </span>
              ) : (
                <span className="text-xs text-[var(--sys-muted-foreground)]">{num(m.statementFee)}</span>
              );
            },
          },
        ]),
    /*
     * THE COMPANY'S OWN REASON, IN ITS OWN WORDS.
     *
     * Its status word, read through the one phrase table — and, whatever the table says, the word itself,
     * so an unknown word is shown rather than hidden. Under it the whole row as the company wrote it: the
     * notes column is part of that row, and «15132 - العميل طلب التأجيل» is the reason, not decoration.
     * This was stored on every line and shown on no screen.
     */
    ...(reason
      ? [
          {
            key: 'reason',
            label: 'سبب الشركة بكلامها',
            render: (m: Match) => {
              const word = m.courierWord;
              const raw = m.statementLine?.rawRow;
              if (!word && !raw) return <span className="text-[var(--sys-muted)]">—</span>;
              return (
                <span className="block">
                  {word && (
                    <span className="block font-medium">
                      «{word.phrase}» <span className="text-xs text-[var(--sys-muted-foreground)]">{word.label}</span>
                    </span>
                  )}
                  {raw && (
                    <span className="block text-xs text-[var(--sys-muted)]" dir="auto">
                      {raw}
                    </span>
                  )}
                </span>
              );
            },
          },
        ]
      : []),
    ...(resolvable && statementId
      ? [
          {
            key: 'resolve',
            label: 'البتّ في الفرق',
            wide: true,
            render: (m: Match) => (
              <DifferenceActions
                statementId={statementId}
                matchId={m.id}
                orderId={m.order?.id ?? null}
                orderNumber={m.order?.orderNumber ?? null}
                resolution={m.resolution}
                resolutionNote={m.resolutionNote}
                decisions={m.decisions}
                claim={m.claim}
                currency={currency}
                locked={locked}
                onResolved={() => onResolved?.()}
              />
            ),
          },
        ]
      : []),
    ...(swappable && statementId
      ? [
          {
            key: 'swap',
            label: 'تبديل طرد',
            render: (m: Match) => {
              const stated = num(m.statementAmount);
              if (!m.order || m.resolution || m.matchedBy === 'MANUAL' || !stated || stated <= 0) {
                return <span className="text-[var(--sys-muted)]">—</span>;
              }
              return (
                <SwapDialog
                  statementId={statementId}
                  matchId={m.id}
                  reference={m.statementLine?.barcode ?? m.statementLine?.merchantRef ?? null}
                  amount={stated}
                  currency={currency}
                  onDone={() => onResolved?.()}
                />
              );
            },
          },
        ]
      : []),
    // A line no order of ours carries may also be parked with its reason; a closed statement shows the sentence instead.
    ...(parkable && statementId
      ? [
          {
            key: 'park',
            label: 'ليس لنا',
            render: (m: Match) => (
              <DifferenceActions
                statementId={statementId}
                matchId={m.id}
                orderId={null}
                orderNumber={null}
                resolution={m.resolution}
                resolutionNote={m.resolutionNote}
                locked={locked}
                parkOnly
                onResolved={() => onResolved?.()}
              />
            ),
          },
        ]
      : []),
    // A line no order of ours carries: a person ties it to its order by hand.
    ...(linkable && statementId
      ? [
          {
            key: 'link',
            label: 'ربطه بطلب',
            render: (m: Match) => (
              <LinkLineDialog
                statementId={statementId}
                matchId={m.id}
                reference={m.statementLine?.barcode ?? m.statementLine?.merchantRef ?? null}
                amount={num(m.statementAmount)}
                currency={currency}
                onLinked={() => onResolved?.()}
              />
            ),
          },
        ]
      : []),
    // What a person decided about an order no statement names: recorded on the ORDER, moves no money.
    ...(unmentioned && statementId
      ? [
          {
            key: 'follow',
            label: 'ما تقرّره بشأنه',
            render: (m: Match) =>
              m.order ? (
                <NotMentionedActions
                  statementId={statementId}
                  matchId={m.id}
                  orderId={m.order.id}
                  orderNumber={m.order.orderNumber}
                  canCorrectStatus={mayCorrectStatus({ holdsUnlock: !!canUnlock, shippingStatus: m.order.shippingStatus })}
                  followUp={m.followUp}
                  onDone={() => onResolved?.()}
                />
              ) : (
                <span className="text-[var(--sys-muted)]">—</span>
              ),
          },
        ]
      : []),
    ...(unmentioned
      ? []
      : [
          {
            key: 'via',
            label: 'طوبق عبر',
            // A desk's column. On a card it is one more labelled line
            // between the reader and the number they came for.
            hideOnPhone: true,
            render: (m: Match) =>
              m.matchedBy === 'MERCHANT_REF'
                ? 'المرجع'
                : m.matchedBy === 'BARCODE'
                  ? 'الباركود'
                  : m.matchedBy === 'MANUAL'
                    ? 'ربط يدوي'
                    : '—',
          },
        ]),
  ];

  return (
    <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-right"
      >
        <span className="flex items-center gap-2">
          <span className={`text-xs px-2 py-1 rounded-full border ${TONE[tone]}`}>{rows.length}</span>
          <span className="text-sm font-medium text-[var(--sys-heading)]">{title}</span>
          {!locked && unanswered > 0 && <span className="text-xs text-[var(--sys-warning)]">{unanswered} بلا بتّ</span>}
        </span>
        <span className="text-xs text-[var(--sys-muted)]">{open ? 'إخفاء' : 'عرض'}</span>
      </button>

      {open && (
        <div className="border-t border-[var(--sys-border)]">
          <p className="text-xs text-[var(--sys-muted-foreground)] px-4 py-2 bg-[var(--sys-surface)]">{hint}</p>
          {rows.length === 0 ? (
            <EmptyState title="لا شيء في هذه المجموعة" why={hint} />
          ) : (
            <Rows
              rows={rows}
              keyOf={(m) => m.id}
              alert={(m) => num(m.difference) !== null && num(m.difference) !== 0}
              columns={columns}
              empty={<EmptyState title="لا أسطر في هذه المجموعة" why={hint} />}
            />
          )}
        </div>
      )}
    </div>
  );
}
