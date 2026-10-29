'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { apiFetch, apiJson } from '@/lib/api-client';
import { arDateTime } from '@/lib/format';
import { useApp } from '@/context/AppContext';
import { useMayOpen } from '@/hooks/useMayOpen';
import { userCan } from '@/lib/can';
import { Modal } from '@/components/ui/Modal';
import { ScreenTitle } from '@/components/shell/ScreenTitle';
import {
  RiAlertLine,
  RiCheckboxCircleLine,
  RiFileExcel2Line,
  RiLoader4Line,
  RiAttachmentLine,
  RiUpload2Line,
} from '@remixicon/react';
import { Rows } from '@/components/ui/Rows';
import { EmptyState } from '@/components/ui/EmptyState';
import { NextStepButton } from '@/components/ui/NextStep';
import { Money } from '@/components/ui/Money';
import { importedSentence, type ImportedStatement } from '@/lib/statement-import-message';
import { approvalRefusal, isApproved, rematchRefusal } from '@/lib/settlement-gates';
import { useConfirm } from '@/components/ui/Confirm';
import { AssembleStatementDialog } from '@/components/screens/finance/AssembleStatementDialog';
import { receiptsInStatementCurrency } from '@/lib/receipt-conversion';
import { minorUnitFor } from '@/lib/currencies';

/**
 * /finance/collection — the three sequential steps, in order and visible as
 * such: import the courier statement, record what actually arrived, then
 * approve. The money moves on approval and nowhere earlier, so the approve
 * button stays disabled until receipts exist, matching has run and any gap
 * between claimed and received carries a written explanation.
 */

interface Gap {
  claimed: number;
  received: number;
  gap: number;
  /**
   * Receipts taken in another currency with no rate stored. Their money is in
   * neither `received` nor `gap`, so the row has to say so rather than let the
   * shortfall be read as the courier's.
   */
  unconvertible: number;
  needsExplanation: boolean;
  explained: boolean;
}

interface StatementRow {
  id: string;
  reference: string;
  fileName: string;
  status: string;
  /** Set when the money moved. Nothing about the statement reopens after it. */
  approvedAt: string | null;
  /** A statement a person gathered by hand, and whether it is still the open draft (no reference, no receipt yet). */
  manual?: boolean;
  draft?: boolean;
  currencyCode: string;
  totalAmount: number;
  createdAt: string;
  counts: { lines: number; receipts: number; matches: number };
  receipts: ReceiptRow[];
  gap: Gap;
}

interface ReceiptRow {
  id: string;
  amount: number;
  currencyCode: string;
  receivedAt: string;
  note: string | null;
  wallet: string;
  /** Null when the collection was recorded with no paper behind it. */
  proof: { name: string; mime: string | null; size: number | null } | null;
}

/**
 * THE SAME CEILING THE SERVER HOLDS, AND IT IS WRITTEN TWICE ON PURPOSE.
 *
 * `MAX_PROOF_BYTES` in `settlement-proof.ts` is the real rule, and importing
 * it here is what I tried first. It cannot be done: that module opens with
 * `import fs from 'fs'` because it writes the file, and this is a `'use
 * client'` screen — pulling a node builtin into the browser bundle is a trap
 * even on the days a bundler happens to shake it out.
 *
 * So the number is written again, and `the-paper-behind-a-collection`
 * reads BOTH files and fails the moment they disagree. That is the same
 * answer this repository already gives for the shared field's height, which
 * `touch-targets` pins across `Button.tsx` and `Input.tsx` for the same
 * reason: a constant that cannot cross a boundary is held equal by a test
 * rather than by hope.
 *
 * Why it matters that they agree: a browser refusing at 4 while the server
 * refuses at 2 is a form that lies; the other way round is a 4 MB upload
 * that travels over a phone connection before being refused.
 */
const MAX_PROOF_MB = 4;

/** A hand-entered movement that looks like the same money as a receipt — what the server lists before approving. */
interface HandRow {
  id: string;
  wallet: string;
  currencyCode: string;
  date: string;
  amount: number;
  party: string;
  note: string;
  by: string | null;
}

/**
 * The file as base64, in chunks: `String.fromCharCode(...bytes)` on a four-megabyte array blows the argument
 * limit and throws. One reader for the receipt dialog and for a proof changed later.
 */
async function fileToBase64(picked: File): Promise<string> {
  const bytes = new Uint8Array(await picked.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

const STATUS_AR: Record<string, string> = {
  IMPORTED: 'مستورد',
  RECEIPTED: 'سُجِّل الاستلام',
  MATCHED: 'مطابَق',
  APPROVED: 'معتمد',
};

const STATUS_STYLE: Record<string, string> = {
  IMPORTED: 'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)] border-[var(--sys-border)]',
  RECEIPTED: 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] border-[var(--sys-warning)]/40',
  MATCHED: 'bg-[var(--sys-surface)] text-[var(--sys-foreground)] border-[var(--sys-border)]',
  APPROVED: 'bg-[var(--sys-success-soft)] text-[var(--sys-success)] border-[var(--sys-success)]/40',
};

export function CollectionScreen() {
  const { currentUser } = useApp();
  const mayOpen = useMayOpen();
  const confirm = useConfirm();
  /*
   * A COMPANY THAT SENDS NO STATEMENT HAS NOTHING TO IMPORT HERE — AND THE PAGE SAID NOTHING ABOUT IT.
   * The way in is «يدوي — بلا كشف» on the matching screen, which needs two things the link must ask for
   * before it is drawn: that screen, and the permission to follow a parcel it works from.
   */
  const pointsToManual = userCan(currentUser, 'ops.track') && mayOpen('/finance/matching');
  const [rows, setRows] = useState<StatementRow[] | null>(null);
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([]);
  const [wallets, setWallets] = useState<{ id: string; name: string; currencyCode: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [receiptFor, setReceiptFor] = useState<StatementRow | null>(null);
  const [explainFor, setExplainFor] = useState<StatementRow | null>(null);
  // The draft whose «تجميع» dialog is open.
  const [assembleFor, setAssembleFor] = useState<StatementRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // The hand rows the server found when asked to approve: shown with «اعتمد هيك» / «رجوع», never auto-confirmed.
  const [doubleFor, setDoubleFor] = useState<{ statement: StatementRow; sentence: string; rows: HandRow[] } | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiJson<{ statements: StatementRow[] }>('/api/finance/statements');
      setRows(data.statements);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, []);

  useEffect(() => {
    void load();
    void apiJson<{ providers: { id: string; name: string }[] }>('/api/ops/references')
      .then((d) => setProviders(d.providers))
      .catch(() => undefined);
    void apiJson<{ wallets: { id: string; name: string; currencyCode: string }[] }>('/api/finance/wallets')
      .then((d) => setWallets(d.wallets))
      .catch(() => undefined);
  }, [load]);

  async function act(id: string, label: string, run: () => Promise<unknown>) {
    setBusy(id);
    setError(null);
    setDone(null);
    try {
      await run();
      setDone(label);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التنفيذ');
    } finally {
      setBusy(null);
    }
  }

  /**
   * APPROVAL — and the one answer that is not a plain refusal.
   * When a hand entry of the same money is already in the wallet the server answers POSSIBLE_DOUBLE with the
   * rows. They are shown here; only «اعتمد هيك» sends the approval again with the confirmation.
   */
  async function approve(s: StatementRow, confirmed = false) {
    setBusy(s.id);
    setError(null);
    setDone(null);
    try {
      const res = await apiFetch(`/api/finance/statements/${s.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ approve: true, ...(confirmed ? { confirmPossibleDouble: true } : {}) }),
      });
      const data = (await res.json().catch(() => ({}))) as { code?: string; error?: string; errorAr?: string; rows?: HandRow[] };
      if (res.status === 409 && data.code === 'POSSIBLE_DOUBLE') {
        setDoubleFor({ statement: s, sentence: data.error ?? '', rows: data.rows ?? [] });
        return;
      }
      if (!res.ok) throw new Error(data.errorAr || data.error || `HTTP ${res.status}`);
      setDoubleFor(null);
      setDone('اعتُمد الكشف وسُجِّلت حركة المحفظة');
      await load();
    } catch (e) {
      setDoubleFor(null);
      setError(e instanceof Error ? e.message : 'تعذر التنفيذ');
    } finally {
      setBusy(null);
    }
  }

  /** A receipt's proof, changed until the statement is approved. A real file, judged by the server like the first one. */
  async function changeProof(s: StatementRow, r: ReceiptRow, picked: File | undefined) {
    if (!picked) return;
    if (picked.size > MAX_PROOF_MB * 1024 * 1024) {
      setError(`حجم الملف ${Math.round(picked.size / 1024 / 1024)} ميجابايت — الحد ${MAX_PROOF_MB}`);
      return;
    }
    const content = await fileToBase64(picked);
    await act(s.id, 'تغيّر الإثبات', () =>
      apiJson(`/api/finance/statements/${s.id}/receipts/${r.id}/proof`, {
        method: 'PUT',
        body: JSON.stringify({ fileName: picked.name, content }),
      })
    );
  }

  /** A wrong receipt, taken back until the statement is approved. Asks first; the wallet was never touched. */
  async function removeReceipt(s: StatementRow, r: ReceiptRow) {
    const ok = await confirm({
      title: `حذف إيصال ${r.amount} ${r.currencyCode} — ${r.wallet}؟`,
      body: 'يُحذف هذا الإيصال وحده. لم تتحرك المحفظة لأن الكشف لم يُعتمد، وتضيف الإيصال الصحيح بعده.',
      tone: 'danger',
    });
    if (!ok) return;
    await act(s.id, 'حُذف الإيصال', () =>
      apiJson(`/api/finance/statements/${s.id}/receipts/${r.id}`, { method: 'DELETE' })
    );
  }

  /**
   * TAKING BACK A WRONG UPLOAD.
   * Offered until the statement is APPROVED (the row itself stops offering it, and `undoImportRefusal` is the rule the server enforces): before it nothing
   * financial exists, so the statement goes with its receipts and matches; after it a correction is a reversing entry.
   */
  async function undoImport(s: StatementRow) {
    const ok = await confirm({
      title: s.draft ? 'حذف مسوّدة الكشف اليدوي؟' : `إلغاء استيراد الكشف «${s.reference}»؟`,
      body: s.draft
        ? 'تُحذف المسوّدة وأسطرها، وتعود طلباتها إلى المطابقة اليدوية. لم يتحرك أي مبلغ ولم يُسجَّل شيء بالمحافظ.'
        : (s.counts.receipts > 0 ? `سيُحذف معه ${s.counts.receipts} إيصال استلام (ومرفقاته) ونتيجة المطابقة. ` : 'يُحذف الكشف وسطوره. ') +
          'لم يتحرك أي مبلغ ولم يُسجَّل شيء بالمحافظ لأنه لم يُعتمد بعد، ويمكن رفع الملف نفسه من جديد. يزول هذا الخيار عند الاعتماد.',
      tone: 'danger',
    });
    if (!ok) return;
    await act(s.id, s.draft ? 'حُذفت المسوّدة' : `أُلغي استيراد الكشف «${s.reference}»`, () =>
      apiJson(`/api/finance/statements/${s.id}`, { method: 'DELETE' })
    );
  }

  return (
    <div className="max-w-6xl space-y-3">
      <ScreenTitle />

      {pointsToManual && (
        <p className="text-xs text-[var(--sys-muted-foreground)] bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg p-3">
          لا كشف عند الشركة أو المندوب؟ لا حاجة لاستيراد شيء: سجّل التسليم والتحصيل يدوياً من{' '}
          <Link href="/finance/matching?mode=manual" className="font-medium text-[var(--sys-primary)] hover:underline">
            المطابقة ← يدوي — بلا كشف
          </Link>
          . وللطلبات التي سلّمها المندوب وتريد اعتمادها في كشف واحد: «مطابق يدوي» هناك، ثم «تجميع» هنا.
        </p>
      )}

      <ImportCard
        providers={providers}
        busy={importing}
        onImport={async (payload) => {
          setImporting(true);
          setError(null);
          setDone(null);
          try {
            const res = await apiJson<ImportedStatement>('/api/finance/statements', {
              method: 'POST',
              body: JSON.stringify(payload),
            });
            setDone(importedSentence(res));
            await load();
            return true;
          } catch (e) {
            setError(e instanceof Error ? e.message : 'تعذر الاستيراد');
            return false;
          } finally {
            setImporting(false);
          }
        }}
      />

      {error && <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">{error}</p>}
      {done && <p className="text-sm text-[var(--sys-success)] bg-[var(--sys-success-soft)] border border-[var(--sys-success)]/30 rounded-lg p-3">{done}</p>}

      {!rows ? (
        <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-16">
          <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={RiFileExcel2Line}
          title="لا توجد كشوف مستوردة بعد."
          why="لم تُستورد أوراق التحصيل بعد. استورد كشف شركة الشحن ليبدأ مطابقة ما حُصّل بما استُحق."
        />
      ) : (
        <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg overflow-hidden">
          {/* Seven columns of money on a 375px screen. The same
              definition draws the table a finance clerk reads at a desk
              and the card somebody checks on the way to the courier —
              led by the statement's reference and its state. */}
          <Rows
            rows={rows}
            keyOf={(s) => s.id}
            alert={(s) => (s.gap.needsExplanation && !s.gap.explained) || s.gap.unconvertible > 0}
            columns={[
              {
                key: 'ref',
                label: 'الكشف',
                primary: true,
                render: (s) => (
                  <>
                    <span className="font-medium text-[var(--sys-heading)]" dir="ltr">{s.reference}</span>
                    <span className="block text-xs text-[var(--sys-muted)]" dir="ltr">{s.fileName}</span>
                  </>
                ),
              },
              {
                key: 'state',
                label: 'الحالة',
                primary: true,
                render: (s) => (
                  <span className={`text-xs px-2 py-1 rounded-sm border ${STATUS_STYLE[s.status] ?? ''}`}>
                    {s.draft ? 'مسوّدة' : STATUS_AR[s.status] ?? s.status}
                  </span>
                ),
              },
              {
                key: 'claimed',
                label: 'أقرّت الشركة',
                align: 'end',
                render: (s) => <Money value={s.gap.claimed} currency={s.currencyCode} />,
              },
              {
                key: 'received',
                label: 'وصل فعلاً',
                align: 'end',
                render: (s) => (
                  <>
                    <Money value={s.gap.received} currency={s.currencyCode} />
                    {s.gap.unconvertible > 0 && (
                      <span className="block text-xs text-[var(--sys-warning)]">
                        عدا <span className="tabular-nums">{s.gap.unconvertible}</span> إيصالاً بعملة أخرى بلا سعر صرف
                      </span>
                    )}
                  </>
                ),
              },
              {
                key: 'gap',
                label: 'الفرق',
                align: 'end',
                render: (s) => (
                  <span className={s.gap.gap === 0 ? '' : 'font-medium'}>
                    <Money
                      value={s.gap.gap}
                      currency={s.currencyCode}
                      tone={s.gap.gap === 0 ? undefined : 'lost'}
                    />
                    {s.gap.needsExplanation && !s.gap.explained && (
                      <RiAlertLine className="w-4 h-4 inline mr-1 align-[-2px]" />
                    )}
                  </span>
                ),
              },
              {
                key: 'counts',
                label: 'الأسطر',
                render: (s) => (
                  <span className="text-xs text-[var(--sys-muted-foreground)] tabular-nums">
                    {s.counts.lines} سطر · {s.counts.receipts} إيصال · {s.counts.matches} مطابقة
                  </span>
                ),
              },
              {
                key: 'collected',
                label: 'ما وصل، ومن أين',
                render: (s) =>
                  s.receipts.length === 0 ? (
                    <span className="text-xs text-[var(--sys-muted)]">—</span>
                  ) : (
                    /*
                      WHAT WAS COLLECTED, ONE LINE EACH, AND ITS PAPER.
                      The column used to be a count. «٣ إيصال» cannot be
                      checked by anybody, and a proof uploaded against one of
                      the three had nowhere to be opened — which would have
                      made the upload a write-only feature.
                    */
                    <>
                    <ul className="space-y-1">
                      {s.receipts.map((r) => (
                        <li key={r.id} className="flex flex-wrap items-center gap-1.5 text-xs">
                          <Money value={r.amount} currency={r.currencyCode} />
                          <span className="text-[var(--sys-muted-foreground)]">{r.wallet}</span>
                          {r.proof ? (
                            <a
                              href={`/api/finance/statements/${s.id}/receipts/${r.id}/proof`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={r.proof.name}
                              className="inline-flex min-h-11 items-center gap-1 text-[var(--sys-primary)] hover:underline md:min-h-0"
                            >
                              <RiAttachmentLine className="h-4 w-4 shrink-0" aria-hidden />
                              إثبات
                            </a>
                          ) : (
                            /* Said out loud: a collection with no paper is
                               the thing this feature exists to make visible,
                               so it is not left as an absence. */
                            <span className="text-[var(--sys-warning)]">بلا إثبات</span>
                          )}
                          {/* Until «اعتماد» the paper can be changed and a wrong receipt taken back; after it, neither. */}
                          {!isApproved(s) && (
                            <>
                              <label className="inline-flex min-h-11 items-center text-[var(--sys-primary)] hover:underline md:min-h-0">
                                غيّر الإثبات
                                <input
                                  type="file"
                                  accept="image/jpeg,image/png,image/webp,application/pdf"
                                  className="sr-only"
                                  onChange={(e) => {
                                    const picked = e.target.files?.[0];
                                    e.target.value = '';
                                    void changeProof(s, r, picked);
                                  }}
                                />
                              </label>
                              <button
                                type="button"
                                disabled={busy === s.id}
                                onClick={() => void removeReceipt(s, r)}
                                className="inline-flex min-h-11 items-center text-[var(--sys-destructive)] hover:underline disabled:opacity-50 md:min-h-0"
                              >
                                احذف الإيصال
                              </button>
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                    {isApproved(s) && (
                      <p className="mt-1 text-xs text-[var(--sys-muted-foreground)]">الكشف معتمد — التصحيح بقيد عكسي</p>
                    )}
                    </>
                  ),
              },
            ]}
            actions={(s) => {
              /**
               * The one thing this row decides: may it be approved yet — asked
               * of lib/settlement-gates, the same function the server answers
               * with, so the greyed button carries the server's own sentence
               * instead of a second copy of the rule that can drift from it.
               */
              const refusal = approvalRefusal({
                status: s.status,
                approvedAt: s.approvedAt,
                receipts: s.counts.receipts,
                matches: s.counts.matches,
                gap: s.gap,
                explanation: s.gap.explained ? 'explained' : null,
              });
              const noRematch = rematchRefusal(s);
              return isApproved(s) ? (
                <span className="text-xs text-[var(--sys-success)] inline-flex items-center gap-1">
                  <RiCheckboxCircleLine className="w-4 h-4" /> معتمد
                </span>
              ) : (
                <span className="flex flex-wrap gap-3 justify-end">
                  {/* This branch is the unapproved one — an approved row draws «معتمد» above and has no button. */}
                  <button
                    disabled={busy === s.id}
                    onClick={() => void undoImport(s)}
                    className="text-xs text-[var(--sys-destructive)] hover:underline disabled:opacity-50"
                  >
                    {s.draft ? 'حذف المسوّدة' : 'إلغاء الاستيراد'}
                  </button>
                  {s.draft && (
                    <button
                      disabled={busy === s.id}
                      onClick={() => setAssembleFor(s)}
                      className="text-xs font-medium text-[var(--sys-success)] hover:underline disabled:opacity-50"
                    >
                      تجميع
                    </button>
                  )}
                  {!s.draft && (
                    <>
                      <button onClick={() => setReceiptFor(s)} className="text-xs text-[var(--sys-primary)] hover:underline">
                        إيصال استلام
                      </button>
                      <button
                        disabled={s.counts.receipts === 0 || !!noRematch || busy === s.id}
                        title={noRematch?.error ?? (s.counts.receipts === 0 ? 'سجّل إيصال الاستلام أولاً' : 'شغّل المطابقة')}
                        onClick={() =>
                          act(s.id, 'تمت المطابقة', () =>
                            apiJson(`/api/finance/statements/${s.id}/match`, { method: 'POST' })
                          )
                        }
                        className="text-xs text-[var(--sys-primary)] hover:underline disabled:text-[var(--sys-border-strong)] disabled:no-underline"
                      >
                        مطابقة
                      </button>
                      {s.gap.needsExplanation && !s.gap.explained && (
                        <button onClick={() => setExplainFor(s)} className="text-xs text-[var(--sys-warning)] hover:underline">
                          تفسير الفرق
                        </button>
                      )}
                      <button
                        disabled={!!refusal || busy === s.id}
                        title={refusal?.error ?? 'اعتماد الكشف — عندها تُسجَّل حركة المحفظة'}
                        onClick={() => void approve(s)}
                        className="text-xs font-medium text-[var(--sys-success)] hover:underline disabled:text-[var(--sys-border-strong)] disabled:no-underline"
                      >
                        اعتماد
                      </button>
                    </>
                  )}
                </span>
              );
            }}
            empty={
              <EmptyState
                title="لا كشوفَ في هذه الفترة"
                why="الكشف يصل من شركة الشحن ويُرفع من الزرّ أعلاه. بلا كشفٍ لا مطابقةَ ولا اعتماد، والمال المحصَّل يبقى خارج المحافظ."
              />
            }
          />
        </div>
      )}

      {receiptFor && (
        <ReceiptDialog
          statement={receiptFor}
          wallets={wallets}
          onClose={() => setReceiptFor(null)}
          onSaved={async (message) => {
            setReceiptFor(null);
            setDone(message);
            await load();
          }}
        />
      )}

      {assembleFor && (
        <AssembleStatementDialog
          statement={assembleFor}
          onClose={() => setAssembleFor(null)}
          onSaved={async (message) => {
            setAssembleFor(null);
            setDone(message);
            await load();
          }}
        />
      )}

      {/* The money road goes on from here: «المطابقة». */}
      <NextStepButton />

      {doubleFor && (
        <PossibleDoubleDialog
          statement={doubleFor.statement}
          sentence={doubleFor.sentence}
          rows={doubleFor.rows}
          busy={busy === doubleFor.statement.id}
          onClose={() => setDoubleFor(null)}
          onConfirm={() => void approve(doubleFor.statement, true)}
        />
      )}

      {explainFor && (
        <ExplainDialog
          statement={explainFor}
          onClose={() => setExplainFor(null)}
          onSaved={async () => {
            setExplainFor(null);
            setDone('سُجِّل تفسير الفرق');
            await load();
          }}
        />
      )}
    </div>
  );
}

function ImportCard({
  providers,
  busy,
  onImport,
}: {
  providers: { id: string; name: string }[];
  busy: boolean;
  onImport: (payload: {
    deliveryProviderId: string;
    reference: string;
    fileName: string;
    content: string;
    encoding: 'text' | 'base64';
  }) => Promise<boolean>;
}) {
  const [providerId, setProviderId] = useState('');
  const [reference, setReference] = useState('');
  const [file, setFile] = useState<{ name: string; content: string; encoding: 'text' | 'base64' } | null>(null);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!providerId || !file) return;
        const ok = await onImport({
          deliveryProviderId: providerId,
          reference,
          fileName: file.name,
          content: file.content,
          encoding: file.encoding,
        });
        if (ok) {
          setReference('');
          setFile(null);
        }
      }}
      className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4 grid gap-3 md:grid-cols-4 items-end"
    >
      <label>
        <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">شركة الشحن</span>
        <select
          value={providerId}
          onChange={(e) => setProviderId(e.target.value)}
          required
          className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm bg-[var(--sys-card)]"
        >
          <option value="">اختر…</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </label>

      <label>
        <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">مرجع الكشف</span>
        <input
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          required
          minLength={2}
          placeholder="ST-2026-09"
          className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
        />
      </label>

      <label>
        <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">ملف الكشف (Excel أو CSV)</span>
        <input
          type="file"
          accept=".csv,.xlsx,.xls,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={async (e) => {
            const picked = e.target.files?.[0];
            if (!picked) return setFile(null);
            // A spreadsheet is binary: send its bytes, not a text reading of
            // them, or the hash and the parse both see something else.
            if (/\.xlsx?$/i.test(picked.name)) {
              const bytes = new Uint8Array(await picked.arrayBuffer());
              let binary = '';
              for (const b of bytes) binary += String.fromCharCode(b);
              setFile({ name: picked.name, content: btoa(binary), encoding: 'base64' });
            } else {
              setFile({ name: picked.name, content: await picked.text(), encoding: 'text' });
            }
          }}
          className="w-full text-xs file:h-8 file:px-3 file:rounded-md file:border-0 file:bg-[var(--sys-surface)] file:text-[var(--sys-foreground)] file:ml-2"
        />
      </label>

      <button
        type="submit"
        disabled={busy || !file || !providerId}
        className="h-11 md:h-10 px-4 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-medium inline-flex items-center justify-center gap-2 disabled:opacity-50"
      >
        {busy ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiUpload2Line className="w-4 h-4" />}
        استيراد
      </button>
    </form>
  );
}

function ReceiptDialog({
  statement,
  wallets,
  onClose,
  onSaved,
}: {
  statement: StatementRow;
  wallets: { id: string; name: string; currencyCode: string }[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [walletId, setWalletId] = useState('');
  const [amount, setAmount] = useState('');
  const [rate, setRate] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /**
   * THE PAPER BEHIND THE COLLECTION — «حط رفع ملف صورة او ملف عشان اتحقق
   * من التحصيل».
   *
   * Held as base64 in state because that is how it is sent: in the same
   * body as the receipt, so the row and its paper are one transaction. A
   * separate upload call would allow a receipt saved with a proof that then
   * failed to arrive, which is the state this feature exists to prevent.
   *
   * `proofName` is the owner's own name for it. Empty means «keep the
   * file's own name», which the server decides — the browser does not
   * invent a fallback, or there would be two answers to one question.
   */
  const [proof, setProof] = useState<{ fileName: string; content: string; size: number } | null>(null);
  const [proofName, setProofName] = useState('');

  /**
   * ONE ID PER ATTEMPT, KEPT ACROSS RETRIES.
   *
   * Many receipts on one statement are normal — a courier pays part in
   * cash and part by transfer — so the server cannot tell a genuine second
   * payment from this form being submitted twice. This id is what tells
   * it: it survives a failed submit and a second press, so the retry lands
   * on the row the first attempt may already have written, and it is
   * renewed only after a receipt is actually saved.
   */
  const attemptId = useRef(crypto.randomUUID());

  const wallet = wallets.find((w) => w.id === walletId);
  const needsRate = !!wallet && wallet.currencyCode !== statement.currencyCode;
  /*
   * WHAT THE RECEIPT IS WORTH IN THE STATEMENT'S CURRENCY, shown while it is typed.
   *
   * The same function the gap is worked out with (`receiptsInStatementCurrency`): the amount is in the wallet's
   * currency and the rate says how many of it one unit of the statement's currency buys, so going back divides.
   * Said before saving, because a rate typed upside down is the one mistake that looks right until the gap appears.
   */
  const converted =
    needsRate && wallet && Number(amount) > 0 && Number(rate) > 0
      ? receiptsInStatementCurrency(
          [{ amount: Number(amount), currencyCode: wallet.currencyCode, exchangeRate: Number(rate) }],
          statement.currencyCode,
          minorUnitFor(statement.currencyCode) ?? 2
        ).received
      : null;

  return (
    <Modal isOpen onClose={onClose} title={`إيصال استلام — ${statement.reference}`}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError(null);
          try {
            await apiJson(`/api/finance/statements/${statement.id}/receipts`, {
              method: 'POST',
              body: JSON.stringify({
                receiptId: attemptId.current,
                walletId,
                amount: Number(amount),
                ...(needsRate && rate ? { exchangeRate: Number(rate) } : {}),
                ...(note.trim() ? { note: note.trim() } : {}),
                ...(proof
                  ? {
                      proof: {
                        fileName: proof.fileName,
                        content: proof.content,
                        ...(proofName.trim() ? { name: proofName.trim() } : {}),
                      },
                    }
                  : {}),
              }),
            });
            onSaved('سُجِّل إيصال الاستلام — لم تتحرك المحفظة بعد، الحركة تُكتب عند الاعتماد');
          } catch (err) {
            setError(err instanceof Error ? err.message : 'تعذر الحفظ');
          } finally {
            setSaving(false);
          }
        }}
        className="space-y-3"
      >
        <p className="text-xs text-[var(--sys-muted-foreground)] bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg p-3">
          أقرّت الشركة <Money value={statement.gap.claimed} currency={statement.currencyCode} /> ووصل حتى الآن <Money value={statement.gap.received} currency={statement.currencyCode} />.
          يمكن تسجيل أكثر من إيصال لنفس الكشف (نقد + حوالة).
        </p>

        <label className="block">
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">المحفظة التي وصل إليها المبلغ</span>
          <select
            value={walletId}
            onChange={(e) => setWalletId(e.target.value)}
            required
            className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm bg-[var(--sys-card)]"
          >
            <option value="">اختر…</option>
            {wallets.map((w) => (
              <option key={w.id} value={w.id}>{w.name} — {w.currencyCode}</option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">المبلغ الواصل</span>
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

        {needsRate && (
          <label className="block">
            <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">
              سعر الصرف ({statement.currencyCode} → {wallet?.currencyCode})
            </span>
            <input
              type="number"
              step="0.000001"
              min="0.000001"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              required
              className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
              dir="ltr"
            />
            {converted !== null && (
              <span className="mt-1 block text-xs text-[var(--sys-muted-foreground)]">
                يساوي <Money value={converted} currency={statement.currencyCode} /> بعملة الكشف
              </span>
            )}
          </label>
        )}

        <label className="block">
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">ملاحظة (اختيارية)</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
          />
        </label>

        {/*
          THE PROOF. Offered, not demanded — a cash handover in a doorway has
          no paper, and a required field here would stand between somebody
          and recording money that has already arrived.

          The size is checked in the browser as well as on the server, and
          not because the server's check is in doubt: a 9 MB phone photo
          refused after a 12 MB upload is a refusal that cost the person
          their time, on a connection that is often a phone's.
        */}
        <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-3 space-y-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[var(--sys-foreground)]">
              إثبات التحصيل (اختياري) — صورة الإيصال أو ملف PDF للحوالة
            </span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              onChange={async (e) => {
                const picked = e.target.files?.[0];
                setError(null);
                if (!picked) return setProof(null);
                if (picked.size > MAX_PROOF_MB * 1024 * 1024) {
                  setProof(null);
                  e.target.value = '';
                  setError(`حجم الملف ${Math.round(picked.size / 1024 / 1024)} ميجابايت — الحد ${MAX_PROOF_MB}`);
                  return;
                }
                // Chunked (see `fileToBase64`) — the same trap the statement importer walked into.
                setProof({ fileName: picked.name, content: await fileToBase64(picked), size: picked.size });
              }}
              className="w-full text-xs file:h-8 file:px-3 file:rounded-md file:border-0 file:bg-[var(--sys-card)] file:text-[var(--sys-foreground)] file:ml-2"
            />
          </label>

          {proof && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[var(--sys-foreground)]">
                سمِّ الإثبات (اختياري)
              </span>
              <input
                value={proofName}
                onChange={(e) => setProofName(e.target.value)}
                placeholder={proof.fileName}
                maxLength={120}
                className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] text-sm"
              />
              <span className="mt-1 block text-xs text-[var(--sys-muted-foreground)]">
                اتركه فارغاً ليبقى باسم الملف. الامتداد يُضبط من محتوى الملف نفسه.
              </span>
            </label>
          )}
        </div>

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
            {saving ? 'جارٍ الحفظ…' : 'حفظ الإيصال'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * THE SAME MONEY MAY ALREADY BE IN THE WALLET.
 * The server found hand-entered rows with the same amount in the receipt's wallet. They are listed with who
 * wrote them and when; the person reverses them («قيد عكسي» from the wallets screen) and comes back, or says
 * «اعتمد هيك». Nothing here confirms by itself.
 */
function PossibleDoubleDialog({
  statement,
  sentence,
  rows,
  busy,
  onClose,
  onConfirm,
}: {
  statement: StatementRow;
  sentence: string;
  rows: HandRow[];
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal isOpen onClose={onClose} title={`حركة يدوية بنفس المبلغ — ${statement.reference}`}>
      <div className="space-y-3">
        <p className="text-sm text-[var(--sys-foreground)]">{sentence}</p>
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="text-xs bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg p-3 space-y-1">
              <p className="text-[var(--sys-foreground)]">
                <Money value={r.amount} currency={r.currencyCode} /> — {r.wallet}
              </p>
              <p className="text-[var(--sys-muted-foreground)]">
                {arDateTime(r.date)} · {r.party} · {r.note}
                {r.by ? ` · ${r.by}` : ''}
              </p>
            </li>
          ))}
        </ul>
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="h-11 md:h-10 px-4 rounded-lg border border-[var(--sys-border)] text-sm">
            رجوع
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="h-11 md:h-10 px-4 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-medium disabled:opacity-50"
          >
            اعتمد هيك
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ExplainDialog({
  statement,
  onClose,
  onSaved,
}: {
  statement: StatementRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  return (
    <Modal isOpen onClose={onClose} title={`تفسير الفرق — ${statement.reference}`}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError(null);
          try {
            await apiJson(`/api/finance/statements/${statement.id}`, {
              method: 'PATCH',
              body: JSON.stringify({ gapExplanation: text.trim() }),
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
        <p className="text-sm text-[var(--sys-foreground)]">
          الفرق بين ما أقرّته الشركة وما وصل: <b className="tabular-nums text-[var(--sys-destructive)]">{statement.gap.gap}</b>{' '}
          {statement.currencyCode}. اكتب سبب الفرق — بدونه لا يُعتمد الكشف.
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          required
          minLength={5}
          rows={3}
          className="w-full p-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
          placeholder="مثال: خصمت الشركة رسوم إرجاع شحنتين"
        />
        {error && <p className="text-sm text-[var(--sys-destructive)]">{error}</p>}
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="h-11 md:h-10 px-4 rounded-lg border border-[var(--sys-border)] text-sm">
            إلغاء
          </button>
          <button
            type="submit"
            disabled={saving}
            className="h-11 md:h-10 px-4 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-medium disabled:opacity-50"
          >
            حفظ التفسير
          </button>
        </div>
      </form>
    </Modal>
  );
}
