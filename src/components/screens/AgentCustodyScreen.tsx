'use client';

import React, { useCallback, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { amount, arDateShort, type Currency } from '@/lib/format';
import { RiAlertLine, RiArchiveLine, RiArrowLeftSLine, RiEBike2Line, RiLoader4Line, RiQuestionLine, RiUserLocationLine, RiWallet3Line } from '@remixicon/react';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { NextStepButton } from '@/components/ui/NextStep';
import { SHIPPING_STATUS_AR } from '@/lib/shipping-workflow';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useIsPhone } from '@/hooks/useIsPhone';
import { OrderLink } from '@/components/orders/OrderLink';

/**
 * /finance/agents — what each agent is holding.
 *
 * A shipping company sends a statement and we match it. An agent sends
 * nothing: he takes parcels, knocks on doors, collects cash, and comes back.
 * Until now nobody could say how much of either was in his hands.
 *
 * Everything here is derived from the orders he is carrying, so there is no
 * custody figure to correct and none to drift. And nothing here moves money:
 * receiving from an agent is a settlement, and settlements go through their
 * own chain.
 *
 * ── THE FIGURE THAT USED TO LIE ──
 *
 * «حصّله» means «he collected it». The screen printed the ORDER TOTAL under
 * that word whenever nothing had recorded what he actually took — which, on
 * this database, is every delivered order there is: the door does not write
 * `collectedAmount` any more, the courier's settlement does, on approval. So
 * this screen told an owner a man owed him money nothing had established the
 * man ever held.
 *
 * Confirmed cash and delivered-but-unrecorded orders are now two separate
 * columns that never add together, and the screen says in words why the second
 * one carries no amount. Every figure comes from the server; nothing on this
 * page computes money.
 */

interface Totals {
  inHandCount: number;
  inHandValue: number;
  /** Cash recorded at the door. Only this is money. */
  collected: number;
  fees: number;
  balance: number;
  /** Delivered orders nobody has recorded an amount for. */
  awaitingCount: number;
  awaitingValue: number;
  awaitingFees: number;
  hasUnconfirmed: boolean;
}

interface CustodyOrder {
  id: string;
  orderNumber: string;
  customerName: string;
  regionName: string | null;
  shippingStatus: string;
  shippedAt: string | null;
  deliveredAt: string | null;
  /** What the order is worth. */
  orderValue: number;
  /** What he took at the door — null while nothing has recorded it. */
  collected: number | null;
  fee: number;
}

interface Detail {
  agent: { id: string; name: string; code: string };
  currencyCode: string;
  inHand: CustodyOrder[];
  owing: CustodyOrder[];
  totals: Totals;
}

/* The words come from `SHIPPING_STATUS_AR` — this screen called a
 * delivered parcel «سُلّم» while the badge above it said «مسلَّم». */
const STATUS_AR: Record<string, string> = SHIPPING_STATUS_AR;

/** Said once, wherever an unrecorded amount has to be explained. */
const WHY_NO_AMOUNT =
  'المبلغ المحصَّل يُكتب حين تُعتمد التسوية التي تغطّي الطلب — لا عند الطَرق على الباب. فما لم تُعتمد تسويةٌ لهذه الطلبات، لا يعرف النظام كم قبض فعلاً، ولا يخمّنه.';

export function AgentCustodyScreen() {
  const [agents, setAgents] = useState<{ agent: Detail['agent']; totals: Totals }[] | null>(null);
  const [currency, setCurrency] = useState<Currency | null>(null);
  const [open, setOpen] = useState<Detail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Before the early return below: a hook after it would be skipped on the first render.
  const phone = useIsPhone();

  const load = useCallback(async () => {
    try {
      const res = await apiJson<{ agents: typeof agents; currencyCode: string; minorUnit: number }>('/api/finance/agents');
      setAgents(res.agents ?? []);
      setCurrency({ code: res.currencyCode, minorUnit: res.minorUnit });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, []);

  useLiveRefresh(load);

  async function openAgent(id: string) {
    setLoadingDetail(true);
    setError(null);
    try {
      const res = await apiJson<{ custody: Detail }>(`/api/finance/agents?id=${encodeURIComponent(id)}`);
      setOpen(res.custody);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر فتح العهدة');
    } finally {
      setLoadingDetail(false);
    }
  }

  if (!agents) {
    return (
      <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-16">
        <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
      </div>
    );
  }

  const money = (n: number) => amount(n, currency);

  if (open) {
    const confirmed = open.owing.filter((o) => o.collected !== null);
    const awaiting = open.owing.filter((o) => o.collected === null);

    return (
      <div className="max-w-4xl space-y-4">
        <button
          onClick={() => setOpen(null)}
          className="min-h-11 md:min-h-0 text-xs text-[var(--sys-muted-foreground)] hover:text-[var(--sys-primary)] inline-flex items-center gap-1"
        >
          <RiArrowLeftSLine className="icon-mirror w-4 h-4" />
          كل المندوبين
        </button>

        <PageHeader title={`عهدة ${open.agent.name}`}
          description={open.agent.code}
        />

        <Summary totals={open.totals} money={money} />

        <Section
          title="ما زال بيده"
          subtitle="طلبات خرجت معه ولم تُغلق بعد — بضاعة، لا مال"
          icon={RiArchiveLine}
          orders={open.inHand}
          money={money}
          showFee={false}
          phone={phone}
        />

        <Section
          title="حصّله ولم يسلّمه"
          subtitle="سُلّمت، وسُجِّل ما قُبض فيها، ولم يصل إلينا بعد"
          icon={RiWallet3Line}
          orders={confirmed}
          money={money}
          showFee
          phone={phone}
        />

        {/*
          DELIVERED, AND NOBODY WROTE DOWN WHAT HE TOOK.

          These used to sit in the section above with the ORDER TOTAL printed
          beside them as if it were cash he was holding. They are the same
          orders; what changed is that the screen no longer answers a question
          it has not been told the answer to.
        */}
        {awaiting.length > 0 && (
          <Section
            title="سُلّمت ولا مبلغ مؤكَّد"
            subtitle={WHY_NO_AMOUNT}
            icon={RiQuestionLine}
            orders={awaiting}
            money={money}
            showFee
            phone={phone}
          />
        )}

        {/*
          WHERE THE MONEY IS ACTUALLY RECEIVED — AND IT IS NOT /finance/collection.

          This screen counts what he holds and stops there, deliberately:
          taking cash in writes a wallet movement, and that belongs to the
          endpoint with the guards on it, not to a report.

          The door it pointed at was the wrong one. /finance/collection is the
          STATEMENT chain — upload a file, record the receipt, approve — and an
          agent sends no file; its form cannot be submitted without one. Taking
          cash from a مندوب is the manual collection on متابعة الشحن: name the
          delivered orders, name the wallet, and the movement is written there
          with the same gate on it (orders already settled are refused, and the
          commission becomes payable only then).
        */}
        {open.owing.length > 0 && (
          <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-4 space-y-2">
            <h4 className="text-xs font-black text-[var(--sys-foreground)]">
              استلام ما بذمّته
            </h4>
            <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
              المندوب لا يرسل كشفاً، فتحصيلُه يدويّ: من شاشة متابعة الشحن تُختار طلباتُه
              المسلَّمة وتُسمّى المحفظة، فتُكتب حركةُ المحفظة هناك وتُغلق الطلبات وتصبح عمولتُها
              مستحقّة. لا يُكتب مالٌ من هذه الشاشة، ولا تصلح شاشةُ الكشوف لمندوب.
            </p>
            <a
              href="/ops/tracking"
              className="min-h-11 md:min-h-0 inline-flex items-center gap-1.5 rounded-lg bg-[var(--sys-primary)] px-4 py-1.5 text-xs font-medium text-[var(--sys-primary-foreground)]"
            >
              <RiWallet3Line className="w-4 h-4" aria-hidden />
              سجّل تحصيلاً يدويّاً من {open.agent.name}
            </a>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-4">
      <PageHeader title="عهدة المندوبين"
          description="ما بيد كل مندوب الآن: بضاعة لم تُغلق، ومال مؤكَّد حصّله ولم يسلّمه، وطلبات سُلّمت بلا مبلغ مسجَّل."
        />

      {error && (
        <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">{error}</p>
      )}

      {agents.length === 0 ? (
        <EmptyState
          icon={RiUserLocationLine}
          title="لا مندوبين لهذا المتجر"
          why="المندوبون يُضافون من الإعدادات ← شركات الشحن بنوع «مندوب»، ثم يظهر عهدةُ كل واحد هنا."
        />
      ) : (
        <ul className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg divide-y divide-[var(--sys-border)]">
          {agents.map(({ agent, totals }) => (
            <li key={agent.id}>
              <button
                onClick={() => openAgent(agent.id)}
                disabled={loadingDetail}
                className="w-full text-start p-4 hover:bg-[var(--sys-surface)] transition-colors disabled:opacity-60"
              >
                {phone ? (
                  /* Three ragged lines of labels and figures became the name and the balance on one line and the three
                     figures under it, each under its own name. */
                  <>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-[var(--sys-heading)] text-sm inline-flex items-center gap-1.5 min-w-0">
                        <RiEBike2Line className="w-4 h-4 text-[var(--sys-primary)]" />
                        {agent.name}
                      </span>
                      <Balance totals={totals} money={money} />
                    </div>
                    <dl className="mt-2 grid grid-cols-3 gap-2 text-xs text-[var(--sys-muted-foreground)]">
                      <div>
                        <dt>بيده</dt>
                        <dd className="font-semibold text-[var(--sys-heading)] tabular-nums">
                          {totals.inHandCount} طلب
                          <span className="block font-normal text-[var(--sys-muted)]" dir="ltr">{money(totals.inHandValue)}</span>
                        </dd>
                      </div>
                      <div>
                        <dt>حصّل مؤكَّد</dt>
                        <dd className="font-semibold text-[var(--sys-heading)] tabular-nums" dir="ltr">{money(totals.collected)}</dd>
                      </div>
                      <div>
                        <dt>له</dt>
                        <dd className="font-semibold text-[var(--sys-heading)] tabular-nums" dir="ltr">{money(totals.fees)}</dd>
                      </div>
                    </dl>
                  </>
                ) : (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                  <span className="font-bold text-[var(--sys-heading)] text-sm inline-flex items-center gap-1.5 min-w-[130px]">
                    <RiEBike2Line className="w-4 h-4 text-[var(--sys-primary)]" />
                    {agent.name}
                  </span>

                  <span className="text-xs text-[var(--sys-muted-foreground)]">
                    بيده:{' '}
                    <span className="font-semibold text-[var(--sys-heading)] tabular-nums">{totals.inHandCount}</span> طلب
                    <span className="text-[var(--sys-muted)]"> ({money(totals.inHandValue)})</span>
                  </span>

                  <span className="text-xs text-[var(--sys-muted-foreground)]">
                    حصّل مؤكَّد: <span className="font-semibold text-[var(--sys-heading)] tabular-nums">{money(totals.collected)}</span>
                  </span>

                  <span className="text-xs text-[var(--sys-muted-foreground)]">
                    له: <span className="font-semibold text-[var(--sys-heading)] tabular-nums">{money(totals.fees)}</span>
                  </span>

                  <Balance totals={totals} money={money} />
                </div>
                )}

                {/* Not a footnote. An owner reading «صافي عليه 0» beside an
                    agent carrying twelve delivered orders needs to know which
                    of the two facts he is looking at. */}
                {totals.hasUnconfirmed && (
                  <p className="mt-1.5 text-xs text-[var(--sys-warning)] tabular-nums">
                    و{totals.awaitingCount} طلباً سُلّم بلا مبلغ مسجَّل (قيمة الطلبات {money(totals.awaitingValue)}) — غير محتسب
                  </p>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-[var(--sys-muted)]">
        الأرقام محسوبة من الطلبات نفسها لحظة فتح الشاشة — لا رصيد مخزَّن يمكن أن يختلف عن الواقع.
        و«حصّل مؤكَّد» هو ما سُجِّل فعلاً لا ما نتوقّعه: {WHY_NO_AMOUNT}
      </p>

      {/* The money road goes on from here: «التحصيل». */}
      <NextStepButton />
    </div>
  );
}

/**
 * The net, and the refusal to call it balanced when it is merely unknown.
 *
 * «متوازن» over an agent carrying delivered orders nobody has priced is the
 * reassurance this screen was giving; it is the thing that had to go.
 */
function Balance({ totals, money }: { totals: Totals; money: (n: number) => string }) {
  const value = totals.balance;
  const owesUs = value > 0;
  const weOwe = value < 0;
  const unknownOnly = value === 0 && totals.hasUnconfirmed;

  return (
    <span
      className={`ms-auto text-xs font-bold tabular-nums px-2.5 py-1 rounded-md border ${
        owesUs || unknownOnly
          ? 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] border-[var(--sys-warning)]'
          : 'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)] border-[var(--sys-border)]'
      }`}
    >
      {unknownOnly
        ? 'لا مبلغ مؤكَّد بعد'
        : `${owesUs ? 'عليه ' : weOwe ? 'له ' : 'متوازن '}${money(Math.abs(value))}`}
    </span>
  );
}

function Summary({ totals, money }: { totals: Totals; money: (n: number) => string }) {
  const unknownOnly = totals.balance === 0 && totals.hasUnconfirmed;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Tile label="طلبات بيده" value={String(totals.inHandCount)} hint={money(totals.inHandValue)} />
        <Tile label="حصّله (مؤكَّد)" value={money(totals.collected)} />
        <Tile label="أجوره علينا (مؤكَّد)" value={money(totals.fees)} />
        <div
          className={`rounded-lg border p-3 ${
            totals.balance > 0 || unknownOnly
              ? 'bg-[var(--sys-warning-soft)] border-[var(--sys-warning)]'
              : 'bg-[var(--sys-surface)] border-[var(--sys-border)]'
          }`}
        >
          <p className="text-xs text-[var(--sys-muted-foreground)]">
            {unknownOnly
              ? 'لا مبلغ مؤكَّد'
              : totals.balance > 0
                ? 'صافي عليه'
                : totals.balance < 0
                  ? 'صافي له'
                  : 'متوازن'}
          </p>
          <p className="text-sm font-black text-[var(--sys-heading)] tabular-nums mt-0.5" dir="ltr">
            {unknownOnly ? '—' : money(Math.abs(totals.balance))}
          </p>
        </div>
      </div>

      {/* The other half of the picture, in a strip of its own so it can never
          be mistaken for cash. */}
      {totals.hasUnconfirmed && (
        <p className="rounded-lg border border-[var(--sys-warning)] bg-[var(--sys-warning-soft)] p-3 text-xs leading-relaxed text-[var(--sys-warning)]">
          <RiAlertLine className="w-4 h-4 inline align-[-3px] me-1" aria-hidden />
          <span className="tabular-nums">{totals.awaitingCount}</span> طلباً سُلّم ولم يُسجَّل له مبلغ محصَّل —
          قيمة هذه الطلبات <span className="tabular-nums">{money(totals.awaitingValue)}</span> وأجورها{' '}
          <span className="tabular-nums">{money(totals.awaitingFees)}</span>، وكلاهما خارج الصافي أعلاه.
          {' '}{WHY_NO_AMOUNT}
        </p>
      )}
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-3">
      <p className="text-xs text-[var(--sys-muted-foreground)]">{label}</p>
      <p className="text-sm font-black text-[var(--sys-heading)] tabular-nums mt-0.5" dir="ltr">{value}</p>
      {hint && <p className="text-xs text-[var(--sys-muted)] tabular-nums" dir="ltr">{hint}</p>}
    </div>
  );
}

function Section({
  title, subtitle, icon: Icon, orders, money, showFee, phone = false,
}: {
  title: string;
  subtitle: string;
  icon: React.ElementType;
  orders: CustodyOrder[];
  money: (n: number) => string;
  showFee: boolean;
  phone?: boolean;
}) {
  // «أجرة 2.000 JOD» inside one `dir="ltr"` span puts the Arabic label on the LEFT of its figure, so a right-to-left
  // reader meets «JOD 2.000 أجرة». On a phone only the FIGURE is left-to-right and the label stays outside it.
  const fig = (n: number) => (phone ? <span dir="ltr">{money(n)}</span> : money(n));
  return (
    <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg">
      <div className="px-4 py-3 border-b border-[var(--sys-border)]">
        <h4 className="text-xs font-black text-[var(--sys-heading)] flex items-center gap-2">
          <Icon className="w-4 h-4 text-[var(--sys-primary)]" />
          {title}
          <span className="text-xs font-medium text-[var(--sys-muted)] tabular-nums">{orders.length}</span>
        </h4>
        <p className="text-xs text-[var(--sys-muted)] mt-0.5 leading-relaxed">{subtitle}</p>
      </div>

      {orders.length === 0 ? (
        <EmptyState
          title="لا طلبات في هذه العهدة"
          why="عهدةُ المندوب تمتلئ حين تُسلَّم إليه شحنة. إن كنت تنتظر طلباً هنا، فهو لم يُسلَّم بعد أو سُلِّم لمندوبٍ آخر."
        />
      ) : (
        <ul className="divide-y divide-[var(--sys-border)]">
          {orders.map((o) => {
            const stuck = o.shippingStatus === 'FAILED_DELIVERY' || o.shippingStatus === 'RETURN_REQUESTED';
            return (
              <li key={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-xs">
                <OrderLink id={o.id} number={o.orderNumber} className="font-semibold text-[var(--sys-heading)]" />
                {stuck && (
                  <span className="inline-flex items-center gap-1 text-[var(--sys-warning)]">
                    <RiAlertLine className="w-4 h-4" />
                    {STATUS_AR[o.shippingStatus]}
                  </span>
                )}
                <span className="text-[var(--sys-muted-foreground)] truncate max-w-[160px]">{o.customerName}</span>
                {o.regionName && <span className="text-[var(--sys-muted)]">{o.regionName}</span>}
                <span className="text-[var(--sys-muted)]">
                  {arDateShort(o.deliveredAt ?? o.shippedAt)}
                </span>
                {showFee && (
                  <span className="text-[var(--sys-muted)] tabular-nums" dir={phone ? undefined : 'ltr'}>
                    أجرة {fig(o.fee)}
                  </span>
                )}
                {/* One amount per row, and it says which amount it is. A
                    delivered order with nothing recorded shows the order's
                    value, labelled as the order's value. */}
                <span className="ms-auto font-bold text-[var(--sys-heading)] tabular-nums" dir={phone ? undefined : 'ltr'}>
                  {o.collected === null ? (
                    <span className="font-medium text-[var(--sys-warning)]">
                      قيمة الطلب {fig(o.orderValue)}
                    </span>
                  ) : (
                    fig(o.collected)
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
