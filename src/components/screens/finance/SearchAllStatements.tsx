'use client';

import React, { useRef, useState } from 'react';
import { RiLoader4Line, RiSearchLine } from '@remixicon/react';
import { apiJson } from '@/lib/api-client';
import { Modal } from '@/components/ui/Modal';
import { Money } from '@/components/ui/Money';
import { ScanButton } from '@/components/scan/ScanButton';
import { useIsPhone } from '@/hooks/useIsPhone';
import { arDate } from '@/lib/format';
import {
  MIN_QUERY,
  NOT_IN_ANY_STATEMENT_AR,
  TOO_SHORT_AR,
  cleanQuery,
  type QueueKey,
  type StatementHit,
  type StatementSearchResponse,
} from '@/lib/statement-search-rules';

/**
 * «اعمل زر بحث داخل كل الكشوف» (the owner, 13/11, over the matching screen on his phone) — WHERE DID THIS PARCEL APPEAR?
 *
 * The box above each queue narrows the lines of the statement that is open. This button asks every statement of the store at
 * once — by our order number, the courier's barcode, the company's reference, and (for who may read customers' numbers) the
 * customer's name or phone — and lists every line that mentions it: which statement wrote it (the company, the date, the state
 * it is in), what the matching made of it, the answer if one was given, and the three figures. A press opens THAT statement on
 * the screen and puts the same word in the box of the group the line is in.
 *
 * The camera fills the same box a person types into, like every other screen's scan: a scan is a search, subject to exactly the
 * door's rules. A whole barcode is searched however short it is; a typed word needs three characters.
 *
 * It reads and decides nothing: the list, the count and the words are the server's (`/api/finance/statements/search`), and the
 * only thing this does with a line is hand the screen where to go. A statement the screen does not list (a draft, or older than
 * the hundred it reads) is shown but not offered to open — the answer is still true, and the way to it is named.
 */

/** Where the screen is asked to go: that statement, that group (null: the matching has not placed the line), that word. */
export interface OpenFromSearch {
  statementId: string;
  queue: QueueKey | null;
  word: string;
}

// Each kind of line wears the tone of the group it is drawn in on the matching screen; the tokens are that screen's own.
const TONE: Record<QueueKey, string> = {
  MATCHED: 'bg-[var(--sys-success-soft)] text-[var(--sys-success)] border-[var(--sys-success)]/40',
  MISMATCHED: 'bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)] border-[var(--sys-destructive-border)]',
  MISSING_IN_SYSTEM: 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] border-[var(--sys-warning)]/40',
  EXCLUDED: 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] border-[var(--sys-warning)]/40',
  MISSING_IN_STATEMENT: 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] border-[var(--sys-warning)]/40',
};
const NO_TONE = 'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)] border-[var(--sys-border)]';

// …and each state of a statement the tone the collection screen gives it.
const STATE_TONE: Record<string, string> = {
  APPROVED: 'bg-[var(--sys-success-soft)] text-[var(--sys-success)] border-[var(--sys-success)]/40',
  CLOSED: 'bg-[var(--sys-success-soft)] text-[var(--sys-success)] border-[var(--sys-success)]/40',
  RECEIPTED: 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] border-[var(--sys-warning)]/40',
};

function HitCard({ hit, openable }: { hit: StatementHit; openable: boolean }) {
  const s = hit.statement;
  const figures: [string, number | null][] = [
    ['المتوقَّع', hit.expected],
    ['بالكشف', hit.stated],
    ['الفرق', hit.difference],
  ];
  return (
    <>
      <span className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          <span dir="ltr">{s.reference}</span>
          {s.company && <> — {s.company}</>}
        </span>
        <span className={`text-xs px-2 py-1 rounded-sm border ${STATE_TONE[s.state] ?? NO_TONE}`}>{s.stateAr}</span>
      </span>
      <span className="block text-xs text-[var(--sys-muted-foreground)]">{arDate(s.at)}</span>
      <span className="mt-1 flex flex-wrap items-center gap-2">
        <span className={`text-xs px-2 py-1 rounded-full border ${hit.queue ? TONE[hit.queue] : NO_TONE}`}>{hit.resultAr}</span>
        {hit.answerAr && <span className="text-xs text-[var(--sys-muted-foreground)]">البتّ: {hit.answerAr}</span>}
      </span>
      {(hit.order || hit.barcode || hit.merchantRef) && (
        <span className="block text-xs text-[var(--sys-muted-foreground)]">
          {hit.order && (
            <>
              طلب <span dir="ltr">{hit.order.orderNumber}</span>
            </>
          )}
          {hit.barcode && (
            <>
              {hit.order ? ' · ' : ''}باركود <span dir="ltr">{hit.barcode}</span>
            </>
          )}
          {hit.merchantRef && (
            <>
              {hit.order || hit.barcode ? ' · ' : ''}مرجع الشركة <span dir="ltr">{hit.merchantRef}</span>
            </>
          )}
        </span>
      )}
      {figures.some(([, v]) => v !== null) && (
        <span className="flex flex-wrap gap-x-3 gap-y-0.5 pt-1 text-xs">
          {figures
            .filter(([, v]) => v !== null)
            .map(([k, v]) => (
              <span key={k}>
                {k} <Money value={v as number} currency={s.currencyCode} />
              </span>
            ))}
        </span>
      )}
      {!openable && (
        <span className="block pt-1 text-xs text-[var(--sys-warning)]">
          هذا الكشف مش بقائمة كشوف الشاشة — افتحه من «التحصيل والكشوف».
        </span>
      )}
    </>
  );
}

export function SearchAllStatements({
  maySeeContact,
  canOpen,
  onOpen,
}: {
  /** `customers.view`: only says what the box takes — the door holds the rule, whatever is sent. */
  maySeeContact: boolean;
  /** Does the screen list this statement (it reads the newest hundred that are not drafts)? Only those can be opened. */
  canOpen: (statementId: string) => boolean;
  onOpen: (to: OpenFromSearch) => void;
}) {
  const phone = useIsPhone();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  // The text in the box came from the camera and has not been touched since: a whole barcode, searched at any length.
  const [scanned, setScanned] = useState(false);
  const [answer, setAnswer] = useState<StatementSearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the latest question's answer is drawn: a slow earlier one that arrives late is dropped.
  const latest = useRef(0);

  const clean = cleanQuery(text);
  const ready = clean.length >= MIN_QUERY || (scanned && clean.length >= 1);

  const run = async (value: string, viaCamera: boolean) => {
    const q = cleanQuery(value);
    if (q.length < MIN_QUERY && !(viaCamera && q.length >= 1)) return;
    const mine = ++latest.current;
    setSearching(true);
    setError(null);
    try {
      const res = await apiJson<StatementSearchResponse>(
        `/api/finance/statements/search?q=${encodeURIComponent(q)}${viaCamera ? '&scan=1' : ''}`
      );
      if (mine === latest.current) setAnswer(res);
    } catch (e) {
      if (mine !== latest.current) return;
      setAnswer(null);
      setError(e instanceof Error ? e.message : 'تعذّر البحث');
    } finally {
      if (mine === latest.current) setSearching(false);
    }
  };

  const pick = (hit: StatementHit) => {
    setOpen(false);
    onOpen({ statementId: hit.statement.id, queue: hit.queue, word: answer?.q ?? clean });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`h-11 md:h-10 px-4 rounded-lg border border-[var(--sys-border)] text-sm text-[var(--sys-muted-foreground)] hover:text-[var(--sys-primary)] inline-flex items-center gap-2 ${
          phone ? 'w-full justify-center' : ''
        }`}
      >
        <RiSearchLine className="w-4 h-4" />
        بحث بكل الكشوف
      </button>

      {open && (
        <Modal isOpen onClose={() => setOpen(false)} title="بحث بكل الكشوف">
          <div className="space-y-3">
            <p className="text-xs text-[var(--sys-muted-foreground)]">
              {maySeeContact
                ? 'ابحث برقم الطلب أو الباركود أو مرجع الشركة أو اسم الزبون أو هاتفو — بكل كشوف المتجر.'
                : 'ابحث برقم الطلب أو الباركود أو مرجع الشركة — بكل كشوف المتجر.'}
            </p>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(text, scanned);
              }}
              className="space-y-2"
            >
              <label className="block">
                <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">البحث</span>
                <input
                  type="search"
                  dir="auto"
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    setScanned(false);
                  }}
                  placeholder={maySeeContact ? 'رقم طلب، باركود، مرجع، اسم أو هاتف' : 'رقم طلب، باركود أو مرجع'}
                  className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
                />
              </label>
              <div className="flex gap-2">
                {/* The camera fills the same box and the same request goes out: a scan is a search, under the door's own rules. */}
                <ScanButton
                  title="امسح بوليصة الشحنة — QR أو باركود"
                  onScan={(code) => {
                    setText(code);
                    setScanned(true);
                    void run(code, true);
                    return code;
                  }}
                  className="shrink-0 h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border)] text-sm text-[var(--sys-muted-foreground)] hover:text-[var(--sys-primary)] inline-flex items-center gap-1.5"
                />
                <button
                  type="submit"
                  disabled={!ready || searching}
                  className="flex-1 h-11 md:h-10 px-4 justify-center rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-medium inline-flex items-center gap-2 disabled:opacity-50"
                >
                  {searching ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiSearchLine className="w-4 h-4" />}
                  ابحث
                </button>
              </div>
            </form>

            {!ready && clean.length > 0 && <p className="text-xs text-[var(--sys-muted-foreground)]">{TOO_SHORT_AR}</p>}

            {error && (
              <div role="alert">
                <p className="text-sm text-[var(--sys-destructive)]">{error}</p>
              </div>
            )}

            {answer && (
              <div className="space-y-2">
                {answer.hits.length === 0 ? (
                  <p className="text-sm text-[var(--sys-muted-foreground)]">
                    «{answer.q}» {NOT_IN_ANY_STATEMENT_AR}.
                  </p>
                ) : (
                  <>
                    {/* The number the database counted, not the number drawn: they differ when the answer was cut. */}
                    <p className="text-sm font-medium text-[var(--sys-heading)]">
                      {answer.total > answer.hits.length
                        ? `معروض ${answer.hits.length} من ${answer.total} سطر — ضيّق البحث`
                        : `${answer.total} سطر`}
                    </p>
                    <ul className="space-y-2">
                      {answer.hits.map((hit, i) => {
                        const openable = canOpen(hit.statement.id);
                        return (
                          <li key={`${hit.statement.id}-${hit.matchId ?? hit.barcode ?? hit.merchantRef ?? i}-${i}`}>
                            {openable ? (
                              <button
                                type="button"
                                onClick={() => pick(hit)}
                                className="w-full text-right rounded-lg border p-3 text-sm border-[var(--sys-border)]"
                              >
                                <HitCard hit={hit} openable />
                              </button>
                            ) : (
                              <div className="rounded-lg border p-3 text-sm border-[var(--sys-border)]">
                                <HitCard hit={hit} openable={false} />
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
