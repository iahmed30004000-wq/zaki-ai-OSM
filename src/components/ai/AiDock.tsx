'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { RiCloseLine, RiDeleteBinLine, RiLoader4Line, RiRobot2Line, RiSendPlaneLine, RiSubtractLine } from '@remixicon/react';
import { useBulkActive } from '@/components/shell/BulkBar';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { arTime } from '@/lib/format';
import { useAppOptional } from '@/context/AppContext';
import { dockKey } from '@/lib/dock-memory';

/**
 * THE ASSISTANT, WHEREVER YOU ARE.
 *
 * It was a page. Which meant asking "how many orders are still waiting?"
 * cost you the screen you were working on, and the answer arrived somewhere
 * you then had to navigate back from — so the honest thing most people did
 * was not ask.
 *
 * A bubble in the corner instead. It lives in the shell layout, so moving
 * between screens does not unmount it and the conversation is still there
 * when you open it again. It never covers the page: it is a panel at the
 * corner with a real width, and it closes to a bubble.
 *
 * What it can see is decided entirely on the server. This sends a question
 * to /api/ai/chat and that route resolves the company, the store and the
 * user's permissions itself — nothing here widens anything, because a
 * client that could would be a client worth lying to.
 */

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  at: string;
}

/*
 * The conversation survives navigation and a reload, in this tab, for this
 * person only — kept under their id (dock-memory.ts) and forgotten on every
 * way out. The one shared key it used to be handed the last person's
 * conversation to whoever signed in next on the same tab.
 */
const LEGACY_KEY = 'zaki_ai_dock';

const OPENERS = [
  'كم طلب ينتظر التأكيد؟',
  'كيف كان أمس مقارنة بأول أمس؟',
  'أي منتج يرتجع أكثر من غيره؟',
];

/**
 * THE ASSISTANT, AND THE ROOM IT FLOATS OVER.
 *
 * The button is `fixed`, so it takes no space in the page — which is
 * exactly why it covers whatever the page ends with. Measured: a desk
 * leaves 24px under the last row and the button spans 16–64px from the
 * bottom edge, so on every list that ends in a pager (customers, orders,
 * returns) the «التالي» arrow, which sits on the same end of the row the
 * button is anchored to, was underneath it. «زر المساعد بغطي عليهم».
 *
 * The thing that floats reserves the room it floats over. Here, rather
 * than in the shell, for three reasons: it is only reserved for someone
 * who HAS the assistant (the layout mounts it for `ai.use` alone), it
 * can never drift from the button's own size because they live in one
 * file, and no page has to know there is anything in the corner.
 *
 * The room is the button's 48px plus a gap, 3.5rem. It is added to the
 * padding the page already keeps under its last row — 1.5rem on a desk,
 * the bottom strip's height on a phone — and both land clear of the
 * button's top edge. `the-assistant-clears-the-last-row` does that
 * arithmetic from the source, so enlarging the button or lifting it
 * fails a claim instead of covering a pager again.
 *
 * On a phone it yields with the button: while a selection owns the bottom
 * strip the button is hidden, and so is the room — that strip reserves
 * its own height.
 */
export function AiDock() {
  const yielding = useBulkActive();
  return (
    <>
      <div aria-hidden className={yielding ? 'hidden h-14 md:block' : 'h-14'} />
      <AiDockSurface />
    </>
  );
}

function AiDockSurface() {
  /**
   * While a selection is live the bottom strip belongs to the bar acting
   * on it, and this button sits exactly on top of that bar's last action.
   * Nobody asks the assistant a question in the middle of selecting thirty
   * orders to print.
   */
  const yielding = useBulkActive();
  const currentUser = useAppOptional()?.currentUser;
  const key = currentUser?.id ? dockKey(currentUser.id) : null;
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Restore what was being discussed. Session, not local: a question about
  // yesterday's numbers is not a question you want back next week.
  useEffect(() => {
    try {
      // The one shared key from before: whoever it belonged to, not this person.
      sessionStorage.removeItem(LEGACY_KEY);
      const saved = key ? sessionStorage.getItem(key) : null;
      setMsgs(saved ? JSON.parse(saved) : []);
    } catch {
      /* blocked storage is not a reason to have no assistant */
    }
  }, [key]);

  useEffect(() => {
    if (!key) return;
    try {
      sessionStorage.setItem(key, JSON.stringify(msgs.slice(-40)));
    } catch {
      /* ditto */
    }
  }, [key, msgs]);

  useEffect(() => {
    if (open) {
      endRef.current?.scrollIntoView({ block: 'end' });
      inputRef.current?.focus();
    }
  }, [open, msgs.length]);

  // Escape closes it, because every panel in every app does.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  async function ask(text?: string) {
    const question = (text ?? q).trim();
    if (!question || busy) return;

    const at = arTime(new Date());
    setMsgs((m) => [...m, { role: 'user', content: question, at }]);
    setQ('');
    setBusy(true);
    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, period: 'all' }),
      });
      const json = await res.json().catch(() => ({}));
      setMsgs((m) => [
        ...m,
        {
          role: 'assistant',
          content: res.ok
            ? json.answer || 'لم يصل جواب.'
            : json.error || 'تعذر الوصول إلى المساعد. تأكد من إعداده في الإعدادات.',
          at: arTime(new Date()),
        },
      ]);
    } catch {
      setMsgs((m) => [
        ...m,
        { role: 'assistant', content: 'تعذر الاتصال. تحقق من الإنترنت.', at },
      ]);
    } finally {
      setBusy(false);
    }
  }

  /*
   * THE ONE PRESS HERE THAT STAYS A RAW BUTTON (18/11, R17b — for R19's allowed list).
   *
   * The bubble is a round 48px control pinned to the corner. The kit's square is 40 or 44
   * and is positioned in the flow; laid over this one it would fight the corner, the size
   * and the fill on stylesheet order. And its size is a measured fact: the room under the
   * page is computed from THIS class string (`the-assistant-clears-the-last-row`).
   */
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="المساعد الذكي"
        aria-label="افتح المساعد الذكي"
        /**
         * ABOVE THE PHONE'S NAV BAR, NOT ON TOP OF IT.
         *
         * `bottom-4` put a 48px button between 16px and 64px from the
         * bottom. The mobile bar occupies 0–56px and sits at `z-30`, so
         * this landed ON «المزيد» — the last item, on the same side the
         * dock is anchored to. Reported as exactly that.
         *
         * The lift is the bar's own height plus the home indicator, the
         * same expression the bar uses for its padding, so the two cannot
         * drift apart. A desk has no bar, so it keeps `bottom-4`.
         */
        style={{ bottom: 'calc(var(--sys-mobile-nav-h) + env(safe-area-inset-bottom) + 0.75rem)' }}
        className={`fixed end-4 z-40 h-12 w-12 items-center justify-center rounded-full bg-[var(--sys-heading)] text-[var(--sys-primary-foreground)] shadow-overlay transition hover:bg-[var(--sys-heading)] active:scale-95 md:!bottom-4 ${
          yielding ? 'hidden md:flex' : 'flex'
        }`}
      >
        <RiRobot2Line className="h-5 w-5" />
        {/* A quiet mark that there is something to come back to. */}
        {msgs.length > 0 && (
          <span className="absolute -end-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-[var(--sys-card)] bg-[var(--sys-primary)]" />
        )}
      </button>
    );
  }

  return (
    <div
      dir="rtl"
      // A panel, not an overlay. It has a width and a height and sits in
      // the corner — the CRM behind it stays readable and clickable, which
      // is the whole difference between an assistant and an interruption.
      /* The open panel clears the bar for the same reason the button does. */
      style={{ bottom: 'calc(var(--sys-mobile-nav-h) + env(safe-area-inset-bottom) + 0.75rem)' }}
      className="fixed end-4 z-40 flex h-[min(32rem,calc(100vh-8rem))] w-[min(22rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] shadow-overlay md:!bottom-4 md:h-[min(32rem,calc(100vh-2rem))]"
    >
      {/*
        18/11 (R17b): the header wore the heading colour as a fill, with its own
        pale buttons — the one dark bar in the product. It is the card's own
        header now, and its three presses are the kit's `IconButton` (same
        names, same tooltips, a 44px square on a phone as before).
      */}
      <header className="flex items-center justify-between border-b border-[var(--sys-border)] px-3 py-2">
        <span className="flex items-center gap-2 text-sm font-semibold text-[var(--sys-heading)]">
          <RiRobot2Line className="h-4 w-4" /> المساعد الذكي
        </span>
        <span className="flex items-center gap-0.5">
          {/* The full page of this same chat. It is not a menu line any more: the bubble is
              the assistant, and this is how it opens wide. */}
          <Link
            href="/assistant"
            className="rounded-lg px-2 text-note font-medium text-[var(--sys-primary)] hover:underline"
          >
            افتح كاملاً
          </Link>
          {msgs.length > 0 && (
            <IconButton size="sm" label="ابدأ محادثة جديدة" onClick={() => setMsgs([])}>
              <RiDeleteBinLine className="h-4 w-4" />
            </IconButton>
          )}
          <IconButton size="sm" label="تصغير" onClick={() => setOpen(false)}>
            <RiSubtractLine className="h-4 w-4" />
          </IconButton>
          <IconButton size="sm" label="إغلاق ومسح" onClick={() => { setMsgs([]); setOpen(false); }}>
            <RiCloseLine className="h-4 w-4" />
          </IconButton>
        </span>
      </header>

      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {msgs.length === 0 ? (
          <div className="pt-4 text-center">
            <RiRobot2Line className="mx-auto h-6 w-6 text-[var(--sys-border-strong)]" />
            <p className="mt-2 text-sm font-semibold text-[var(--sys-foreground)]">اسأل عن أرقامك</p>
            <p className="mx-auto mt-1 max-w-[16rem] text-note text-[var(--sys-muted)]">
              يرى بيانات هذا المتجر وحده، وبحدود صلاحياتك.
            </p>
            <div className="mt-3 space-y-1.5">
              {/* `ask` keeps its own `busy` flag, so the press is fire-and-forget: the kit's
                  promise lock is not a second one stacked on it. */}
              {OPENERS.map((o) => (
                <Button key={o} variant="secondary" size="sm" className="w-full" onClick={() => { void ask(o); }}>
                  {o}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          msgs.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-start' : 'justify-end'}`}>
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed ${
                  m.role === 'user'
                    ? 'bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)]'
                    : 'bg-[var(--sys-surface-strong)] text-[var(--sys-heading)]'
                }`}
              >
                <p className="whitespace-pre-wrap">{m.content}</p>
                <p className={`mt-0.5 text-note ${m.role === 'user' ? 'text-[var(--sys-primary-foreground)]/60' : 'text-[var(--sys-muted)]'}`}>
                  {m.at}
                </p>
              </div>
            </div>
          ))
        )}
        {busy && (
          <div className="flex justify-end">
            <span className="flex items-center gap-1 rounded-lg bg-[var(--sys-surface-strong)] px-3 py-2 text-note text-[var(--sys-muted-foreground)]">
              <RiLoader4Line className="h-4 w-4 animate-spin" /> يقرأ أرقامك…
            </span>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); void ask(); }}
        className="flex items-center gap-1.5 border-t border-[var(--sys-border)] p-2"
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="اكتب سؤالك…"
          className="min-h-11 md:min-h-0 inline-flex items-center flex-1 rounded-lg border border-[var(--sys-border-input)] px-2.5 py-1.5 text-sm text-[var(--sys-heading)] outline-none focus:border-[var(--sys-primary)]"
        />
        <IconButton type="submit" variant="primary" size="sm" label="إرسال" disabled={busy || !q.trim()}>
          <RiSendPlaneLine className="icon-mirror h-4 w-4" />
        </IconButton>
      </form>
    </div>
  );
}
