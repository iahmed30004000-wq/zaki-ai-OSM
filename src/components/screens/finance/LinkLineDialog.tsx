'use client';

import React, { useRef, useState } from 'react';
import { RiAlertLine, RiLink, RiLoader4Line, RiPhoneLine, RiSearchLine } from '@remixicon/react';
import { apiJson } from '@/lib/api-client';
import { Modal } from '@/components/ui/Modal';
import { Money } from '@/components/ui/Money';
import { useToast } from '@/components/ui/Toast';
import type { CandidateSearch, LinkCandidate, LinePhoneSearch, LineSummary } from '@/lib/hand-link';
import type { Agreement } from '@/lib/line-compare';

/**
 * «اربطه بطلب» — A LINE THE MATCHER COULD NOT PLACE, PLACED BY A PERSON.
 *
 * The company wrote a line and nothing of ours carries its reference. A person who reads it can usually say whose
 * parcel it is — the customer's phone is in the company's notes, or our own order number is. So this asks for
 * exactly that, in a real field, and shows the orders it might be: the customer's, nearest to the line's amount
 * first, with how many of that number's orders are closed and how many are still open.
 *
 * It decides nothing. The server judges the link with the matcher's own rule and refuses an order that is
 * already settled, already matched, or named by another statement; those appear greyed here with the reason, so
 * nobody finds out by pressing. An order that is with another courier carries a warning and asks once more.
 *
 * «بهاتف السطر» runs by itself the moment the dialog opens: the server reads the phone off the line's own row and
 * lists that customer's orders still being shipped with this courier («ياخد تلقائيا الرقم … ويظهرلك الطلبات الي قيد
 * الشحن و انا اختار»). The free search stays under it for a line with no phone, or a phone the row got wrong.
 *
 * A press is one press: a second click while the first is on its way sends nothing. A refusal that means the page is
 * older than the line (somebody linked it, the matching was run again, the statement was approved) says so and
 * offers to refresh the list behind — the server wrote nothing.
 */

/** The refusals after which the list behind the dialog no longer says the truth: offer to refresh it. */
export const STALE_CODES: readonly string[] = ['NOT_LINKABLE', 'NOT_FOUND', 'ALREADY_APPROVED'];

/*
 * «كيف بدي أقارن بين الطلب الموجود والطلب اللي عنا عشان أعرف إنو هو ولا لأ» (the owner, 8/11).
 *
 * The dialog showed an order's number, phone, name and what we expect — and nothing of what the company wrote on the line, so
 * there was nothing to hold the one against the other. It now shows the company's line on top, a mark beside each order for the
 * three fields that can be compared without guessing (phone, governorate, net), and — for the order the person has picked — the
 * two sides of every field in one table. The marks are the server's (`lib/line-compare`); nothing here works out a figure. A
 * name and an address are laid side by side and never marked: a person reads those.
 */
const MARK: Record<Agreement, { text: string; tone: string }> = {
  SAME: { text: 'مطابق', tone: 'text-[var(--sys-success)]' },
  DIFFERENT: { text: 'مختلف', tone: 'text-[var(--sys-destructive)]' },
  UNKNOWN: { text: 'غير معروف', tone: 'text-[var(--sys-muted-foreground)]' },
};

function AgreementMark({ label, value }: { label: string; value: Agreement | undefined }) {
  const mark = MARK[value ?? 'UNKNOWN'];
  return (
    <span className={`text-xs font-medium ${mark.tone}`}>
      {label}: {mark.text}
    </span>
  );
}

/** What the company wrote on the line — the same card whichever way the person searched. */
function CompanyLineCard({ line, currency }: { line: LineSummary; currency: string }) {
  const facts: [string, React.ReactNode][] = [
    ['الحالة', line.status],
    ['الاسم', line.name],
    ['الهاتف', line.phone ? <b dir="ltr">{line.phone}</b> : null],
    ['المحافظة', line.governorate],
    ['العنوان', line.address],
  ];
  const figures: [string, number | null][] = [
    ['المحصَّل من الزبون', line.collected],
    ['أجرة الشركة', line.fee],
    ['الصافي في الكشف', line.net],
  ];
  return (
    <section aria-label="ما كتبته الشركة" className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-3 space-y-1">
      <h3 className="text-xs font-medium text-[var(--sys-heading)]">ما كتبته الشركة عن هذا السطر</h3>
      <ul className="space-y-1 text-xs">
        {facts.filter(([, v]) => v).map(([k, v]) => (
          <li key={k}>
            <span className="text-[var(--sys-muted-foreground)]">{k}: </span>
            <span dir="auto">{v}</span>
          </li>
        ))}
        {figures.filter(([, v]) => v !== null).map(([k, v]) => (
          <li key={k}>
            <span className="text-[var(--sys-muted-foreground)]">{k}: </span>
            <Money value={v as number} currency={currency} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The two sides of every field, for the one order the person has picked — a list, one field to an item (what the company
 * wrote, then what we have, then the mark), so it reads the same on a phone and on a desk. It is not a table on purpose: this
 * is a few lines to read, not a list of records, and the shared table component draws a list of records.
 */
function CompareFields({ line, c, currency }: { line: LineSummary | null | undefined; c: LinkCandidate; currency: string }) {
  type Cell = React.ReactNode;
  const text = (v: string | null | undefined, ltr = false): Cell => (v ? <span dir={ltr ? 'ltr' : 'auto'}>{v}</span> : '—');
  const money = (v: number | null | undefined): Cell => (v === null || v === undefined ? '—' : <Money value={v} currency={currency} />);
  const rows: { k: string; company: Cell; ours: Cell; mark?: Agreement }[] = [
    { k: 'الهاتف', company: text(line?.phone, true), ours: text(c.details?.phone, true), mark: c.compare?.phone },
    { k: 'المحافظة', company: text(line?.governorate), ours: text(c.details?.governorate), mark: c.compare?.governorate },
    { k: 'العنوان', company: text(line?.address), ours: text(c.details?.address) },
    { k: 'الاسم', company: text(line?.name), ours: text(c.details?.name) },
    { k: 'الحالة', company: text(line?.status), ours: text(c.details?.shipping) },
    { k: 'الصافي', company: money(line?.net), ours: money(c.expected), mark: c.compare?.amount },
    { k: 'المحصَّل من الزبون', company: money(line?.collected), ours: money(c.details?.totalAmount) },
    { k: 'أجرة التوصيل', company: money(line?.fee), ours: money(c.details?.deliveryFee) },
  ];
  const marks = rows.map((r) => r.mark).filter((m): m is Agreement => !!m && m !== 'UNKNOWN');
  const same = marks.filter((m) => m === 'SAME').length;
  return (
    <div role="group" aria-label="الشركة مقابل طلبنا" className="mt-1 rounded-lg border border-[var(--sys-border)] p-2 space-y-1">
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={r.k} className="text-xs">
            <span className="font-medium text-[var(--sys-muted-foreground)]">{r.k}</span>
            {r.mark && <span className={`font-medium ${MARK[r.mark].tone}`}> — {MARK[r.mark].text}</span>}
            <span className="block">الشركة: {r.company}</span>
            <span className="block">طلبنا: {r.ours}</span>
          </li>
        ))}
      </ul>
      {marks.length > 0 && (
        <p className="text-xs text-[var(--sys-muted-foreground)]">
          يتفقان في {same} من {marks.length} من الحقول اللي بتنقارن (الهاتف والمحافظة والصافي). الاسم والعنوان اقرأهم بنفسك.
        </p>
      )}
    </div>
  );
}

const codeOf = (e: unknown): string | null => {
  const data = (e as { data?: { code?: unknown } } | null)?.data;
  return typeof data?.code === 'string' ? data.code : null;
};

interface Props {
  statementId: string;
  matchId: string;
  /** The line's own reference, shown at the top so the person knows which line this is. */
  reference: string | null;
  amount: number | null;
  currency: string;
  onLinked: () => void;
}

export function LinkLineDialog({ statementId, matchId, reference, amount, currency, onLinked }: Props) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<CandidateSearch | null>(null);
  // What was searched (not what is being typed now): the server checks an order of another courier against it.
  const [searched, setSearched] = useState('');
  const [picked, setPicked] = useState<LinkCandidate | null>(null);
  const [searching, setSearching] = useState(false);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  // Which search the list below came from, and the phone the server read off the line (null: the row has none).
  const [source, setSource] = useState<'phone' | 'text' | null>(null);
  const [linePhone, setLinePhone] = useState<LinePhoneSearch['phone']>(null);
  // State is read on the next render; a second click in the same moment must be stopped before that.
  const pressing = useRef(false);

  const base = `/api/finance/statements/${statementId}/matches/${matchId}/link`;

  const failed = (e: unknown, fallback: string) => {
    setError(e instanceof Error ? e.message : fallback);
    setStale(STALE_CODES.includes(codeOf(e) ?? ''));
  };

  const searchByPhone = async () => {
    setSearching(true);
    setError(null);
    setStale(false);
    setPicked(null);
    try {
      const r = await apiJson<LinePhoneSearch>(`${base}?by=phone`);
      setFound(r);
      setLinePhone(r.phone);
      setSource('phone');
      setSearched('');
    } catch (e) {
      failed(e, 'تعذّر البحث');
    } finally {
      setSearching(false);
    }
  };

  const search = async () => {
    setSearching(true);
    setError(null);
    setStale(false);
    setPicked(null);
    try {
      setFound(await apiJson<CandidateSearch>(`${base}?q=${encodeURIComponent(query.trim())}`));
      setSearched(query.trim());
      setSource('text');
    } catch (e) {
      failed(e, 'تعذّر البحث');
    } finally {
      setSearching(false);
    }
  };

  const openDialog = () => {
    setOpen(true);
    setFound(null);
    setPicked(null);
    setError(null);
    setStale(false);
    setSource(null);
    void searchByPhone();
  };

  const refresh = () => {
    setOpen(false);
    onLinked();
  };

  const link = async () => {
    if (!picked || pressing.current) return;
    pressing.current = true;
    setLinking(true);
    setError(null);
    setStale(false);
    try {
      const res = await apiJson<{ message: string; linked: { result: string } }>(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: picked.id, acceptOtherCourier: picked.otherCourier, query: searched }),
      });
      if (res.linked.result === 'MATCHED') toast.done(res.message);
      else toast.warn(res.message);
      setOpen(false);
      onLinked();
    } catch (e) {
      failed(e, 'تعذّر الربط');
    } finally {
      pressing.current = false;
      setLinking(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="min-h-11 md:min-h-0 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:border-[var(--sys-warning)] hover:text-[var(--sys-warning)]"
      >
        <RiLink className="h-4 w-4" />
        اربطه بطلب
      </button>

      {open && (
        <Modal isOpen onClose={() => setOpen(false)} title="اربط سطر الكشف بطلب">
          <div className="space-y-3">
            <p className="text-sm text-[var(--sys-foreground)]">
              السطر: <b dir="ltr">{reference ?? '—'}</b>
              {amount !== null && (
                <>
                  {' '}— المبلغ في الكشف <Money value={amount} currency={currency} />
                </>
              )}
              .
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void searchByPhone()}
                disabled={searching}
                className={`h-11 md:h-10 px-4 rounded-lg border text-sm inline-flex items-center gap-2 disabled:opacity-50 ${
                  source === 'phone' ? 'border-[var(--sys-primary)] bg-[var(--sys-surface)]' : 'border-[var(--sys-border)]'
                }`}
              >
                <RiPhoneLine className="w-4 h-4" />
                بهاتف السطر — الطلبات قيد الشحن
              </button>
              {source === 'phone' && linePhone && (
                <span className="text-xs text-[var(--sys-muted-foreground)]">
                  الهاتف بسطر الشركة: <b dir="ltr">{linePhone.shown}</b>
                </span>
              )}
            </div>

            <p className="text-xs text-[var(--sys-muted-foreground)]">أو بحث حر: اكتب هاتف الزبون أو رقم طلبنا أو رقم الشحنة.</p>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void search();
              }}
              className="flex gap-2"
            >
              <label className="flex-1">
                <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">البحث</span>
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  dir="ltr"
                  className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
                  placeholder="هاتف أو رقم طلب"
                />
              </label>
              <button
                type="submit"
                disabled={searching || query.trim().length === 0}
                className="h-11 md:h-10 px-4 self-end rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-medium inline-flex items-center gap-2 disabled:opacity-50"
              >
                {searching ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiSearchLine className="w-4 h-4" />}
                ابحث
              </button>
            </form>

            {found && (
              <div className="space-y-2">
                {found.line && <CompanyLineCard line={found.line} currency={currency} />}
                <p className="text-sm font-medium text-[var(--sys-heading)]">{found.header}</p>
                {found.hint && <p className="text-xs text-[var(--sys-muted-foreground)]">{found.hint}</p>}
                <ul className="space-y-2">
                  {found.candidates.map((c) => {
                    const blocked = c.blockedBy.length > 0;
                    return (
                      <li key={c.id}>
                        <button
                          type="button"
                          disabled={blocked}
                          onClick={() => setPicked(c)}
                          className={`w-full text-right rounded-lg border p-3 text-sm disabled:opacity-50 ${
                            picked?.id === c.id
                              ? 'border-[var(--sys-primary)] bg-[var(--sys-surface)]'
                              : 'border-[var(--sys-border)]'
                          }`}
                        >
                          <span className="flex flex-wrap items-center justify-between gap-2">
                            <span dir="ltr" className="font-medium">{c.orderNumber}</span>
                            <span className="text-xs text-[var(--sys-muted-foreground)]">
                              {c.closed ? 'مغلق' : 'مفتوح'}
                            </span>
                          </span>
                          <span className="block text-xs text-[var(--sys-muted-foreground)]">
                            {c.customer?.fullName ?? '—'} — <span dir="ltr">{c.customer?.phone ?? '—'}</span>
                          </span>
                          {c.expected !== null && (
                            <span className="block text-xs">
                              المتوقَّع <Money value={c.expected} currency={currency} />
                            </span>
                          )}
                          {c.compare && (
                            <span className="flex flex-wrap gap-x-3 gap-y-0.5 pt-1">
                              <AgreementMark label="الهاتف" value={c.compare.phone} />
                              <AgreementMark label="المحافظة" value={c.compare.governorate} />
                              <AgreementMark label="المبلغ" value={c.compare.amount} />
                            </span>
                          )}
                          {c.otherCourier && (
                            <span className="flex items-center gap-1 text-xs text-[var(--sys-warning)]">
                              <RiAlertLine className="h-4 w-4" />
                              {found.otherCourierWarning}
                            </span>
                          )}
                          {blocked && (
                            <span className="block text-xs text-[var(--sys-destructive)]">{c.blockedBy.join(' · ')}</span>
                          )}
                        </button>
                        {/* The two sides of every field, for the order picked — a person tells whether it is the parcel. */}
                        {picked?.id === c.id && <CompareFields line={found.line} c={c} currency={currency} />}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {error && (
              <div role="alert" className="space-y-2">
                <p className="text-sm text-[var(--sys-destructive)]">{error}</p>
                {stale && (
                  <button
                    type="button"
                    onClick={refresh}
                    className="h-11 md:h-10 px-4 rounded-lg border border-[var(--sys-border)] text-sm"
                  >
                    حدّث الصفحة
                  </button>
                )}
              </div>
            )}

            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="h-11 md:h-10 px-4 rounded-lg border border-[var(--sys-border)] text-sm"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={!picked || linking}
                onClick={() => void link()}
                className="h-11 md:h-10 px-4 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-medium disabled:opacity-50"
              >
                {picked ? `اربطه بالطلب ${picked.orderNumber}` : 'اختر طلباً'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
