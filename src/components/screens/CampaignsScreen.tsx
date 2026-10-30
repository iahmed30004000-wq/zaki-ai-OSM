'use client';

import { plainNumber } from '@/lib/format';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { apiJson } from '@/lib/api-client';
import { useConfirm } from '@/components/ui/Confirm';
import { CAMPAIGN_PLATFORMS, CAMPAIGN_STATUSES } from '@/lib/campaigns';
import { RiAddCircleLine, RiArrowDownCircleLine, RiArrowUpCircleLine, RiCheckLine, RiCloseLine, RiDeleteBinLine, RiDownloadLine, RiLinksLine, RiLoader4Line, RiMegaphoneLine, RiPencilLine, RiPlugLine, RiRefreshLine } from '@remixicon/react';
import { PageHeader } from '@/components/ui/PageHeader';
import { AdvancedGroup } from '@/components/ui/AdvancedGroup';
import { useToast } from '@/components/ui/Toast';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useCreateIntent } from '@/hooks/useCreateIntent';
import { isManualAccount } from '@/lib/ads/manual';
import { DateRange, type Range } from '@/components/ui/DateRange';
import { CampaignsBoard, type BoardInsights } from '@/components/growth/CampaignsBoard';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';

/**
 * WHAT EACH AD COST, AND WHAT IT BROUGHT BACK.
 *
 * The spend is the one number the seller types. Everything beside it —
 * orders, confirmations, deliveries, money collected — is measured from
 * this system's own records, through the same engine the moderator and
 * channel reports use. So "revenue" means the same thing here as on the
 * profit screen, which is the only way two screens can be trusted about
 * one week.
 *
 * The column that decides things is ROAS, and it is coloured rather than
 * merely printed: a seller scanning nine campaigns at midnight should see
 * which one to switch off without reading a single number.
 *
 * `net` is revenue minus ad spend and nothing else — not profit. The goods
 * cost money too, and that sum belongs on the profit screen where the cost
 * of delivery and commission are also known. Printing it as profit here
 * would have somebody reading a figure too high by everything they sold.
 */

interface Money {
  spend: number; revenue: number; net: number;
  roas: number | null; costPerDelivered: number | null; costPerOrder: number | null;
}
interface Funnel {
  brought: number; confirmed: number; rejected: number; delivered: number; returned: number;
  confirmationRate: number | null; deliveryRate: number | null;
}
interface AdAccount { id: string; platform: string; accountId: string; accountName: string | null; status: string }
interface Campaign {
  id: string; name: string; platform: string; code: string; status: string;
  spendSource: 'MANUAL' | 'SYNCED';
  adAccount: { id: string; accountName: string | null; accountId: string; status: string } | null;
  externalId: string | null;
  lastSyncAt: string | null;
  startDate: string; endDate: string | null; notes: string | null;
  landingPage: { id?: string; name?: string; slug?: string } | null;
  /**
   * THE ANSWER, worked out by the server.
   *
   * `product` is what this campaign ADVERTISES — the linked page's product
   * when there is a page, the row's own otherwise. `productId` is what the
   * ROW stores, which the form needs in order to offer it back. They differ
   * exactly when a page is linked, and that difference is the whole shape
   * of the rule: see `campaignProductId`.
   *
   * The browser is handed the answer rather than the two sources, because a
   * second copy of the precedence here is a screen that prints a different
   * product from the export beside it.
   */
  product: { id: string; name: string } | null;
  productId: string | null;
  link: string; ranInWindow: boolean; funnel: Funnel; money: Money;
  /** Where the seller dragged it; and, for a hand-typed campaign, the platform twin it duplicates. */
  sortOrder?: number;
  duplicateOf?: string | null;
}
interface Payload {
  campaigns: Campaign[];
  totals: Money & { brought: number; delivered: number };
  currency: string;
  adAccounts: AdAccount[];
  definitions: Record<string, string>;
  /** ABSENT without `insights.view` (the cards are a verdict, PR-10). */
  insights?: BoardInsights;
  /** How many hand-typed campaigns have a platform twin — sent to everybody, it is what «احذف المكرر» works on. */
  duplicatesCount?: number;
}

/**
 * The server's own period keys (`campaign-window.ts`). The old ones — `this_month`, `last_30` — were unknown to it
 * and both silently became the last 90 days; «كل الوقت» was capped at 90 days too.
 */
const PERIODS = [
  { key: 'today', label: 'اليوم' },
  { key: 'yesterday', label: 'أمس' },
  { key: '7d', label: '7 أيام' },
  { key: '30d', label: '30 يوماً' },
  { key: 'month', label: 'هذا الشهر' },
  { key: 'last_month', label: 'الشهر الماضي' },
  { key: 'all', label: 'كل الوقت' },
] as const;

const platformLabel = (k: string) => CAMPAIGN_PLATFORMS.find((p) => p.key === k)?.label ?? k;
const statusLabel = (k: string) => CAMPAIGN_STATUSES.find((s) => s.key === k)?.label ?? k;
const fmt = (n: number | null) =>
  n === null ? '—' : plainNumber(n, 2);

export function CampaignsScreen() {
  const { currentUser } = useApp();
  // The screen opens on «عرض الحملات» (PR-11). Every press below that writes — a new campaign, an edit, a delete, the order,
  // the merge, the two pulls from the platforms — is «إدارة الحملات»; a control is drawn only for the key its door asks, so
  // nobody is offered a press that ends in a refusal.
  const mayManage = userCan(currentUser, 'campaigns.manage');
  const toast = useToast();
  const [data, setData] = useState<Payload | null>(null);
  const [period, setPeriod] = useState<string>('month');
  // A picked range wins over the period buttons; a period button clears it.
  const [range, setRange] = useState<Range>({ from: '', to: '' });
  const windowQuery = range.from && range.to ? `startDate=${range.from}&endDate=${range.to}` : `period=${period}`;
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [creating, setCreating] = useState(false);
  // «+ أنشئ» in Ctrl+K arrives as `?new=campaign` and opens the form «حملة جديدة» opens.
  useCreateIntent({ campaign: () => { if (mayManage) setCreating(true); } });
  const [copied, setCopied] = useState<string | null>(null);
  const [pages, setPages] = useState<{ id: string; name: string }[]>([]);
  const [products, setProducts] = useState<{ id: string; name: string }[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [linking, setLinking] = useState<Campaign | null>(null);
  /** Accounts that have a platform behind them, and the ones that are just a name. */
  const connectedAccounts = (data?.adAccounts ?? []).filter((a) => !isManualAccount(a));
  const manualAccounts = (data?.adAccounts ?? []).filter(isManualAccount);
  const confirm = useConfirm();

  /**
   * Pull what was spent, for every campaign linked to an ad account.
   *
   * Only linked ones. A campaign whose spend the seller typed keeps its
   * typed number — a figure a person entered changing overnight, with no
   * explanation, is worse than a figure that was never automatic.
   */
  async function sync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch('/api/growth/campaigns/sync', { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'تعذر السحب');
      await load();
      const failed = (json.accounts || []).filter((a: { error: string | null }) => a.error);
      setSyncMsg(
        failed.length
          ? failed.map((a: { account: string; error: string }) => `${a.account}: ${a.error}`).join(' · ')
          : json.message || `حُدِّثت ${json.updated} حملة.`
      );
    } catch (e) {
      setSyncMsg(e instanceof Error ? e.message : 'تعذر السحب');
    } finally {
      setSyncing(false);
    }
  }

  /**
   * PULLING THE CAMPAIGNS THEMSELVES — «يسحب منو الداتا تبع الحملات».
   *
   * Separate from «اسحب الإنفاق» beside it because they do different
   * things: that one updates figures on rows that exist, this one brings
   * rows that do not. One button doing both would mean a seller who wanted
   * today's spend also got nine archived campaigns they had deliberately
   * not typed in.
   *
   * The message names what arrived rather than counting it. «أُضيفت ٣
   * حملات» cannot be checked by anybody; the names can.
   */
  async function importCampaigns() {
    setImporting(true);
    setSyncMsg(null);
    try {
      const json = await apiJson<{
        created: number;
        message?: string;
        accounts: { account: string; created: { name: string }[]; existing: number; skipped: number; error: string | null }[];
      }>('/api/growth/campaigns/import', { method: 'POST' });
      await load();

      const failed = json.accounts.filter((a) => a.error);
      if (failed.length) {
        setSyncMsg(failed.map((a) => `${a.account}: ${a.error}`).join(' · '));
      } else if (json.created === 0) {
        // «Nothing new» is a real and common answer — said out loud, with
        // what was looked at, so it does not read as a failure.
        const seen = json.accounts.reduce((n, a) => n + a.existing, 0);
        const skipped = json.accounts.reduce((n, a) => n + a.skipped, 0);
        setSyncMsg(
          json.message ??
            `لا حملات جديدة — ${seen} موجودة أصلاً${skipped ? ` و${skipped} منتهية أو محذوفة تُرِكت` : ''}.`
        );
      } else {
        const names = json.accounts.flatMap((a) => a.created.map((c) => c.name));
        setSyncMsg(
          `أُضيفت ${json.created}: ${names.slice(0, 4).join(' · ')}${names.length > 4 ? ' …' : ''} — حدِّد منتج كل حملة.`
        );
      }
    } catch (e) {
      setSyncMsg(e instanceof Error ? e.message : 'تعذر السحب');
    } finally {
      setImporting(false);
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/growth/campaigns?${windowQuery}`);
      setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [windowQuery]);

  useLiveRefresh(load, { key: windowQuery });
  useEffect(() => {
    void fetch('/api/landing-pages')
      .then((r) => r.json())
      .then((j) => setPages((j.pages || j.landingPages || []).map((p: { id: string; name: string }) => ({ id: p.id, name: p.name }))))
      .catch(() => setPages([]));
  }, []);

  /*
   * THE PRODUCTS A CAMPAIGN MAY NAME — «اقدر احدد كل حملة لاي منتج».
   *
   * Only needed for a campaign with no landing page, which is the one case
   * the product cannot be derived for. Loaded anyway and unconditionally,
   * because a dropdown that populates when you pick «واجهة المتجر» is a
   * dropdown that is empty the first time somebody looks for it.
   */
  useEffect(() => {
    // `apiJson`, not a bare `fetch`: the ratchet in `bare-fetch-ratchet`
    // only lets that debt go DOWN, and the helper is what carries the
    // store context and turns a refusal into an Arabic sentence.
    void apiJson<{ products: { id: string; name: string }[] }>('/api/products?pageSize=200')
      .then((j) => setProducts((j.products ?? []).map((x) => ({ id: x.id, name: x.name }))))
      .catch(() => setProducts([]));
  }, []);

  async function copy(link: string, id: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(id);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      /* a browser that refuses the clipboard still shows the link below */
    }
  }

  async function remove(c: Campaign) {
    const hasOrders = c.funnel.brought > 0;
    const ok = await confirm({
      title: hasOrders ? `إنهاء «${c.name}»؟` : `حذف «${c.name}»؟`,
      body: hasOrders
        ? `جاءت بـ${c.funnel.brought} طلباً. ستُنهى بدل أن تُحذف، حتى تبقى تلك الطلبات تعرف من أين جاءت.`
        : 'لم تأتِ بأي طلب بعد، فلا شيء يفقد ذاكرته بحذفها.',
      confirmLabel: hasOrders ? 'أنهِ الحملة' : 'احذف',
      cancelLabel: 'إلغاء',
      tone: 'danger',
    });
    if (!ok) return;
    await fetch(`/api/growth/campaigns/${c.id}`, { method: 'DELETE' });
    await load();
  }

  /** The order the seller dragged them into — the whole list, saved for everyone who sees this screen. */
  async function reorder(ids: string[]) {
    try {
      await apiJson('/api/growth/campaigns/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذّر حفظ الترتيب');
      await load();
    }
  }

  /** «حذف الكل» / «احذف المحدد» — by the single delete's rule: a campaign with orders is ended, not deleted. */
  async function bulkDelete(ids: string[]) {
    const chosen = (data?.campaigns ?? []).filter((c) => ids.includes(c.id));
    const withOrders = chosen.filter((c) => c.funnel.brought > 0).length;
    const ok = await confirm({
      title: `حذف ${chosen.length} حملة؟`,
      body: withOrders
        ? `${withOrders} منها جابت طلبات — رح تنتهي بدل ما تنحذف، حتى تضل طلباتها تعرف من وين إجت. الباقي (${chosen.length - withOrders}) بينحذف.`
        : 'ولا وحدة منها جابت طلب، فبتنحذف كلها.',
      confirmLabel: 'احذف',
      cancelLabel: 'إلغاء',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      const r = await apiJson<{ deleted: number; ended: number }>('/api/growth/campaigns/bulk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', ids }),
      });
      setSyncMsg(`انحذفت ${r.deleted} حملة${r.ended ? `، وانتهت ${r.ended} لأنها جابت طلبات` : ''}.`);
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذّر الحذف');
    }
    await load();
  }

  /** «حذف المكرر» — the hand-typed copy's orders move to the platform twin, then the copy is removed. */
  async function merge(ids?: string[]) {
    const count = ids?.length ?? data?.duplicatesCount ?? data?.insights?.duplicates ?? 0;
    const ok = await confirm({
      title: `دمج ${count} حملة مكررة؟`,
      body: 'كل حملة مدخّلة باليد إلها نسخة بنفس الاسم سحبها النظام من المنصة: طلباتها بتنتقل للنسخة اللي فيها الإنفاق، وبعدين النسخة اليدوية بتنحذف. ما في طلب بيضيع.',
      confirmLabel: 'ادمج واحذف المكرر',
      cancelLabel: 'إلغاء',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      const r = await apiJson<{ merged: number; ordersMoved: number }>('/api/growth/campaigns/duplicates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ids ? { ids } : {}),
      });
      setSyncMsg(`اندمجت ${r.merged} حملة مكررة، وانتقل ${r.ordersMoved} طلب للنسخة الصحيحة.`);
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذّر الدمج');
    }
    await load();
  }

  const totals = data?.totals;
  const currency = data?.currency ?? '';

  return (
    <div className="space-y-4" dir="rtl">
      <PageHeader title="الحملات"
          description="تكتب ما أنفقت، والباقي محسوب من طلباتك الفعلية."
          actions={
            <><div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-[var(--sys-border)] p-0.5">
            {PERIODS.map((p) => (
              <button
                key={p.key}
                onClick={() => { setPeriod(p.key); setRange({ from: '', to: '' }); }}
                className={`min-h-11 md:min-h-0 inline-flex items-center rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                  !range.from && period === p.key ? 'bg-[var(--sys-primary-soft)] text-[var(--sys-primary)]' : 'text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-surface)]'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <DateRange value={range} onChange={setRange} label="من — إلى" />
          {/* Only an account with a platform on the other end can be pulled
              from. A manual account is a place to put campaigns, and offering
              «اسحب الإنفاق» because one exists would call nobody. */}
          {mayManage && connectedAccounts.length > 0 && (
            <>
              {/* Two buttons, not one. «اسحب الحملات» brings rows that do
                  not exist; «اسحب الإنفاق» updates figures on rows that do.
                  One button doing both would mean a seller who wanted
                  today's spend also got nine archived campaigns. */}
              <AdvancedGroup holds="اسحب الحملات · اسحب الإنفاق">
              <Button size="sm" variant="outline" onClick={() => void importCampaigns()} disabled={importing}>
                {importing ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiDownloadLine className="h-4 w-4" />}
                اسحب الحملات
              </Button>
              <Button size="sm" variant="outline" onClick={sync} disabled={syncing}>
                {syncing ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiRefreshLine className="h-4 w-4" />}
                اسحب الإنفاق
              </Button>
              </AdvancedGroup>
            </>
          )}
          {mayManage && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <RiAddCircleLine className="h-4 w-4" /> حملة جديدة
          </Button>
          )}
        </div></>
          }
        />

      {syncMsg && (
        <p className="rounded-lg bg-[var(--sys-surface)] px-3 py-2 text-xs text-[var(--sys-foreground)]">{syncMsg}</p>
      )}

      {/* The shop's whole picture, so nobody adds the column up by hand. */}
      {totals && (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
          <Stat label="أُنفق" value={`${fmt(totals.spend)} ${currency}`} />
          <Stat label="عاد" value={`${fmt(totals.revenue)} ${currency}`} />
          <Stat
            label="الفرق"
            value={`${fmt(totals.net)} ${currency}`}
            tone={totals.net >= 0 ? 'good' : 'bad'}
            hint="قبل كلفة البضاعة والتوصيل"
          />
          <Stat label="العائد على الإنفاق" value={totals.roas === null ? '—' : `${fmt(totals.roas)}×`} tone={roasTone(totals.roas)} />
          <Stat label="طلبات · وصلت" value={`${totals.brought} · ${totals.delivered}`} />
        </div>
      )}

      {loading && !data ? (
        <div className="flex h-40 items-center justify-center text-sm text-[var(--sys-muted-foreground)]">
          <RiLoader4Line className="h-4 w-4 animate-spin" />
        </div>
      ) : data && data.campaigns.length === 0 ? (
        <Empty onCreate={mayManage ? () => setCreating(true) : undefined} />
      ) : (
        <CampaignsBoard
          mayManage={mayManage}
          campaigns={data?.campaigns ?? []}
          insights={data?.insights ?? null}
          duplicates={data?.duplicatesCount ?? data?.insights?.duplicates ?? 0}
          currency={currency}
          statuses={CAMPAIGN_STATUSES}
          platforms={CAMPAIGN_PLATFORMS}
          accounts={data?.adAccounts ?? []}
          onReorder={reorder}
          onBulkDelete={bulkDelete}
          onMerge={merge}
          renderCard={(c) => (
            <Row
              c={c}
              currency={currency}
              copied={copied === c.id}
              onCopy={() => copy(c.link, c.id)}
              onEdit={mayManage ? () => setEditing(c) : undefined}
              onRemove={mayManage ? () => remove(c) : undefined}
              onLink={mayManage && connectedAccounts.length > 0 ? () => setLinking(c) : undefined}
            />
          )}
        />
      )}

      {data && (
        <p className="text-xs leading-relaxed text-[var(--sys-muted)]">
          «الفرق» هو الإيراد ناقص الإنفاق الإعلاني فقط — ليس الربح: كلفة البضاعة والتوصيل والعمولة
          محسوبة في شاشة الأرباح. و«الإيراد» هو المحصَّل فعلاً حيث نعرفه وإجمالي الطلب حيث لا نعرفه،
          نفس التعريف في كل الشاشات.
        </p>
      )}

      {linking && data && (
        <LinkDialog
          campaign={linking}
          accounts={connectedAccounts}
          onClose={() => setLinking(null)}
          onSaved={async () => { setLinking(null); await load(); }}
        />
      )}

      {(creating || editing) && (
        <Editor
          campaign={editing}
          pages={pages}
          products={products}
          manualAccounts={manualAccounts}
          currency={currency}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={async (note) => { setCreating(false); setEditing(null); await load(); if (note) setSyncMsg(note); }}
        />
      )}
    </div>
  );
}

/** Green above 2×, amber from 1 to 2, red below — losing money. */
function roasTone(roas: number | null): 'good' | 'warn' | 'bad' | undefined {
  if (roas === null) return undefined;
  if (roas >= 2) return 'good';
  if (roas >= 1) return 'warn';
  return 'bad';
}

function Stat({ label, value, tone, hint }: { label: string; value: string; tone?: 'good' | 'warn' | 'bad'; hint?: string }) {
  const colour =
    tone === 'good' ? 'text-[var(--sys-success)]' : tone === 'bad' ? 'text-[var(--sys-destructive)]' : tone === 'warn' ? 'text-[var(--sys-warning)]' : 'text-[var(--sys-heading)]';
  return (
    <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-3">
      <p className="text-xs font-semibold text-[var(--sys-muted-foreground)]">{label}</p>
      <p className={`mt-0.5 text-base font-bold tabular-nums ${colour}`} dir="ltr">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-[var(--sys-muted)]">{hint}</p>}
    </div>
  );
}

function Row({
  c, currency, copied, onCopy, onEdit, onRemove, onLink,
}: {
  c: Campaign; currency: string; copied: boolean;
  onCopy: () => void; onEdit?: () => void; onRemove?: () => void; onLink?: () => void;
}) {
  const tone = roasTone(c.money.roas);
  return (
    <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-bold text-[var(--sys-heading)]">{c.name}</span>
            <span className="rounded-lg bg-[var(--sys-surface-strong)] px-1.5 py-0.5 text-xs font-semibold text-[var(--sys-muted-foreground)]">
              {platformLabel(c.platform)}
            </span>
            <span
              className={`rounded-lg px-1.5 py-0.5 text-xs font-semibold ${
                c.status === 'ACTIVE' ? 'bg-[var(--sys-success-soft)] text-[var(--sys-success)]'
                : c.status === 'PAUSED' ? 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)]'
                : 'bg-[var(--sys-surface-strong)] text-[var(--sys-muted-foreground)]'
              }`}
            >
              {statusLabel(c.status)}
            </span>
          </div>
          <p className="mt-1 text-xs text-[var(--sys-muted-foreground)]">
            {c.landingPage?.name ?? 'واجهة المتجر'}
            {c.product ? ` · ${c.product.name}` : ''} · الرمز {c.code}
            {c.adAccount ? ` · الحساب ${c.adAccount.accountName ?? c.adAccount.accountId}` : ''}
          </p>
        </div>

        <div className="flex items-center gap-1">
          {onLink && (
            <button
              onClick={onLink}
              title={c.adAccount ? 'غيّر الربط بميتا' : 'اربطها بحملة في ميتا'}
              className={`min-h-11 md:min-h-0 inline-flex items-center flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-semibold transition ${
                c.spendSource === 'SYNCED'
                  ? 'border-[var(--sys-success-soft)] bg-[var(--sys-success-soft)] text-[var(--sys-success)]'
                  : 'border-[var(--sys-border)] text-[var(--sys-foreground)] hover:border-[var(--sys-primary)] hover:text-[var(--sys-primary)]'
              }`}
            >
              <RiPlugLine className="h-4 w-4" />
              {c.spendSource === 'SYNCED' ? 'تلقائي' : 'اربط'}
            </button>
          )}
          <button
            onClick={onCopy}
            title="انسخ رابط الإعلان"
            className="min-h-11 md:min-h-0 inline-flex items-center flex items-center gap-1 rounded-lg border border-[var(--sys-border)] px-2 py-1 text-xs font-semibold text-[var(--sys-foreground)] hover:border-[var(--sys-primary)] hover:text-[var(--sys-primary)]"
          >
            {copied ? <RiCheckLine className="h-4 w-4 text-[var(--sys-success)]" /> : <RiLinksLine className="h-4 w-4" />}
            {copied ? 'نُسخ' : 'رابط الإعلان'}
          </button>
          {onEdit && (
          <button aria-label="تعديل" onClick={onEdit} title="تعديل" className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 rounded-lg p-1.5 text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-surface)]">
            <RiPencilLine className="h-4 w-4" />
          </button>
          )}
          {onRemove && (
          <button aria-label="حذف" onClick={onRemove} title="حذف" className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 rounded-lg p-1.5 text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-destructive-soft)] hover:text-[var(--sys-destructive)]">
            <RiDeleteBinLine className="h-4 w-4" />
          </button>
          )}
        </div>
      </div>

      <div className="mt-2.5 grid grid-cols-3 gap-2 border-t border-[var(--sys-surface-strong)] pt-2.5 sm:grid-cols-6">
        <Cell
          label={c.spendSource === 'SYNCED' ? 'أُنفق · من ميتا' : 'أُنفق · يدوي'}
          value={`${fmt(c.money.spend)}`}
          unit={currency}
        />
        <Cell label="عاد" value={`${fmt(c.money.revenue)}`} unit={currency} />
        <Cell label="الفرق" value={`${fmt(c.money.net)}`} unit={currency} tone={c.money.net >= 0 ? 'good' : 'bad'} />
        <Cell
          label="العائد"
          value={c.money.roas === null ? '—' : `${fmt(c.money.roas)}×`}
          tone={tone}
          icon={tone === 'good' ? 'up' : tone === 'bad' ? 'down' : undefined}
        />
        <Cell label="كلفة الطلب" value={fmt(c.money.costPerOrder)} unit={currency} />
        <Cell label="كلفة الواصل" value={fmt(c.money.costPerDelivered)} unit={currency} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--sys-muted-foreground)]">
        <span>طلبات <b className="text-[var(--sys-heading)]">{c.funnel.brought}</b></span>
        <span>مؤكدة <b className="text-[var(--sys-heading)]">{c.funnel.confirmed}</b>{c.funnel.confirmationRate !== null && ` (${c.funnel.confirmationRate}%)`}</span>
        <span>وصلت <b className="text-[var(--sys-heading)]">{c.funnel.delivered}</b>{c.funnel.deliveryRate !== null && ` (${c.funnel.deliveryRate}%)`}</span>
        {c.funnel.returned > 0 && <span className="text-[var(--sys-warning)]">مرتجعة {c.funnel.returned}</span>}
        {/* A zero that says why it is zero. */}
        {c.funnel.brought === 0 && !c.ranInWindow && (
          <span className="text-[var(--sys-muted)]">لم تكن تعمل في هذه المدة</span>
        )}
      </div>

      <p className="mt-1.5 truncate font-mono text-xs text-[var(--sys-muted)]" dir="ltr" title={c.link}>
        {c.link}
      </p>
    </div>
  );
}

function Cell({ label, value, unit, tone, icon }: { label: string; value: string; unit?: string; tone?: 'good' | 'warn' | 'bad'; icon?: 'up' | 'down' }) {
  const colour =
    tone === 'good' ? 'text-[var(--sys-success)]' : tone === 'bad' ? 'text-[var(--sys-destructive)]' : tone === 'warn' ? 'text-[var(--sys-warning)]' : 'text-[var(--sys-heading)]';
  return (
    <div>
      <p className="text-xs text-[var(--sys-muted)]">{label}</p>
      <p className={`flex items-center gap-0.5 text-xs font-bold tabular-nums ${colour}`} dir="ltr">
        {icon === 'up' && <RiArrowUpCircleLine className="h-4 w-4" />}
        {icon === 'down' && <RiArrowDownCircleLine className="h-4 w-4" />}
        {value}
        {unit && value !== '—' && <span className="text-xs font-normal text-[var(--sys-muted)]">{unit}</span>}
      </p>
    </div>
  );
}

function Empty({ onCreate }: { onCreate?: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-[var(--sys-border-strong)] p-8 text-center">
      <RiMegaphoneLine className="mx-auto h-6 w-6 text-[var(--sys-border-strong)]" />
      <p className="mt-2 text-sm font-semibold text-[var(--sys-foreground)]">لا حملات بعد</p>
      <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
        أنشئ حملة، انسخ رابطها، والصقه في إعلانك. كل طلب يأتي من ذلك الرابط يُحسب عليها —
        وأنت تكتب ما أنفقت، فترى العائد الحقيقي بدل التخمين.
      </p>
      {onCreate && (
      <Button size="sm" className="mt-3" onClick={onCreate}>
        <RiAddCircleLine className="h-4 w-4" /> حملة جديدة
      </Button>
      )}
    </div>
  );
}

function Editor({
  campaign, pages, products, manualAccounts, currency, onClose, onSaved,
}: {
  campaign: Campaign | null;
  pages: { id: string; name: string }[];
  /** Only reachable when no page is linked — see the field below. */
  products: { id: string; name: string }[];
  /** The seller's hand-kept ad accounts — a campaign may be filed under one. */
  manualAccounts: AdAccount[];
  currency: string;
  onClose: () => void;
  /** `note` is a thing to tell the seller after the editor closes. */
  onSaved: (note?: string) => void;
}) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  // What the editor OPENED with, fixed for its lifetime. It is compared with the
  // form on save to decide whether the campaign was re-filed — computed from the
  // form it would always equal it, and the filing would never be sent.
  const startedWithAccount = campaign?.adAccount && isManualAccount(campaign.adAccount) ? campaign.adAccount.id : '';
  const [form, setForm] = useState({
    name: campaign?.name ?? '',
    platform: campaign?.platform ?? 'META',
    landingPageId: campaign?.landingPage?.id ?? '',
    // The ROW's product, not the derived one: with a page linked the row
    // holds null, and offering the page's product back here would make the
    // form look as though the campaign stores something it does not.
    productId: campaign?.productId ?? '',
    status: campaign?.status ?? 'ACTIVE',
    startDate: campaign?.startDate?.slice(0, 10) ?? today,
    endDate: campaign?.endDate?.slice(0, 10) ?? '',
    spend: String(campaign?.money.spend ?? 0),
    notes: campaign?.notes ?? '',
    // Only a MANUAL account is chosen here. A campaign filed under a connected
    // one is moved with «اربط» in the list, which also picks the remote
    // campaign — a select could not.
    adAccountId: startedWithAccount,
  });
  const filedUnderConnected = !!campaign?.adAccount && !isManualAccount(campaign.adAccount);
  const accountsHere = manualAccounts.filter((a) => a.platform === form.platform);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: form.name,
        platform: form.platform,
        landingPageId: form.landingPageId || null,
        productId: form.productId || null,
        status: form.status,
        startDate: form.startDate,
        endDate: form.endDate || null,
        spend: form.spend,
        notes: form.notes || null,
      };
      const res = await fetch(campaign ? `/api/growth/campaigns/${campaign.id}` : '/api/growth/campaigns', {
        method: campaign ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'تعذر الحفظ');

      /*
       * FILING UNDER A MANUAL ACCOUNT IS ITS OWN EDIT, AFTER THE SAVE.
       *
       * The link has always been a separate request on the server (it must be
       * checked against an account this store owns, and it decides where the
       * spend comes from), so it stays one here rather than being folded into
       * the body. Sent only when it CHANGED: a rename must not re-file.
       *
       * And a failure here does not leave the editor open on a saved campaign:
       * in «new» mode a second press would create it twice. It closes and says
       * what did not happen.
       */
      if (!filedUnderConnected && form.adAccountId !== startedWithAccount) {
        const id: string | undefined = campaign?.id ?? json.campaign?.id;
        try {
          if (!id) throw new Error('');
          await apiJson(`/api/growth/campaigns/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ adAccountId: form.adAccountId || null, externalId: null }),
          });
        } catch (e) {
          const why = e instanceof Error ? e.message : '';
          onSaved(`حُفظت الحملة، لكن تعذّر نسبتها إلى الحساب${why ? `: ${why}` : '.'}`);
          return;
        }
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر الحفظ');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[var(--sys-sidebar)]/40 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        dir="rtl"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-lg bg-[var(--sys-card)] p-4 sm:rounded-lg"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold text-[var(--sys-heading)]">{campaign ? 'تعديل الحملة' : 'حملة جديدة'}</h2>
          <button aria-label="إغلاق" onClick={onClose} className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 rounded-lg p-1 text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-surface)]">
            <RiCloseLine className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3">
          <Field label="اسم الحملة">
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="مثلاً: عرض رمضان — فيديو 1"
              className={INPUT}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="المنصّة">
              <select value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })} className={INPUT}>
                {CAMPAIGN_PLATFORMS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </Field>
            <Field label="الحالة">
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className={INPUT}>
                {CAMPAIGN_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </Field>
          </div>

          {/* Shown only when there is something to choose: this platform has a
              hand-kept account, or the campaign is already filed under one. A
              select with one option reading «بلا حساب» is clutter. */}
          {!filedUnderConnected && (accountsHere.length > 0 || form.adAccountId) && (
            <Field label="الحساب الإعلاني" hint="حساباتك اليدوية على هذه المنصة. للربط التلقائي استعمل «اربط» في القائمة.">
              <select
                value={form.adAccountId}
                onChange={(e) => setForm({ ...form, adAccountId: e.target.value })}
                className={INPUT}
              >
                <option value="">بلا حساب</option>
                {accountsHere.map((a) => (
                  <option key={a.id} value={a.id}>{a.accountName ?? a.accountId}</option>
                ))}
                {/* A campaign filed under an account of ANOTHER platform (it was
                    changed after filing) must still show where it is, or the
                    select would read «بلا حساب» about a campaign that has one. */}
                {form.adAccountId && !accountsHere.some((a) => a.id === form.adAccountId) && (
                  <option value={form.adAccountId}>
                    {manualAccounts.find((a) => a.id === form.adAccountId)?.accountName ?? 'حساب على منصة أخرى'}
                  </option>
                )}
              </select>
            </Field>
          )}

          <Field label="تذهب إلى" hint="اتركها فارغة لتذهب إلى واجهة المتجر">
            <select
              value={form.landingPageId}
              onChange={(e) =>
                // Linking a page CLEARS the chosen product, because the page
                // answers the question from then on. Leaving it set would
                // let somebody save a contradiction the door then refuses —
                // a form that collects a refusal is a form that wastes a
                // person's time to teach them a rule.
                setForm({ ...form, landingPageId: e.target.value, productId: e.target.value ? '' : form.productId })
              }
              className={INPUT}
            >
              <option value="">واجهة المتجر</option>
              {pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>

          {/*
            THE PRODUCT — asked only when it cannot be derived.
            With a page linked, the page NAMES the product and this field
            would be a second answer. So the field is replaced by the
            sentence saying where the answer comes from.
          */}
          {form.landingPageId ? (
            <Field label="المنتج" hint="مأخوذ من صفحة الهبوط المرتبطة">
              <p className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] px-3 py-2 text-xs text-[var(--sys-muted-foreground)]">
                {products.find((x) => x.id === campaign?.product?.id)?.name ??
                  campaign?.product?.name ??
                  'يُقرأ من الصفحة بعد الحفظ'}
              </p>
            </Field>
          ) : (
            <Field label="المنتج" hint="للإعلانات التي لا تذهب إلى صفحة هبوط — اتركه فارغاً إن كان الإعلان للمتجر كلّه">
              <select
                value={form.productId}
                onChange={(e) => setForm({ ...form, productId: e.target.value })}
                className={INPUT}
              >
                <option value="">غير محدَّد</option>
                {products.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </Field>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="تبدأ">
              <input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} className={INPUT} />
            </Field>
            <Field label="تنتهي" hint="اتركها فارغة إن كانت مستمرة">
              <input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} className={INPUT} />
            </Field>
          </div>

          <Field label={`ما أنفقته (${currency})`} hint="الرقم من مدير إعلاناتك. حدّثه كلما أنفقت أكثر.">
            <input
              type="number"
              min={0}
              step="0.01"
              value={form.spend}
              onChange={(e) => setForm({ ...form, spend: e.target.value })}
              className={INPUT}
              dir="ltr"
            />
          </Field>

          <Field label="ملاحظات">
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={2}
              className={INPUT}
              placeholder="الجمهور، الفيديو المستخدم، أي شيء تريد تذكّره"
            />
          </Field>

          {campaign && (
            <p className="rounded-lg bg-[var(--sys-surface)] p-2 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
              الرمز <b className="font-mono">{campaign.code}</b> لا يتغيّر — فهو مطبوع على كل طلب جاءت به
              هذه الحملة. حملة تحتاج رمزاً جديداً هي حملة جديدة.
            </p>
          )}

          {error && <p className="text-xs font-medium text-[var(--sys-destructive)]">{error}</p>}
        </div>

        <div className="mt-4 flex gap-2">
          <Button onClick={save} disabled={busy || !form.name.trim()} className="flex-1">
            {busy ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : null}
            {campaign ? 'احفظ' : 'أنشئ الحملة'}
          </Button>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
        </div>
      </div>
    </div>
  );
}

const INPUT =
  'w-full rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] px-3 py-2 text-sm text-[var(--sys-heading)] outline-none focus:border-[var(--sys-primary)]';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold text-[var(--sys-foreground)]">{label}</label>
      {children}
      {hint && <p className="mt-0.5 text-xs text-[var(--sys-muted)]">{hint}</p>}
    </div>
  );
}


/**
 * SAYING WHICH OF OURS IS WHICH OF THEIRS.
 *
 * Done once, by hand, and by id forever after. Matching by NAME would break
 * the first time somebody renamed a campaign in Ads Manager — which people
 * do constantly — and it would break silently: the spend would simply stop
 * attaching to anything, and the campaign would read as free.
 */
function LinkDialog({
  campaign, accounts, onClose, onSaved,
}: {
  campaign: Campaign;
  accounts: AdAccount[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [accountId, setAccountId] = useState(campaign.adAccount?.id ?? accounts[0]?.id ?? '');
  const [remote, setRemote] = useState<{ id: string; name: string; status: string }[] | null>(null);
  const [chosen, setChosen] = useState(campaign.externalId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId) return;
    setRemote(null);
    setError(null);
    void fetch(`/api/settings/ad-accounts/${accountId}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'تعذر جلب الحملات');
        setRemote(j.campaigns || []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'تعذر جلب الحملات'));
  }, [accountId]);

  async function save(unlink = false) {
    setBusy(true);
    try {
      const res = await fetch(`/api/growth/campaigns/${campaign.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          unlink ? { adAccountId: null, externalId: null } : { adAccountId: accountId, externalId: chosen }
        ),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'تعذر الحفظ');
      onSaved();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الحفظ');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[var(--sys-sidebar)]/40 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        dir="rtl"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-lg bg-[var(--sys-card)] p-4 sm:rounded-lg"
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-sm font-bold text-[var(--sys-heading)]">اربط «{campaign.name}» بحملة في ميتا</h2>
          <button aria-label="إغلاق" onClick={onClose} className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 rounded-lg p-1 text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-surface)]">
            <RiCloseLine className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-3 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
          بعدها يأتي الإنفاق تلقائياً. الربط بالمعرّف لا بالاسم — فتغيير اسم الحملة في ميتا
          لن يقطعه.
        </p>

        {accounts.length > 1 && (
          <div className="mb-3">
            <label className="mb-1 block text-xs font-semibold text-[var(--sys-foreground)]">الحساب الإعلاني</label>
            <select value={accountId} onChange={(e) => { setAccountId(e.target.value); setChosen(''); }} className={INPUT}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.accountName ?? a.accountId}</option>
              ))}
            </select>
          </div>
        )}

        {error && <p className="mb-2 rounded-lg bg-[var(--sys-destructive-soft)] p-2 text-xs text-[var(--sys-destructive)]">{error}</p>}

        {remote === null && !error ? (
          <div className="flex h-24 items-center justify-center text-[var(--sys-muted-foreground)]">
            <RiLoader4Line className="h-4 w-4 animate-spin" />
          </div>
        ) : remote && remote.length === 0 ? (
          <p className="rounded-lg bg-[var(--sys-surface)] p-3 text-xs text-[var(--sys-muted-foreground)]">
            لا حملات في هذا الحساب.
          </p>
        ) : (
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {(remote ?? []).map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setChosen(r.id)}
                className={`flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-2 text-start transition ${
                  chosen === r.id ? 'border-[var(--sys-primary)] bg-[var(--sys-primary-soft)]' : 'border-[var(--sys-border)] hover:border-[var(--sys-primary)]/40'
                }`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-xs font-semibold text-[var(--sys-foreground)]">{r.name}</span>
                  <span className="block font-mono text-xs text-[var(--sys-muted)]" dir="ltr">{r.id}</span>
                </span>
                <span className={`shrink-0 rounded-lg px-1.5 py-0.5 text-xs font-semibold ${
                  r.status === 'ACTIVE' ? 'bg-[var(--sys-success-soft)] text-[var(--sys-success)]' : 'bg-[var(--sys-surface-strong)] text-[var(--sys-muted-foreground)]'
                }`}>
                  {r.status === 'ACTIVE' ? 'تعمل' : 'متوقفة'}
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="mt-4 flex gap-2">
          <Button onClick={() => save(false)} disabled={busy || !chosen} className="flex-1">
            {busy ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiCheckLine className="h-4 w-4" />}
            اربط
          </Button>
          {campaign.spendSource === 'SYNCED' && (
            <Button variant="outline" onClick={() => save(true)} disabled={busy}>
              فكّ الربط
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
        </div>

        {campaign.spendSource === 'SYNCED' && (
          <p className="mt-2 text-xs leading-relaxed text-[var(--sys-muted)]">
            فكّ الربط يعيد الإنفاق للإدخال اليدوي، ولا يمسح الرقم المسحوب — هو مصروف حقيقي حدث.
          </p>
        )}
      </div>
    </div>
  );
}
