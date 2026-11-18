'use client';

import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';
import { PayoutDialog } from '@/components/screens/commission/PayoutDialog';
import { ASSIGNABLE_ROLES, ROLE_LABELS } from '@/types/auth';
import { PeriodProgress } from '@/components/screens/commission/PeriodProgress';
import { FairnessPanel, type FairnessData } from '@/components/screens/commission/FairnessPanel';
import { PageShell } from '@/components/ui/PageShell';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Card } from '@/components/ui/Card';
import { Segmented } from '@/components/ui/Segmented';
import { routeLabel } from '@/lib/route-registry';
import { AgentCommissionCard } from '@/components/settings/AgentCommissionCard';
import {
  COMMISSION_METRICS, COMMISSION_TYPES, METRIC_LABEL_AR, PERIOD_LABEL_AR, TYPE_LABEL_AR,
  isTarget, targetGoal, tiersProblem,
  type CommissionMetric, type CommissionPeriod, type CommissionType, type Tier,
} from '@/lib/commission-rules';
import React, { useCallback, useEffect, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { Modal } from '@/components/ui/Modal';
import { RiAddCircleLine, RiAlertLine, RiLoader4Line, RiPercentLine } from '@remixicon/react';
import { Rows } from '@/components/ui/Rows';
import { EmptyState } from '@/components/ui/EmptyState';
import { Money } from '@/components/ui/Money';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useIsPhone } from '@/hooks/useIsPhone';

/**
 * /settings/commission — commission rules are dated data, not settings. A
 * rule is never edited in place: you end the old one on a date and write a
 * new one from the next, so anything already accrued keeps the rule that was
 * in force on its delivery day.
 */


/** A band as it is being typed: empty strings until it is a number. */
interface TierDraft {
  from: string;
  to: string;
  value: string;
  label: string;
}

/** A rule's single value, said the way its type means it. */
function valueLabel(type: CommissionType, value: number): string {
  if (type === 'PERCENT') return `${value}%`;
  return type === 'PER_ORDER' ? `${value} لكل طلب` : `${value} ثابت`;
}

interface Rule {
  id: string;
  name: string;
  appliesToRole: string | null;
  appliesToUserId: string | null;
  appliesToUserName: string | null;
  type: CommissionType;
  value: number;
  metric: CommissionMetric;
  period: CommissionPeriod;
  tiers: Tier[] | null;
  minOrders: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
  /** In force right now — not merely active with a future or past date. */
  inForce: boolean;

}

interface Totals {
  userId: string;
  name: string;
  accrued: number;
  payable: number;
  paid: number;
  reversed: number;
}

/**
 * The roles a rule may name — read from the system's own list.
 *
 * This was a hand-written list of four, and two of its values named roles
 * that do not exist: CONFIRMER where the system says CONFIRMATION_AGENT,
 * and SHIPPING where it says DELIVERY_MANAGER. A rule written for either of
 * them matched nobody, so it quietly never paid — the worst way for a
 * commission rule to be wrong, because the screen showed it as active.
 *
 * Taken from ASSIGNABLE_ROLES now, minus the ones nobody earns commission
 * in, so it cannot drift from the roles people are actually given.
 */
const NO_COMMISSION: string[] = ['PENDING_USER', 'SUPER_ADMIN', 'COMPANY_ADMIN'];
const ROLES = ASSIGNABLE_ROLES.filter((r) => !NO_COMMISSION.includes(r)).map((value) => ({
  value,
  label: ROLE_LABELS[value]?.ar ?? value,
}));

const period = () => new Date().toISOString().slice(0, 7);

export function CommissionSettingsScreen() {
  // On a phone the screen's one press («قاعدة جديدة») comes up under the title, and a tiered rule shows its bands on
  // its card: neither fits the desk's arrangement, which stays as it is.
  const phone = useIsPhone();
  const [rules, setRules] = useState<Rule[] | null>(null);
  /** No rule governs this store today: nothing accrues, and it must be said. */
  const [noRuleInForce, setNoRuleInForce] = useState(false);
  /** Who is being paid right now, if anybody. */
  const [paying, setPaying] = useState<{ id: string; name: string } | null>(null);
  // Paying is money leaving the business, not a report being read — the
  // server asks for the same key, so a hidden button is not the guard.
  const { currentUser } = useApp();
  const canPay = userCan(currentUser, 'finance.create');
  // Writing a rule decides what people are paid: its own box, and the page opening does not carry it.
  const canManage = userCan(currentUser, 'commission.manage');
  const [totals, setTotals] = useState<Totals[] | null>(null);
  // Whether the volume each person is paid on reflects their work or the
  // calendar. Read from the same response as the money, so the two cannot
  // describe different months.
  const [fairness, setFairness] = useState<FairnessData | null>(null);
  const [currency, setCurrency] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [endFor, setEndFor] = useState<Rule | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, c] = await Promise.all([
        apiJson<{ rules: Rule[]; noRuleInForce: boolean }>('/api/settings/commission'),
        apiJson<{ totals: Totals[]; currencyCode: string; fairness: FairnessData }>(
          `/api/finance/commission?period=${period()}`
        ).catch(() => null),
      ]);
      setRules(r.rules);
      setNoRuleInForce(!!r.noRuleInForce);
      if (c) {
        setTotals(c.totals);
        setCurrency(c.currencyCode);
        setFairness(c.fairness ?? null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, []);

  useLiveRefresh(load);

  return (
    <PageShell
      title={routeLabel('/settings/commission')}
      width="wide"
      // «قاعدة جديدة» was in the header of the THIRD card: below the rule paragraph, the period list and the fairness
      // panel, so several screens down. On a phone it is the first thing under the title: the frame's actions row, which
      // a phone draws under the name (18/11, R13h: it was the first block after the header, the same place on the screen).
      actions={
        phone && canManage && (
          <Button onClick={() => setNewOpen(true)} className="w-full">
            <RiAddCircleLine className="w-4 h-4" /> قاعدة جديدة
          </Button>
        )
      }
    >
      <Card plain padding="sm">
        <p className="text-note text-[var(--sys-muted-foreground)]">
        القاعدة لا تُعدَّل بعد كتابتها: لإنهاء العمل بها حدِّد لها تاريخ انتهاء واكتب قاعدة جديدة من اليوم التالي.
        العمولة تُحتسب بالقاعدة السارية يوم التسليم، وتصبح مستحقة عند اعتماد كشف التحصيل.
        </p>
      </Card>

      {error && <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">{error}</p>}
      {done && <p className="text-sm text-[var(--sys-success)] bg-[var(--sys-success-soft)] border border-[var(--sys-success)]/30 rounded-lg p-3">{done}</p>}

      {/* A period rule only becomes money once its span closes, so without
          this there was nothing to see while it could still be changed. */}
      <PeriodProgress />

      {/* Whether the count a rule bands on reflects the person or the roster.
          It sits ABOVE the money table on purpose: the question «is this
          number fair» has to be asked before the number is read, not after
          somebody has already decided who deserves what. */}
      <FairnessPanel data={fairness} />

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--sys-border)]">
          <h2 className="text-sm font-medium text-[var(--sys-heading)]">قواعد العمولة</h2>
          {canManage && !phone && (
            <Button size="sm" onClick={() => setNewOpen(true)}>
              <RiAddCircleLine className="w-4 h-4" /> قاعدة جديدة
            </Button>
          )}
        </div>

        {/* A store with no rule in force earns nobody anything. That is
            correct arithmetic and reads on a payslip as a quiet month, so
            the screen says which it is instead of showing a silent zero. */}
        {noRuleInForce && rules && rules.length > 0 && (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-[var(--sys-warning)] bg-[var(--sys-warning-soft)] px-3 py-2.5 text-note leading-relaxed text-[var(--sys-warning)]">
            <RiAlertLine className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              لا قاعدة سارية على هذا المتجر اليوم — القواعد الموجودة إمّا منتهية أو معطّلة، فلا تُحتسب أي
              عمولة. أضف قاعدة سارية ليبدأ الاحتساب.
            </span>
          </div>
        )}

        {!rules ? (
          <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-12">
            <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
          </div>
        ) : rules.length === 0 ? (
          <p className="text-sm text-[var(--sys-muted-foreground)] py-10 text-center">
            <RiPercentLine className="w-5 h-5 mx-auto mb-2 text-[var(--sys-muted)]" />
            لا قواعد بعد — بدون قاعدة لا تُحتسب أي عمولة.
          </p>
        ) : (
          <Rows
            rows={rules}
            keyOf={(r) => r.id}
            columns={[
              {
                key: 'name',
                label: 'القاعدة',
                primary: true,
                render: (r) => (
                  <span
                    className={
                      r.effectiveTo || !r.isActive
                        ? 'text-[var(--sys-muted)]'
                        : 'font-medium text-[var(--sys-heading)]'
                    }
                  >
                    {r.name}
                  </span>
                ),
              },
              {
                key: 'who',
                label: 'تنطبق على',
                primary: true,
                render: (r) =>
                  r.appliesToUserName
                    ? r.appliesToUserName
                    : ROLES.find((x) => x.value === r.appliesToRole)?.label ?? r.appliesToRole ?? '—',
              },
              {
                key: 'metric',
                label: 'يُحتسب على',
                render: (r) => (
                  <span className="text-note text-[var(--sys-muted-foreground)]">
                    {METRIC_LABEL_AR[r.metric] ?? r.metric}
                    {r.period !== 'PER_ORDER' && ` · ${PERIOD_LABEL_AR[r.period] ?? r.period}`}
                  </span>
                ),
              },
              {
                key: 'value',
                label: 'القيمة',
                align: 'end',
                // The bands are a list, not a figure: the label above and the list under it at the card's width.
                wide: phone,
                render: (r) =>
                  isTarget(r) ? (
                    <span title={`مكافأة ${r.tiers![0].value} عند بلوغ ${targetGoal(r.tiers)}`}>
                      هدف {targetGoal(r.tiers)} ← {r.tiers![0].value}
                    </span>
                  ) : r.tiers && r.tiers.length > 0 ? (
                    <span
                      title={r.tiers
                        .map((t) => `${t.from}${t.to === null ? '+' : `–${t.to}`}: ${t.value}`)
                        .join(' · ')}
                    >
                      {r.tiers.length} شرائح
                      {/* What a rule pays was only in the `title`, which a phone never shows. */}
                      {phone &&
                        r.tiers.map((t, i) => (
                          <span key={i} className="block text-note text-[var(--sys-muted-foreground)] tabular-nums" dir="ltr">
                            {`${t.from}${t.to === null ? '+' : `–${t.to}`}: ${t.value}`}
                          </span>
                        ))}
                    </span>
                  ) : (
                    valueLabel(r.type, r.value)
                  ),
              },
              {
                key: 'from',
                label: 'من',
                render: (r) => (
                  <span className="text-note tabular-nums" dir="ltr">
                    {String(r.effectiveFrom).slice(0, 10)}
                  </span>
                ),
              },
              {
                key: 'to',
                label: 'إلى',
                render: (r) => (
                  <span className="text-note tabular-nums" dir="ltr">
                    {r.effectiveTo ? String(r.effectiveTo).slice(0, 10) : '—'}
                  </span>
                ),
              },
            ]}
            actions={(r) =>
              r.effectiveTo || !r.isActive || !canManage ? null : (
                <Button variant="quiet" size="sm" onClick={() => setEndFor(r)}>
                  إنهاء العمل بها
                </Button>
              )
            }
            empty={
              <EmptyState
                title="لا قواعد عمولة بعد"
                why="بلا قاعدةٍ لا تُحتسب عمولةٌ لأحد، مهما سُلِّم من طلبات. أضِف واحدةً من الزرّ أعلاه."
                action={canManage ? { label: 'أضف أول قاعدة', onClick: () => setNewOpen(true) } : undefined}
              />
            }
          />
        )}
      </Card>

      <Card className="overflow-hidden">
        <h2 className="text-sm font-medium text-[var(--sys-heading)] px-4 py-3 border-b border-[var(--sys-border)]">
          عمولات الشهر الحالي ({period()})
        </h2>
        {!totals ? (
          <p className="text-sm text-[var(--sys-muted-foreground)] py-8 text-center">—</p>
        ) : totals.length === 0 ? (
          <p className="text-sm text-[var(--sys-muted-foreground)] py-8 text-center">لا عمولات محتسبة هذا الشهر.</p>
        ) : (
          <Rows
            rows={totals}
            keyOf={(t) => t.userId}
            columns={[
              { key: 'who', label: 'الموظف', primary: true, render: (t) => t.name },
              {
                key: 'accrued',
                label: 'محتسبة',
                primary: true,
                align: 'end',
                render: (t) => <Money value={t.accrued} currency={currency} />,
              },
              {
                key: 'payable',
                label: 'مستحقة',
                align: 'end',
                render: (t) => <Money value={t.payable} currency={currency} tone="owed" />,
              },
              {
                key: 'paid',
                label: 'مدفوعة',
                align: 'end',
                render: (t) => <Money value={t.paid} currency={currency} tone="collected" />,
              },
              {
                key: 'reversed',
                label: 'معكوسة',
                align: 'end',
                render: (t) => <Money value={t.reversed} currency={currency} tone="lost" />,
              },
            ]}
            actions={(t) =>
              // An entry used to reach «مستحقة» and stop: nothing turned it
              // into money, so the cash left by hand.
              t.payable > 0 && canPay ? (
                <Button variant="secondary" size="sm" onClick={() => setPaying({ id: t.userId, name: t.name })}>
                  صرف
                </Button>
              ) : null
            }
            empty={
              <EmptyState
                title="لا عمولات محتسبة هذا الشهر"
                why="العمولة تُحتسب على التسليم. فراغُ القائمة يعني أنّ لا طلبَ سُلِّم هذا الشهر — أو أنّ لا قاعدةَ عمولةٍ سارية."
              />
            }
          />
        )}
      </Card>

      {/* «حاسبة عمولة الموظفات (تقدير)» — moved here from «إعدادات النظام» (the owner, 17/11): everything about commission in one place. It is an ESTIMATE for the
          performance score; the real commission is the rules and the entries above. The card says so itself, and draws nothing for who cannot read the settings. */}
      <AgentCommissionCard />

      {paying && (
        <PayoutDialog
          userId={paying.id}
          userName={paying.name}
          onClose={() => setPaying(null)}
          onPaid={() => { setPaying(null); void load(); }}
        />
      )}

      {newOpen && (
        <NewRuleDialog
          onClose={() => setNewOpen(false)}
          onSaved={async () => {
            setNewOpen(false);
            setDone('أُضيفت القاعدة');
            await load();
          }}
        />
      )}

      {endFor && (
        <EndRuleDialog
          rule={endFor}
          onClose={() => setEndFor(null)}
          onSaved={async () => {
            setEndFor(null);
            setDone('أُنهي العمل بالقاعدة — ما احتُسب سابقاً باقٍ كما هو');
            await load();
          }}
        />
      )}
    </PageShell>
  );
}

/**
 * Writing a rule.
 *
 * The three questions in order: WHAT is counted, over WHAT SPAN, and HOW
 * MUCH it pays. The span follows from the metric — a day's count cannot be
 * answered by one order, and a per-order rule has no day to add up — so the
 * screen sets it rather than letting the two disagree and be refused.
 */
function NewRuleDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  // A band is five boxes in a row on a desk (about 650px); in a dialog 277px wide it scrolled sideways and put the
  // name and the × off-screen. On a phone each band is a small card: three labelled numbers, then the name and the ×.
  const phone = useIsPhone();
  const [name, setName] = useState('');
  const [role, setRole] = useState('MODERATOR');
  /** One named person instead of a whole role — their rule beats the role's. */
  const [userId, setUserId] = useState('');
  const [people, setPeople] = useState<{ id: string; name: string; role: string }[]>([]);
  const [metric, setMetric] = useState<CommissionMetric>('ORDER_DELIVERED');
  const [period, setPeriod] = useState<CommissionPeriod>('DAILY');
  const [type, setType] = useState<CommissionType>('PERCENT');
  const [value, setValue] = useState('');
  const [shape, setShape] = useState<'single' | 'tiers' | 'target'>('single');
  const [tiers, setTiers] = useState<TierDraft[]>([{ from: '0', to: '', value: '', label: '' }]);
  const [goal, setGoal] = useState('');
  const [bonus, setBonus] = useState('');
  const banded = shape !== 'single';
  const [minOrders, setMinOrders] = useState('');
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const perOrder = metric === 'ORDER_DELIVERED';

  // The people who could earn under this rule, so a rule for one person is
  // picked by name rather than by pasting an id.
  useEffect(() => {
    apiJson<{ users: { id: string; name: string; role: string }[] }>(`/api/users?role=${role}`)
      .then((d) => setPeople(d.users ?? []))
      .catch(() => setPeople([]));
    setUserId('');
  }, [role]);
  const isRate = metric === 'DELIVERY_RATE';

  /** A target is one band opening at the goal, paid once. */
  function pickShape(next: 'single' | 'tiers' | 'target') {
    setShape(next);
    if (next === 'target') setType('FIXED');
  }

  /** The metric decides the span: the two may never disagree. */
  function pickMetric(next: CommissionMetric) {
    setMetric(next);
    if (next === 'ORDER_DELIVERED') setPeriod('PER_ORDER');
    else if (period === 'PER_ORDER') setPeriod('DAILY');
    // A rate has no per-order meaning either — it is a span's figure.
    if (next === 'DELIVERY_RATE' && type === 'PERCENT') setType('PER_ORDER');
    /*
     * THE CONTRACT'S FLOOR, SHOWN RATHER THAN APPLIED BEHIND THEIR BACK.
     *
     * «Delivery-rate tiers with a minimum sample of 30 orders.» The save door
     * puts 30 on a rate rule left blank, because no floor at all means «100%
     * out of two» clears every band. Filling the box here means the person
     * SEES the number they are agreeing to, and can change it, instead of
     * discovering it on the next reload.
     */
    if (next === 'DELIVERY_RATE' && minOrders === '') setMinOrders('30');
  }

  const parsedTiers = () =>
    shape === 'target'
      ? goal !== '' && bonus !== ''
        ? [{ from: Number(goal), to: null, value: Number(bonus) }]
        : []
      : tiers
      .filter((t) => t.from !== '' && t.value !== '')
      .map((t) => ({
        from: Number(t.from),
        to: t.to === '' ? null : Number(t.to),
        value: Number(t.value),
        ...(t.label.trim() ? { label: t.label.trim() } : {}),
      }));

  return (
    <Modal isOpen onClose={onClose} title="قاعدة عمولة جديدة">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);

          const rows = banded ? parsedTiers() : [];
          if (banded) {
            // Checked here too, so the seller is told which band is wrong
            // before the request — the server refuses it either way.
            const problem = tiersProblem(rows);
            if (problem) { setError(problem); return; }
          }

          setSaving(true);
          try {
            await apiJson('/api/settings/commission', {
              method: 'POST',
              body: JSON.stringify({
                name: name.trim(),
                // A named person, or everyone in the role.
                appliesToRole: userId ? null : role,
                appliesToUserId: userId || null,
                metric,
                period: perOrder ? 'PER_ORDER' : period,
                type,
                value: banded ? 0 : Number(value),
                tiers: banded ? rows : null,
                minOrders: minOrders === '' ? null : Number(minOrders),
                effectiveFrom: from,
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
        <label className="block">
          <span className="block text-note font-medium text-[var(--sys-foreground)] mb-1">اسم القاعدة</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            minLength={2}
            placeholder="شرائح التأكيد اليومي 2026"
            className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label>
            <span className="block text-note font-medium text-[var(--sys-foreground)] mb-1">تنطبق على دور</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm bg-[var(--sys-card)]"
            >
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="block text-note font-medium text-[var(--sys-foreground)] mb-1">أو موظف بعينه</span>
            <select
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              disabled={people.length === 0}
              className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm bg-[var(--sys-card)] disabled:bg-[var(--sys-surface)]"
            >
              <option value="">كل من في هذا الدور</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          {userId && (
            <p className="col-span-2 -mt-1 text-note text-[var(--sys-muted-foreground)]">
              قاعدة باسم موظف تتجاوز قاعدة دوره.
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label>
            <span className="block text-note font-medium text-[var(--sys-foreground)] mb-1">تُحتسب على</span>
            <select
              value={metric}
              onChange={(e) => pickMetric(e.target.value as CommissionMetric)}
              className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm bg-[var(--sys-card)]"
            >
              {COMMISSION_METRICS.map((m) => (
                <option key={m} value={m}>{METRIC_LABEL_AR[m]}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="block text-note font-medium text-[var(--sys-foreground)] mb-1">الفترة</span>
            <select
              value={perOrder ? 'PER_ORDER' : period}
              disabled={perOrder}
              onChange={(e) => setPeriod(e.target.value as CommissionPeriod)}
              className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm bg-[var(--sys-card)] disabled:bg-[var(--sys-surface)] disabled:text-[var(--sys-muted)]"
            >
              {(perOrder ? (['PER_ORDER'] as const) : (['DAILY', 'WEEKLY', 'MONTHLY'] as const)).map((p) => (
                <option key={p} value={p}>{PERIOD_LABEL_AR[p]}</option>
              ))}
            </select>
          </label>
        </div>

        <p className="rounded-lg bg-[var(--sys-surface)] px-2.5 py-2 text-note leading-relaxed text-[var(--sys-muted-foreground)]">
          {perOrder
            ? 'تُحتسب مع كل طلب مسلَّم، لحظة تسليمه.'
            : `تُحتسب بعد انتهاء ${PERIOD_LABEL_AR[period]} — لأن العدد لا يُعرف قبل أن ينتهي.`}
        </p>

        {/* A target is not a fourth kind of rule — it is a rule with one
            band opening at the goal. Offered as its own shape because that
            is how a seller thinks of it, and because it pays BESIDE the
            tiers rather than instead of them. */}
        {/* 18/11 (R13h): three raw buttons were a compact choice of one; the kit's `Segmented` is that choice. Its options are
            `type="button"` (this sits inside the form) and the same rule turns the two banded shapes off for a per-order rule. */}
        <Segmented
          aria-label="شكل القاعدة"
          size="sm"
          className="w-full"
          value={shape}
          onChange={(next) => pickShape(next as 'single' | 'tiers' | 'target')}
          options={([
            ['single', 'قيمة واحدة'],
            ['tiers', 'شرائح'],
            ['target', 'هدف ومكافأة'],
          ] as const).map(([value, label]) => ({
            value,
            label,
            disabled: value !== 'single' && perOrder,
          }))}
        />

        {!banded ? (
          <div className="grid grid-cols-2 gap-3">
            <label>
              <span className="block text-note font-medium text-[var(--sys-foreground)] mb-1">النوع</span>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as CommissionType)}
                className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm bg-[var(--sys-card)]"
              >
                {COMMISSION_TYPES.map((t) => (
                  <option key={t} value={t}>{TYPE_LABEL_AR[t]}</option>
                ))}
              </select>
            </label>
            <label>
              <span className="block text-note font-medium text-[var(--sys-foreground)] mb-1">
                {type === 'PERCENT' ? 'النسبة %' : 'المبلغ'}
              </span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                required
                className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
                dir="ltr"
              />
            </label>
          </div>
        ) : shape === 'target' ? (
          <div className="grid grid-cols-2 gap-3">
            <label>
              <span className="block text-note font-medium text-[var(--sys-foreground)] mb-1">
                الهدف {isRate ? '(نسبة %)' : '(عدد)'}
              </span>
              <input
                type="number"
                min="0"
                max={isRate ? 100 : undefined}
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                required
                placeholder={isRate ? '70' : '150'}
                className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
                dir="ltr"
              />
            </label>
            <label>
              <span className="block text-note font-medium text-[var(--sys-foreground)] mb-1">المكافأة</span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={bonus}
                onChange={(e) => setBonus(e.target.value)}
                required
                className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
                dir="ltr"
              />
            </label>
            <p className="col-span-2 rounded-lg bg-[var(--sys-surface)] px-2.5 py-2 text-note leading-relaxed text-[var(--sys-muted-foreground)]">
              مكافأة واحدة عند بلوغ الهدف، مهما زاد العدد عليه — وتُدفع فوق أي قاعدة شرائح أخرى، لا بدلاً
              منها.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <label className="block">
              <span className="block text-note font-medium text-[var(--sys-foreground)] mb-1">كيف تدفع الشريحة</span>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as CommissionType)}
                className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm bg-[var(--sys-card)]"
              >
                {COMMISSION_TYPES.map((t) => (
                  <option key={t} value={t}>{TYPE_LABEL_AR[t]}</option>
                ))}
              </select>
            </label>

            <div className="rounded-lg border border-[var(--sys-border)] p-2 space-y-2">
              {phone ? (
                <p className="text-note text-[var(--sys-muted-foreground)]">«إلى» فارغة = فما فوق.</p>
              ) : (
                <div className="grid grid-cols-[1fr_1fr_1fr_1.2fr_auto] gap-1.5 text-note font-medium text-[var(--sys-muted-foreground)]">
                  <span>من {isRate ? '%' : ''}</span>
                  <span>إلى (فارغ = فما فوق)</span>
                  <span>القيمة</span>
                  <span>اسم الشريحة</span>
                  <span> </span>
                </div>
              )}
              {tiers.map((t, i) => phone ? (
                <div key={i} className="space-y-1.5 rounded-lg border border-[var(--sys-border)] p-2">
                  <div className="grid grid-cols-3 gap-1.5">
                    {(['from', 'to', 'value'] as const).map((field) => (
                      <label key={field} className="block min-w-0">
                        <span className="mb-0.5 block text-note font-medium text-[var(--sys-muted-foreground)]">
                          {field === 'from' ? `من ${isRate ? '%' : ''}` : field === 'to' ? 'إلى' : 'القيمة'}
                        </span>
                        <input
                          type="number"
                          step={field === 'value' ? '0.01' : '1'}
                          min="0"
                          max={isRate && field !== 'value' ? 100 : undefined}
                          value={t[field]}
                          onChange={(e) =>
                            setTiers(tiers.map((row, j) => (j === i ? { ...row, [field]: e.target.value } : row)))
                          }
                          className="h-11 w-full min-w-0 px-2 rounded-lg border border-[var(--sys-border-input)] text-sm"
                          dir="ltr"
                        />
                      </label>
                    ))}
                  </div>
                  <div className="flex gap-1.5">
                    <input
                      value={t.label}
                      onChange={(e) => setTiers(tiers.map((row, j) => (j === i ? { ...row, label: e.target.value } : row)))}
                      placeholder="اسم الشريحة (اختياري)"
                      aria-label="اسم الشريحة"
                      className="h-11 min-w-0 flex-1 px-2 rounded-lg border border-[var(--sys-border-input)] text-sm"
                    />
                    <IconButton
                      type="button"
                      size="sm"
                      onClick={() => setTiers(tiers.filter((_, j) => j !== i))}
                      disabled={tiers.length === 1}
                      label="حذف الشريحة"
                    >
                      ×
                    </IconButton>
                  </div>
                </div>
              ) : (
                <div key={i} className="grid grid-cols-[1fr_1fr_1fr_1.2fr_auto] gap-1.5">
                  {(['from', 'to', 'value'] as const).map((field) => (
                    <input
                      key={field}
                      type="number"
                      step={field === 'value' ? '0.01' : '1'}
                      min="0"
                      max={isRate && field !== 'value' ? 100 : undefined}
                      value={t[field]}
                      onChange={(e) =>
                        setTiers(tiers.map((row, j) => (j === i ? { ...row, [field]: e.target.value } : row)))
                      }
                      className="h-11 md:h-10 px-2 rounded-lg border border-[var(--sys-border-input)] text-sm"
                      dir="ltr"
                    />
                  ))}
                  <input
                    value={t.label}
                    onChange={(e) => setTiers(tiers.map((row, j) => (j === i ? { ...row, label: e.target.value } : row)))}
                    placeholder="اختياري"
                    className="h-11 md:h-10 px-2 rounded-lg border border-[var(--sys-border-input)] text-sm"
                  />
                  <IconButton
                    type="button"
                    size="sm"
                    onClick={() => setTiers(tiers.filter((_, j) => j !== i))}
                    disabled={tiers.length === 1}
                    label="حذف الشريحة"
                  >
                    ×
                  </IconButton>
                </div>
              ))}
              <Button
                type="button"
                variant={phone ? 'secondary' : 'quiet'}
                size="sm"
                onClick={() => setTiers([...tiers, { from: '', to: '', value: '', label: '' }])}
                className={phone ? 'w-full' : undefined}
              >
                + شريحة
              </Button>
            </div>
          </div>
        )}

        {!perOrder && (
          <label className="block">
            <span className="block text-note font-medium text-[var(--sys-foreground)] mb-1">
              أقل عدد طلبات قبل الاحتساب (اختياري)
            </span>
            <input
              type="number"
              min="0"
              value={minOrders}
              onChange={(e) => setMinOrders(e.target.value)}
              placeholder="مثلاً 30"
              className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
              dir="ltr"
            />
            <span className="mt-1 block text-note text-[var(--sys-muted)]">
              {isRate
                ? 'نسبة تسليم 100٪ من طلبين ليست أداءً — يُقاس الحد على عدد الطلبات لا على النسبة.'
                : 'أقل من هذا العدد لا تستحق القاعدة شيئاً.'}
            </span>
          </label>
        )}

        <label className="block">
          <span className="block text-note font-medium text-[var(--sys-foreground)] mb-1">سارية من</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            required
            className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
            dir="ltr"
          />
        </label>

        {error && <p className="text-sm text-[var(--sys-destructive)]">{error}</p>}

        <div className="flex gap-2 justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>
            إلغاء
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? 'جارٍ الحفظ…' : 'حفظ'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function EndRuleDialog({ rule, onClose, onSaved }: { rule: Rule; onClose: () => void; onSaved: () => void }) {
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  return (
    <Modal isOpen onClose={onClose} title={`إنهاء العمل بـ «${rule.name}»`}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError(null);
          try {
            await apiJson('/api/settings/commission', {
              method: 'PATCH',
              body: JSON.stringify({ ruleId: rule.id, effectiveTo: to }),
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
        <Card plain padding="sm">
          <p className="text-sm text-[var(--sys-foreground)]">
          الطلبات المسلَّمة حتى هذا التاريخ تبقى محسوبة بهذه القاعدة. لما بعده اكتب قاعدة جديدة.
          </p>
        </Card>
        <label className="block">
          <span className="block text-note font-medium text-[var(--sys-foreground)] mb-1">آخر يوم تسري فيه</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            required
            className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
            dir="ltr"
          />
        </label>
        {error && <p className="text-sm text-[var(--sys-destructive)]">{error}</p>}
        <div className="flex gap-2 justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>
            إلغاء
          </Button>
          <Button type="submit" disabled={saving}>
            إنهاء
          </Button>
        </div>
      </form>
    </Modal>
  );
}
