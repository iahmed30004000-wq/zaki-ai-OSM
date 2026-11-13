'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { apiJson } from '@/lib/api-client';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';
import { ScreenTitle } from '@/components/shell/ScreenTitle';
import { RiGitBranchLine, RiLoader4Line, RiScales3Line } from '@remixicon/react';
import { EmptyState } from '@/components/ui/EmptyState';
import { NextStepButton } from '@/components/ui/NextStep';
import { DifferenceActions } from '@/components/screens/finance/DifferenceActions';
import { CourierReason } from '@/components/screens/finance/CourierReason';
import { BulkDecide } from '@/components/screens/finance/BulkDecide';
import { DifferencesByPerson } from '@/components/screens/finance/DifferencesByPerson';
import { NotMentionedActions } from '@/components/screens/finance/NotMentionedActions';
import { LinkLineDialog } from '@/components/screens/finance/LinkLineDialog';
import { SwapDialog } from '@/components/screens/finance/SwapDialog';
import { mayCorrectStatus } from '@/lib/not-mentioned';
import { useToast } from '@/components/ui/Toast';
import { Rows, type Column } from '@/components/ui/Rows';
import { OrderRef } from '@/components/orders/OrderRef';
import { Money } from '@/components/ui/Money';
import { Tabs } from '@/components/ui/Tabs';
import { useIsPhone } from '@/hooks/useIsPhone';
import { ManualMatching } from '@/components/screens/finance/ManualMatching';
import { STATEMENT_CLOSED_SENTENCE, isApproved, isMatchingClosed } from '@/lib/settlement-gates';
import { countOpenLines, isOpenLine } from '@/lib/statement-open-lines';
import { lineEssentials } from '@/lib/statement-line-reading';
import { StatementTally } from '@/components/screens/finance/StatementTally';
import { NO_VIEW, QueueTools, type QueueKind, type QueueView } from '@/components/screens/finance/QueueTools';
import { matchesQuery } from '@/lib/queue-search';
import { COMPANY_WORD_AR, COMPANY_WORD_ORDER } from '@/lib/couriers/word-names';

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
  result: 'MATCHED' | 'MISMATCHED' | 'MISSING_IN_SYSTEM' | 'MISSING_IN_STATEMENT' | 'EXCLUDED';
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
    /** What the company says it collected, and the fee it kept — when its file had those columns. */
    collected?: string | number | null;
    fee?: string | number | null;
    /** The company's own status cell, and the whole row as it wrote it (notes column included). */
    status: string | null;
    rawRow: string | null;
    /** Who the parcel went to, under the headings the file wrote them. Null on a line imported before they were kept. */
    receiverName?: string | null;
    receiverPhone?: string | null;
    receiverAddress?: string | null;
    receiverCity?: string | null;
    receiverArea?: string | null;
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
  /** Set when the money moved. */
  approvedAt: string | null;
  /** Set when the matching closed and the orders were settled: no answer, link or new matching after it. */
  matchingClosedAt?: string | null;
  /** An open manual draft has nothing to match yet: it is gathered on the collection screen first. */
  draft?: boolean;
  currencyCode: string;
  counts: { lines: number; receipts: number; matches: number; openLines?: number };
}

const num = (v: string | number | null | undefined) => (v === null || v === undefined ? null : Number(v));

/**
 * THE PIN IS A PER-PERSON CONVENIENCE, NOT SHARED STATE: «ثبّت العناوين» is remembered in this browser only, and the screen
 * works the same when it cannot be (a private window, blocked site data) — pinned, as the owner asked, until somebody unpins.
 */
const PIN_KEY = 'osm.matching.pinHeader';
const readPinned = (): boolean => {
  try {
    return window.localStorage.getItem(PIN_KEY) !== 'off';
  } catch {
    return true;
  }
};
const writePinned = (on: boolean) => {
  try {
    window.localStorage.setItem(PIN_KEY, on ? 'on' : 'off');
  } catch {
    /* not remembered: the pin itself still works for this visit */
  }
};

/** What kind of line a row is, for the filter above its queue: the company's word, or — for an order no statement names — the order's own outcome word. */
const kindOf = (m: Match): { key: string; label: string } =>
  m.statementLine
    ? { key: m.courierWord?.outcome ?? 'NONE', label: COMPANY_WORD_AR[m.courierWord?.outcome ?? 'NONE'] ?? COMPANY_WORD_AR.NONE }
    : m.orderOutcome
      ? { key: m.orderOutcome.key, label: m.orderOutcome.label }
      : { key: 'NONE', label: COMPANY_WORD_AR.NONE };

/** The kinds present in a queue, with their counts: the company's order first (what was delivered, then what came back…). */
function queueKinds(rows: Match[]): QueueKind[] {
  const counted = new Map<string, QueueKind>();
  for (const m of rows) {
    const k = kindOf(m);
    const seen = counted.get(k.key);
    if (seen) seen.count++;
    else counted.set(k.key, { ...k, count: 1 });
  }
  const rank = (key: string) => {
    const i = COMPANY_WORD_ORDER.indexOf(key);
    return i < 0 ? COMPANY_WORD_ORDER.length : i;
  };
  return [...counted.values()].sort((a, b) => rank(a.key) - rank(b.key) || a.label.localeCompare(b.label, 'ar'));
}

/** What a typed word is looked for in: the barcodes and numbers, the receiver's pieces, the status, our outcome word — and the company's whole row as free text. */
function searchPartsOf(m: Match) {
  const l = m.statementLine;
  const e = l ? lineEssentials(l) : null;
  return {
    fields: [
      l?.barcode, l?.merchantRef, m.order?.orderNumber, m.order?.merchantRef,
      l?.receiverName, l?.receiverPhone, ...(e?.phone ? [e.phone.shown, ...e.phone.keys] : []),
      l?.receiverAddress, l?.receiverCity, l?.receiverArea, l?.status, kindOf(m).label,
    ],
    text: [l?.rawRow],
  };
}

/**
 * ONE PRESS TO OPEN A QUEUE, NOT ONE PRESS TO CLOSE FIVE (the owner, 12/11: «هدول يكونو مخفيات لانو أول ما أفتح بيكونو معروضات» ·
 * «الصفحة بتضل تنزل للمالانهاية وبيظهر أبيض»).
 *
 * Every queue that had a line in it opened itself, whole, the moment the statement loaded — and «طلبات لم يذكرها أي كشف» can hold
 * hundreds (938 on the owner's statement) in a table that scrolls inside the page: the page seemed to have no bottom, and the
 * browser painted white where it had not caught up. The queues start CLOSED now, each with its count and the number of lines still a
 * question on its heading; the two summary cards above them fold the same way (`FoldCard`).
 *
 * `queuesStartOpen` is the old behaviour, kept for a caller that wants it (the tests of the queues' contents read rows at once).
 */
export function MatchingScreen({ queuesStartOpen = false }: { queuesStartOpen?: boolean } = {}) {
  const toast = useToast();
  const { currentUser } = useApp();
  const mayManual = userCan(currentUser, 'ops.track');
  const mayReview = userCan(currentUser, 'settlement.review');
  const [mode, setMode] = useState<'statement' | 'manual'>(useSearchParams().get('mode') === 'manual' ? 'manual' : 'statement');
  const [statements, setStatements] = useState<StatementRow[] | null>(null);
  // «تسوية السطور النظيفة عند الاعتماد»: the two sentences the server sends only while the owner's switch is on, in place of the ones below.
  const [settling, setSettling] = useState<{ moneyIn: string; matchedHint: string } | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [busy, setBusy] = useState(false);
  const phone = useIsPhone();
  // What each queue of each statement is narrowed to — kept HERE, not in the queue, because the screen reloads its rows after
  // every answer and a queue that forgot its search each time would be a queue nobody could work through.
  const [views, setViews] = useState<Record<string, QueueView>>({});
  // And so is what a person has OPENED, and how far down a long queue she has drawn (the reviewer of #256, 12/11): the reload swaps
  // every queue and both cards for a spinner, which UNMOUNTS them — a fold kept inside would be shut again after EVERY answer, and the
  // owner would press «عرض» on «فرق في المبلغ» once per line. Kept for the visit only: nothing is written anywhere.
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [paged, setPaged] = useState<Record<string, Paged>>({});
  const [pinned, setPinned] = useState(readPinned);
  const openOf = (key: string) => ({
    open: opened[key],
    onOpenChange: (next: boolean) => setOpened((all) => (all[key] === next ? all : { ...all, [key]: next })),
  });
  const viewOf = (queueKey: string) => {
    const key = `${selected}|${queueKey}`;
    return {
      view: views[key] ?? NO_VIEW,
      onView: (next: QueueView) => setViews((all) => ({ ...all, [key]: next })),
      pinned,
      onPinned: (next: boolean) => {
        setPinned(next);
        writePinned(next);
      },
      startOpen: queuesStartOpen,
      ...openOf(key),
      paged: paged[key],
      onPaged: (next: Paged) => setPaged((all) => ({ ...all, [key]: next })),
    };
  };

  useEffect(() => {
    void apiJson<{ statements: StatementRow[]; settling?: { moneyIn: string; matchedHint: string } }>('/api/finance/statements')
      .then((payload) => {
        const d = { statements: payload.statements.filter((s) => !s.draft) };
        setStatements(d.statements);
        setSettling(payload.settling ?? null);
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
  const closed = statement ? isMatchingClosed(statement) : false;
  // The money is in and the matching is still open: the lines are answered here, the close is pressed beside the money.
  const moneyIn = statement ? isApproved(statement) && !closed : false;
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
                {s.reference} — {s.counts.matches} مطابقة{!isMatchingClosed(s) && (s.counts.openLines ?? 0) > 0 ? ` · ${s.counts.openLines} بلا بتّ` : ''}
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
          className={`h-11 md:h-10 px-4 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-medium inline-flex items-center gap-2 disabled:opacity-50 ${
            phone ? 'w-full justify-center' : ''
          }`}
        >
          {busy ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiGitBranchLine className="w-4 h-4" />}
          تشغيل المطابقة
        </button>
        {/* The reason it is grey, where a phone can read it: `title` never shows there. A closed statement already has
            its own paragraph under this card. */}
        {phone && !!selected && noReceipt && !closed && (
          <p className="w-full text-xs text-[var(--sys-muted-foreground)]">{whyNot}</p>
        )}
      </div>

      {closed && (
        <p className="text-xs text-[var(--sys-muted-foreground)] bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg p-3">
          {STATEMENT_CLOSED_SENTENCE}. مالُه في المحفظة وتُقرأ نتيجتُه هنا فقط: لا بتّ ولا ربط ولا إعادة مطابقة.
          كشف التسوية كشفٌ يدويّ بمرجعه، يبدأ من «يدوي — بلا كشف» ويُجمَّع ويُعتمد في «التحصيل والكشوف».
        </p>
      )}

      {moneyIn && (
        <p className="text-xs text-[var(--sys-muted-foreground)] bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg p-3">
          {settling?.moneyIn ??
            'المصاري دخلت المحفظة باعتماد الكشف، والمطابقة لسا مفتوحة: ابتّ بالأسطر هون، وبعدها اضغط «إغلاق المطابقة» من «التحصيل والكشوف» — عندها تتسوّى الطلبات بلا أي حركة جديدة بالمحفظة.'}
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
          {/* What the company wrote on its lines and where each kind landed — so a returned parcel is never «missing»: it is
              counted here whatever queue it fell into. */}
          <StatementTally matches={matches} {...openOf('card|tally')} />
          {/* The sum of the answers given below it: who keeps arriving short. */}
          <DifferencesByPerson currency={statement?.currencyCode ?? ''} {...openOf('card|people')} />
          <Queue
            title="مطابق"
            {...viewOf('MATCHED')}
            tone="emerald"
            currency={statement?.currencyCode ?? ''}
            rows={queue('MATCHED')}
            hint={settling?.matchedHint ?? 'المبلغ في الكشف يساوي المتوقَّع — تتسوّى هذه الطلبات وتصبح عمولتها مستحقة عند إغلاق المطابقة (بنفس ضغطة الاعتماد إذا ما ضل سطر بلا بتّ).'}
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
            {...viewOf('MISMATCHED')}
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
            {...viewOf('MISSING_IN_SYSTEM')}
            reason
            fromLine
            noOrder
            linkable={mayReview && !closed}
            parkable={mayReview}
            locked={closed}
            statementId={selected}
            onResolved={() => void load(selected!)}
            tone="amber"
            currency={statement?.currencyCode ?? ''}
            rows={queue('MISSING_IN_SYSTEM')}
            hint="ما لقينا طلباً عندنا بهالباركود أو المرجع في هذا المتجر — غالباً الطرد انعمل خارج النظام، أو هو من كشف شركة أخرى، أو المرجع مكتوب غلط. لهيك ما في «متوقَّع» ولا «فرق»: بنعرض اللي كتبته الشركة نفسها (المحصَّل والأجرة والصافي). اربط السطر بطلبه بهاتف الزبون أو برقم طلبنا — وقدام كل طلب مقترح بتشوف شو كتبت الشركة جنب شو عندنا. وإن لم يكن لنا فاكتب سببه وقل «قيد المراجعة» ليتابع الاعتماد."
          />
          <Queue
            title="مستبعدة — مرتجع أو مؤجل"
            {...viewOf('EXCLUDED')}
            reason
            fromLine
            tone="amber"
            currency={statement?.currencyCode ?? ''}
            rows={queue('EXCLUDED')}
            hint="كتبتها الشركة بصفر وقالت إن الطرد رجع أو تأجّل، ولهالطرد طلب عندنا وهو على الطريق أو راجع. مش مصاري ولا سؤال: ما بتوقّف الاعتماد ولا بتتسوّى. المرتجع بيتابعه قسم المرتجعات، والمؤجل بيجي بكشف جاي. الراجع اللي ما عندنا طلب له مش هون: بتلاقيه في «في الكشف وليس عندنا»."
          />
          <Queue
            title="طلبات لم يذكرها أي كشف"
            {...viewOf('MISSING_IN_STATEMENT')}
            unmentioned
            canUnlock={userCan(currentUser, 'orders.unlock')}
            statementId={selected}
            onResolved={() => void load(selected!)}
            tone="amber"
            currency={statement?.currencyCode ?? ''}
            rows={queue('MISSING_IN_STATEMENT')}
            hint="هاي طلباتنا نحنا، مش أسطر الكشف: نظامنا بيعتبرها مسلَّمة مع شركة هالكشف، ولسا ما انذكرت بأي كشف منها. العدد بيتغيّر من كشف لكشف لأنو بينحسب لحظة تشغيل المطابقة لشركة الكشف ومتجره وفترته، وكل كشف جديد بيذكر طلبات فبيشيلها من القائمة عند مطابقته. لكل طلب كلمة نتيجته، وما تقرره بشأنه (انتظر كشفاً لاحقاً / طالِب الشركة / لم يُسلَّم) بيُسجَّل على الطلب نفسه ولا يُحسب فرقاً في المبلغ ولا بيحرّك مصاري."
          />
        </div>
      )}

      {/* The money road goes on from here: «الإغلاق». */}
      <NextStepButton />
    </div>
  );
}

/**
 * How many lines of a queue are drawn at a time. A queue can hold hundreds — «طلبات لم يذكرها أي كشف» held 938 on the owner's
 * statement — and a table that long, inside a page, is the page that «بتضل تنزل للمالانهاية وبيظهر أبيض» (the owner, 12/11): the
 * browser cannot paint it as fast as it is scrolled. The heading still counts ALL the lines, the search and the filters still look
 * through ALL of them, and the gate counts all of them; only the DRAWING is paged.
 */
const PAGE_ROWS = 100;

/** How many pages of a queue are drawn, and the narrowing they were counted for — a new search or filter starts again from the first. */
interface Paged {
  key: string;
  pages: number;
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
  fromLine,
  noOrder,
  linkable,
  parkable,
  canUnlock,
  locked,
  statementId,
  onResolved,
  view,
  onView,
  pinned,
  onPinned,
  startOpen,
  open,
  onOpenChange,
  paged,
  onPaged,
}: {
  title: string;
  tone: string;
  rows: Match[];
  /** Open itself when it has lines (the old behaviour). Absent — the screen's default — it starts closed, with its count on the heading. */
  startOpen?: boolean;
  /** Open or shut as the person left it — kept by the screen (`viewOf`), because every reload unmounts the queue. Never touched: `startOpen` decides. */
  open?: boolean;
  onOpenChange: (next: boolean) => void;
  /** How many pages are drawn — kept by the screen for the same reason. */
  paged?: Paged;
  onPaged: (next: Paged) => void;
  /** What this queue is narrowed to (search, kind, only-unanswered) — kept by the screen so it survives a reload of the rows. */
  view: QueueView;
  onView: (next: QueueView) => void;
  /** The column headings stay in view while a long list scrolls. Shared by every queue; remembered per browser. */
  pinned: boolean;
  onPinned: (next: boolean) => void;
  hint: string;
  currency: string;
  /**
   * The company's line is all there is to read: no figure of ours was written on the row (a line no order carries, a line
   * the matching excluded). The money columns then show what the company WROTE — what it collected, the fee it kept, the net
   * it hands over — instead of dashes under «المتوقَّع» and «الفرق», which have no figure to show.
   */
  fromLine?: boolean;
  /** No order of ours is tied to the row at all: no «الطلب», no «طوبق عبر» — they would be a dash on every row. */
  noOrder?: boolean;
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
  const isOpen = open ?? (!!startOpen && rows.length > 0 && tone !== 'emerald');
  // The lines of this queue still a question — by the same rule the approval counts (`statement-open-lines`).
  // Counted on ALL the rows: a search hides rows from view and never from the gate.
  const unanswered = resolvable || parkable ? countOpenLines(rows) : 0;
  const onPhone = useIsPhone();
  const kinds = useMemo(() => queueKinds(rows), [rows]);
  const shown = useMemo(
    () =>
      rows.filter(
        (m) =>
          (view.kind === '' || kindOf(m).key === view.kind) &&
          (!view.onlyOpen || isOpenLine(m)) &&
          matchesQuery(searchPartsOf(m), view.query)
      ),
    [rows, view]
  );
  // A PAGE AT A TIME (`PAGE_ROWS`). The page is kept per narrowing — a new search or filter starts again from the first page — and is
  // READ against the view rather than reset in an effect. It is kept BY THE SCREEN (`paged`, like `view`): the reload after an answer
  // unmounts this queue, and a count kept in here would throw a person back to the first hundred of a list she is working through.
  const viewKey = `${view.kind}|${view.onlyOpen ? 1 : 0}|${view.query}`;
  const pages = paged && paged.key === viewKey ? paged.pages : 1;
  const drawn = shown.length > pages * PAGE_ROWS ? shown.slice(0, pages * PAGE_ROWS) : shown;

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
            <>
              {/* Where no order of ours is tied to the row, this number is THE COMPANY'S: say whose it is. */}
              {fromLine && (
                <span dir="rtl" className="block text-xs text-[var(--sys-muted)]">
                  رقم الطلب عندهم:
                </span>
              )}
              <span className="block text-xs text-[var(--sys-muted)]">
                {m.statementLine?.merchantRef ?? m.order?.merchantRef}
              </span>
            </>
          )}
        </span>
      ),
    },
    // «ليش مش حاط الطلب» — a line no order carries has no order to show: the column would be a dash on every row.
    ...(noOrder
      ? []
      : [
          {
            key: 'order',
            label: 'الطلب',
            primary: true,
            render: (m: Match) =>
              m.order ? (
                <OrderRef id={m.order.id} number={m.order.orderNumber} className="text-[var(--sys-primary)]" />
              ) : (
                <span className="text-[var(--sys-muted)]">—</span>
              ),
          },
        ]),
    // Nor has it a figure of ours: «المتوقَّع» and «الفرق» are what an ORDER says, and a line with no order has none.
    ...(fromLine
      ? []
      : [
          {
            key: 'expected',
            label: 'المتوقَّع',
            align: 'end' as const,
            render: (m: Match) =>
              num(m.expectedAmount) === null ? '—' : <Money value={num(m.expectedAmount)!} currency={currency} />,
          },
        ]),
    // The order's OWN outcome word — «تم التسليم — بانتظار التحصيل», «مغلق» — read from the order, never stored.
    ...(unmentioned
      ? [
          {
            key: 'outcome',
            label: 'كلمة نتيجته',
            render: (m: Match) => m.orderOutcome?.label ?? '—',
          },
        ]
      : fromLine
        ? [
            // What the company wrote about the money of the line, as it wrote it — read off the line, never worked out here.
            {
              key: 'collected',
              label: 'المحصَّل من الزبون',
              align: 'end' as const,
              render: (m: Match) =>
                num(m.statementLine?.collected) === null ? '—' : <Money value={num(m.statementLine?.collected)!} currency={currency} />,
            },
            {
              key: 'stated',
              label: 'الصافي في الكشف',
              align: 'end' as const,
              render: (m: Match) =>
                num(m.statementAmount) === null ? '—' : <Money value={num(m.statementAmount)!} currency={currency} />,
            },
            {
              key: 'fee',
              label: 'أجرة الشركة',
              align: 'end' as const,
              // The row's own fee when the matching wrote one; otherwise the one on the company's line.
              render: (m: Match) => {
                const fee = num(m.statementFee) ?? num(m.statementLine?.fee);
                return fee === null ? <span className="text-[var(--sys-muted)]">—</span> : <Money value={fee} currency={currency} />;
              },
            },
          ]
        : [
          // What the customer paid, as the company says it: the figure the reason cell used to carry, now in a column of its own.
          {
            key: 'collected',
            label: 'المحصَّل من الزبون',
            align: 'end' as const,
            render: (m: Match) =>
              num(m.statementLine?.collected) === null ? '—' : <Money value={num(m.statementLine?.collected)!} currency={currency} />,
          },
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
     * THE COMPANY'S OWN REASON, IN ITS OWN WORDS — LAID OUT.
     *
     * Its status word, read through the one phrase table — and, whatever the table says, the word itself,
     * so an unknown word is shown rather than hidden. Under it FOUR things, and only these (the owner, 8/11, shown the
     * whole row dumped here: «هاي كلها لغي، بدي بس الأشياء الأساسية — العنوان والمحافظة ورقم الهاتف والحالة»): the
     * phone, the governorate, the address and the status. The figures went to the columns beside it and the order number
     * under the barcode; the whole row as the company wrote it stays one press away («النص الأصلي»), so nothing the
     * company said is hidden behind the tidy version.
     */
    ...(reason
      ? [
          {
            key: 'reason',
            label: 'سبب الشركة بكلامها',
            // A sentence in the company's own words: the width of the card, not what the label left over.
            wide: true,
            render: (m: Match) => <CourierReason m={m} />,
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
            wide: true,
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
            wide: true,
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
    ...(unmentioned || noOrder
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
        onClick={() => onOpenChange(!isOpen)}
        aria-expanded={isOpen}
        className="w-full flex items-center justify-between px-4 py-3 text-right"
      >
        <span className="flex items-center gap-2">
          <span className={`text-xs px-2 py-1 rounded-full border ${TONE[tone]}`}>{rows.length}</span>
          <span className="text-sm font-medium text-[var(--sys-heading)]">{title}</span>
          {!locked && unanswered > 0 && <span className="text-xs text-[var(--sys-warning)]">{unanswered} بلا بتّ</span>}
        </span>
        <span className="text-xs text-[var(--sys-muted)]">{isOpen ? 'إخفاء' : 'عرض'}</span>
      </button>

      {isOpen && (
        <div className="border-t border-[var(--sys-border)]">
          <p className="text-xs text-[var(--sys-muted-foreground)] px-4 py-2 bg-[var(--sys-surface)]">{hint}</p>
          {rows.length === 0 ? (
            <EmptyState title="لا شيء في هذه المجموعة" why={hint} />
          ) : (
            <>
              <QueueTools
                view={view}
                onView={onView}
                kinds={kinds}
                kindLabel={unmentioned ? 'كلمة نتيجته' : 'ما كتبته الشركة'}
                // A closed statement has no question left to answer: no counter, and no «بلا بتّ فقط» either.
                openCount={locked ? 0 : unanswered}
                shown={shown.length}
                total={rows.length}
                pin={onPhone ? undefined : { pinned, onChange: onPinned }}
              />
              <Rows
                rows={drawn}
                pinHeader={pinned && !onPhone}
                keyOf={(m) => m.id}
                alert={(m) => num(m.difference) !== null && num(m.difference) !== 0}
                columns={columns}
                empty={
                  shown.length === 0 && rows.length > 0 ? (
                    <EmptyState title="ما في سطر بهالبحث أو الفلتر" why="غيّر الكلمة أو الفلتر، أو اضغط «امسح البحث والفلتر»." />
                  ) : (
                    <EmptyState title="لا أسطر في هذه المجموعة" why={hint} />
                  )
                }
              />
              {drawn.length < shown.length && (
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--sys-border)] px-4 py-3">
                  <span className="text-xs text-[var(--sys-muted-foreground)]">
                    معروض {drawn.length} من {shown.length} سطر
                  </span>
                  <button
                    type="button"
                    onClick={() => onPaged({ key: viewKey, pages: pages + 1 })}
                    className="min-h-11 md:min-h-0 inline-flex items-center rounded-lg border border-[var(--sys-border)] px-3 py-1.5 text-xs font-semibold text-[var(--sys-primary)] hover:border-[var(--sys-primary)]"
                  >
                    اعرض {Math.min(PAGE_ROWS, shown.length - drawn.length)} كمان
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * «سبب الشركة» lives in its own file since 13/11, so that the follow-up screen's «فيه فرق» dialog can draw the very same
 * cell without dragging this whole screen into its page. This screen still draws it from there, and still exports it.
 */
export { CourierReason };
