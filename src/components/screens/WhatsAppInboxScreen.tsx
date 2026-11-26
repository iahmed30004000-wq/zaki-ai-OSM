'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useApp } from '@/context/AppContext';
import { screenApi as crmApi, qs } from '@/lib/screen-api';
import { routeLabel } from '@/lib/route-registry';
import { RiArrowRightSLine, RiChat3Line, RiCustomerService2Line, RiErrorWarningLine, RiPhoneLine, RiRefreshLine, RiSearchLine, RiSettings3Line, RiShieldFlashLine, RiShoppingBagLine, RiSparkling2Line, RiTimeLine, RiUserLine } from '@remixicon/react';
import { PageShell } from '@/components/ui/PageShell';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Card } from '@/components/ui/Card';
import { Segmented } from '@/components/ui/Segmented';
import { Money } from '@/components/ui/Money';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { userCan } from '@/lib/can';
import { FAST_POLL_MS, listSignature, paceFor } from '@/lib/inbox-pace';
import { WINDOW_CLOSED_MESSAGE } from '@/lib/whatsapp/service-window';
import { initials, latestStamp, listTime, mergeMessages, type WaBotAgent, type WaConversation as Conversation, type WaMessage as WMsg } from '@/components/whatsapp/chat-model';
import { Composer } from '@/components/whatsapp/Composer';
import { ThreadView } from '@/components/whatsapp/ThreadView';
import { KindIcon } from '@/components/whatsapp/KindIcon';
import { useFitToWindow } from '@/components/whatsapp/useFitToWindow';
import { WaStyle } from '@/components/whatsapp/WaStyle';
import { Modal } from '@/components/ui/Modal';

/** The bot's settings and practice chat are fetched the first time «البوت» is pressed — the inbox's first load does not carry them. */
const WhatsAppBotCard = React.lazy(() => import('@/components/settings/WhatsAppBotCard'));

const STATUS_COLORS: Record<string, string> = {
  CONNECTED: 'bg-[var(--sys-success-soft)] text-[var(--sys-success)]',
  NEEDS_SETUP: 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)]',
};

/** A sent file, through the same door rules as JSON: the refusal's Arabic words come back as the error. */
async function postForm(path: string, form: FormData): Promise<any> {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', body: form });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.errorAr || data?.error || 'تعذر إرسال الملف');
  return data;
}

function Avatar({ name, phone, size = 'md' }: { name: string | null; phone: string; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <div aria-hidden="true" className={`wa-av${size === 'md' ? '' : ` ${size}`}`}>
      {initials(name, phone)}
    </div>
  );
}

const NO_BOT: WaBotAgent = { active: false, name: 'سارة', avatarText: 'س' };

export function WhatsAppInboxScreen() {
  const { currentUser } = useApp();
  const [loading, setLoading] = useState(true);
  const [conn, setConn] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [statusFilter, setStatusFilter] = useState<'OPEN' | 'CLOSED'>('OPEN');
  const [search, setSearch] = useState('');

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<WMsg[]>([]);
  const [msgsLoading, setMsgsLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const [composing, setComposingState] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [retryText, setRetryText] = useState<string | null>(null);
  const [sendingTemplate, setSendingTemplate] = useState(false);

  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [assigning, setAssigning] = useState(false);
  const [recentOrders, setRecentOrders] = useState<any[]>([]);
  const [mobileView, setMobileView] = useState<'list' | 'chat'>('list');
  // The order bot: the company's (on, its name) and the press that gives a conversation back or stops it there.
  const [botAgent, setBotAgent] = useState<WaBotAgent>(NO_BOT);
  const [botBusy, setBotBusy] = useState(false);
  const [botOpen, setBotOpen] = useState(false);

  const canSend = userCan(currentUser, 'whatsapp.send');
  const canManage = userCan(currentUser, 'whatsapp.manage');
  const canAssign = userCan(currentUser, 'whatsapp.assign');
  const canView = userCan(currentUser, 'whatsapp.view');

  /*
   * Which conversation is open, readable from a callback that outlived the
   * render that created it: the 5-second poll and the guard that runs after
   * `loadMessages` awaits the network both need the CURRENT selection, not
   * the one that was open when their closure was built.
   *
   * The write lives in an effect. Assigned in the render body it was a write
   * a discarded render performed too — React may render this screen for a
   * selection it never commits, and the post-await guard would then throw
   * away the messages of the conversation that IS on screen, or keep the
   * messages of one that is not. After-commit is the only moment at which
   * this ref is allowed to mean "what the agent is looking at", and the
   * reads are all post-paint, so nothing about the timing changes.
   */
  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);
  // The messages on screen, for the poll's «what changed since» — read from a ref so the poll's callback stays one callback.
  const messagesRef = useRef<WMsg[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const inFlightRef = useRef(false);

  /*
   * DRAFTS: one per conversation, kept while the inbox is open — an answer half-typed to one customer is still there after
   * looking at another. In memory only, on purpose: a draft is words to a customer (an address, a price), and the browser's
   * storage keeps nothing about a customer (`exposure.test.ts`).
   */
  const draftsRef = useRef<Record<string, string>>({});
  const setComposing = useCallback((v: string) => {
    setComposingState(v);
    const id = selectedIdRef.current;
    if (!id) return;
    if (v) draftsRef.current[id] = v;
    else delete draftsRef.current[id];
  }, []);

  /*
   * HOW OFTEN TO ASK (RV182). Five seconds while anything is happening; fifteen after a quiet minute — the list not
   * moving and no message arriving. Anything the person does, a new message, a change in the list, or coming back to
   * the tab puts it back to five. The counter lives in a ref (it changes on every poll and must not re-render the
   * screen); only the pace is state, and setting it to the value it already has renders nothing.
   */
  const quietRef = useRef(0);
  const listSigRef = useRef('');
  const [pace, setPace] = useState(FAST_POLL_MS);
  const speedUp = useCallback(() => {
    quietRef.current = 0;
    setPace(FAST_POLL_MS);
  }, []);

  const loadConnection = useCallback(async () => {
    try {
      const d: any = await crmApi('/api/whatsapp/connection');
      setConn(d);
      setOffline(false);
      return d;
    } catch (e: any) {
      if (/network|fetch/i.test(String(e))) setOffline(true);
      setError(e.message || null);
      return null;
    }
  }, []);

  const loadConversations = useCallback(async (silent = false) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const d: any = await crmApi('/api/whatsapp/conversations' + qs({ status: statusFilter, q: search }));
      const list: Conversation[] = d.conversations || [];
      if (d.botAgent) setBotAgent(d.botAgent);
      setConversations((prev) => {
        // Preserve order/merge without flashing during silent polling
        if (silent && prev.length && list.length &&
            prev[0].id === list[0].id && prev.length === list.length &&
            prev.every((p, i) => p.unreadCount === list[i].unreadCount)) {
          return prev.map((p, i) => ({ ...p, ...list[i] }));
        }
        return list;
      });
      setOffline(false);
      setError(null);
      // A person's own request is activity; a silent poll is quiet only when the list did not move.
      const sig = listSignature(list);
      quietRef.current = silent && sig === listSigRef.current ? quietRef.current + 1 : 0;
      listSigRef.current = sig;
      setPace(paceFor(quietRef.current));
    } catch (e: any) {
      if (/network|fetch/i.test(String(e))) setOffline(true);
      if (!silent) setError(e.message || 'تعذر تحميل المحادثات');
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [statusFilter, search]);

  const markRead = (convId: string) => {
    crmApi(`/api/whatsapp/conversations/${convId}/read`, { method: 'POST' }).catch(() => {});
    setConversations((prev) => prev.map((c) => (c.id === convId ? { ...c, unreadCount: 0 } : c)));
  };

  const loadMessages = useCallback(async (convId: string, silent = false) => {
    if (silent && inFlightRef.current) return;
    if (silent) inFlightRef.current = true;
    try {
      // The poll asks for everything that CHANGED since the newest change on screen: new messages and ticks that moved.
      const since = silent ? latestStamp(messagesRef.current) : '';
      const d: any = await crmApi(`/api/whatsapp/conversations/${convId}` + qs({ since }));
      if (selectedIdRef.current !== convId) return;
      const conv = d.conversation;
      if (conv?.botAgent) setBotAgent(conv.botAgent);
      if (since) {
        // Only the first page knows whether older messages exist; a poll does not overwrite it.
        const rest = { ...conv };
        delete rest.hasOlder;
        setSelected((s) => ({ ...(s || conv), ...rest }));
        const incoming: WMsg[] = d.messages || [];
        const known = new Set(messagesRef.current.map((m) => m.id));
        const fresh = incoming.filter((m) => !known.has(m.id));
        // A new message or a tick that moved is activity: back to the fast pace.
        if ((d.messages || []).length > 0) speedUp();
        setMessages((prev) => mergeMessages(prev, incoming));
        if (fresh.some((m) => m.direction === 'INBOUND')) markRead(convId);
      } else {
        setSelected((s) => ({ ...(s || conv), ...conv }));
        setRecentOrders(d.recentOrders || []);
        setMessages(d.messages || []);
        if (conv.unreadCount > 0) {
          markRead(convId);
          setSelected((s) => (s ? { ...s, unreadCount: 0 } : s));
        }
      }
    } catch (e: any) {
      if (/network|fetch/i.test(String(e))) setOffline(true);
      if (!silent) setError(e.message || 'تعذر تحميل الرسائل');
    } finally {
      if (silent) inFlightRef.current = false;
      setMsgsLoading(false);
    }
  }, [speedUp]);

  const loadOlder = async () => {
    const convId = selectedIdRef.current;
    const first = messagesRef.current[0];
    if (!convId || !first || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const d: any = await crmApi(`/api/whatsapp/conversations/${convId}` + qs({ before: first.createdAt }));
      if (selectedIdRef.current !== convId) return;
      setMessages((prev) => mergeMessages(prev, d.messages || []));
      setSelected((s) => (s ? { ...s, hasOlder: Boolean(d.conversation?.hasOlder) } : s));
    } catch (e: any) {
      setSendError(e.message || 'تعذر تحميل الرسائل الأقدم');
    } finally {
      setLoadingOlder(false);
    }
  };

  // Initial load
  useEffect(() => {
    if (!canView) { setLoading(false); return; }
    (async () => {
      const c = await loadConnection();
      if (c?.status === 'CONNECTED') await loadConversations();
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * An inbox is the one screen where stale IS the bug, so it polls at
   * five seconds — and refreshes the moment the person comes back, or
   * the connection does.
   *
   * It refreshes TWO things: the list, and the conversation that is
   * open. A list that updates while the thread under it does not is the
   * same staleness wearing a fresher list.
   */
  useLiveRefresh(
    () => {
      if (!canView) return;
      loadConversations(true);
      if (selectedIdRef.current) loadMessages(selectedIdRef.current, true);
    },
    // Coming back to the tab puts the pace back to five seconds: the hook says when, the screen says what it means.
    { everyMs: pace, enabled: canView, onReturn: speedUp }
  );

  const selectConversation = (c: Conversation) => {
    speedUp();
    selectedIdRef.current = c.id;
    setSelectedId(c.id);
    setSelected(c);
    setMessages([]);
    messagesRef.current = [];
    setMsgsLoading(true);
    setSendError(null);
    setRetryText(null);
    setComposingState(draftsRef.current[c.id] || '');
    setMobileView('chat');
    loadMessages(c.id);
  };

  /** What a refusal means for the screen: a closed window is drawn as closed at once. */
  const refused = (e: any, fallback: string) => {
    const msg = e?.message || fallback;
    setSendError(msg);
    if (msg === WINDOW_CLOSED_MESSAGE) setSelected((s) => (s ? { ...s, windowOpen: false } : s));
    return msg;
  };

  const afterSent = (m: WMsg, preview: string, type: string) => {
    setMessages((prev) => mergeMessages(prev, [m]));
    // A person's message silences the bot here (the server wrote it in the same save): drawn at once, not on the next poll.
    const silenced = (c: Conversation): Conversation =>
      c.bot && !c.bot.paused ? { ...c, bot: { ...c.bot, paused: true, reason: 'STAFF_REPLIED', reasonAr: 'رد موظف', typing: false } } : c;
    setSelected((s) => (s ? silenced(s) : s));
    setConversations((prev) => prev.map((c) => c.id === selectedIdRef.current
      ? silenced({ ...c, lastMessagePreview: preview.slice(0, 120), lastMessageType: type, lastMessageAt: new Date().toISOString() }) : c));
  };

  /** «رجّع البوت» / «أوقف البوت» in the open conversation. */
  const setBot = async (action: 'pause' | 'resume') => {
    if (!selected || botBusy) return;
    setBotBusy(true);
    try {
      const d: any = await crmApi(`/api/whatsapp/conversations/${selected.id}/bot`, { method: 'POST', body: JSON.stringify({ action }) });
      if (d?.bot) {
        setSelected((s) => (s ? { ...s, bot: d.bot } : s));
        setConversations((prev) => prev.map((c) => (c.id === selected.id ? { ...c, bot: d.bot } : c)));
      }
    } catch (e: any) {
      setSendError(e.message || 'تعذّر تغيير حالة البوت');
    } finally {
      setBotBusy(false);
    }
  };

  const sendMessage = async () => {
    if (!selectedId || !composing.trim() || sending) return;
    speedUp();
    setSending(true); setSendError(null); setRetryText(null);
    const text = composing.trim();
    try {
      const d: any = await crmApi(`/api/whatsapp/conversations/${selectedId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
      afterSent(d.message, text, 'TEXT');
      setComposing('');
    } catch (e: any) {
      refused(e, 'تعذر إرسال الرسالة');
      setRetryText(text);
    } finally {
      setSending(false);
    }
  };

  const sendFile = async (file: File, kind: 'image' | 'file', caption: string): Promise<boolean> => {
    if (!selectedId || sending) return false;
    speedUp();
    setSending(true); setSendError(null); setRetryText(null);
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      form.append('kind', kind);
      if (caption) form.append('caption', caption);
      const d: any = await postForm(`/api/whatsapp/conversations/${selectedId}/media`, form);
      afterSent(d.message, caption || (kind === 'image' ? 'صورة' : file.name), d.message?.messageType || 'DOCUMENT');
      return true;
    } catch (e: any) {
      refused(e, 'تعذر إرسال الملف');
      return false;
    } finally {
      setSending(false);
    }
  };

  const react = async (messageId: string, emoji: string) => {
    if (!selectedId) return;
    speedUp();
    try {
      const d: any = await crmApi(`/api/whatsapp/conversations/${selectedId}/reactions`, {
        method: 'POST',
        body: JSON.stringify({ messageId, emoji }),
      });
      if (d?.message) setMessages((prev) => mergeMessages(prev, [d.message]));
    } catch (e: any) {
      refused(e, 'تعذر إرسال التفاعل');
    }
  };

  const sendTemplate = async () => {
    if (!selectedId || sendingTemplate) return;
    setSendingTemplate(true); setSendError(null);
    try {
      const d: any = await crmApi(`/api/whatsapp/conversations/${selectedId}/template`, { method: 'POST' });
      if (d?.message) afterSent(d.message, d.message.text || 'قالب', 'TEMPLATE');
    } catch (e: any) {
      refused(e, 'تعذر إرسال القالب');
    } finally {
      setSendingTemplate(false);
    }
  };

  const retrySend = async () => {
    if (!retryText) return;
    setComposing(retryText);
    setRetryText(null);
    setSendError(null);
    setTimeout(() => sendMessage(), 50);
  };

  const toggleStatus = async () => {
    if (!selected) return;
    const next = selected.status === 'OPEN' ? 'CLOSED' : 'OPEN';
    try {
      await crmApi(`/api/whatsapp/conversations/${selected.id}`, { method: 'PATCH', body: JSON.stringify({ status: next }) });
      setSelected({ ...selected, status: next });
      loadConversations(true);
    } catch (e: any) {
      setSendError(e.message || 'تعذر تغيير حالة المحادثة');
    }
  };

  const assign = async (userId: string | null) => {
    if (!selected) return;
    setAssigning(true);
    try {
      const d: any = await crmApi(`/api/whatsapp/conversations/${selected.id}/assign`, {
        method: 'POST', body: JSON.stringify({ userId }),
      });
      setSelected({ ...selected, assignedUserId: d.assignedUserId, assignedTo: d.assignedTo });
      loadConversations(true);
    } catch (e: any) {
      setSendError(e.message || 'تعذر التعيين');
    } finally {
      setAssigning(false);
    }
  };

  useEffect(() => {
    if (canAssign) {
      crmApi('/api/whatsapp/users').then((d: any) => setUsers(d.users || [])).catch(() => {});
    }
  }, [canAssign]);

  const columnRef = useRef<HTMLDivElement>(null);
  useFitToWindow(columnRef);

  const convCountByPhone = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of conversations) m[c.customerPhone] = (m[c.customerPhone] || 0) + 1;
    return m;
  }, [conversations]);

  // ─── Permission gate ───
  if (!canView) {
    return (
      <>
        <div className="p-8">
          <Card className="max-w-md mx-auto mt-20 text-center p-8">
            <RiShieldFlashLine className="w-6 h-6 mx-auto text-[var(--sys-primary)]" />
            <h2 className="mt-4 font-bold text-[var(--sys-heading)]">ليس لديك صلاحية لعرض واتساب</h2>
            <p className="mt-2 text-note text-[var(--sys-muted-foreground)]">تواصل مع مدير الشركة لمنحك صلاحية whatsapp.view</p>
          </Card>
        </div>
      </>
    );
  }

  const windowClosed = selected?.windowOpen === false;
  // A reaction is a free-form send: the send key, an open conversation and an open window.
  const mayReact = canSend && selected?.status === 'OPEN' && !windowClosed;
  // The order bot in the open conversation, drawn only when the company switched it on.
  const sBot = botAgent.active ? selected?.bot : undefined;
  const botSilent = Boolean(sBot && (sBot.paused || sBot.handoff));

  return (
    <>
      <WaStyle />
      {/* The window minus the header AS IT IS: the bar grows when it wraps, so a fixed 72 left the inbox
          taller than the window by the extra row and the page scrolled under it. */}
      <div ref={columnRef} className="wa flex flex-col" style={{ height: 'calc(100dvh - var(--sys-header-h, 72px))' }}>
        {/* The header is the kit's PageShell (R10e, 18/11). It is drawn WITHOUT children on purpose: the panes below
            must take the rest of this measured column (`flex-1`), and PageShell's own body is not a flex item —
            so the panes are its next sibling in the column, not its child. */}
        <PageShell
          title={routeLabel('/growth/whatsapp/inbox')}
          description="صندوق وارد مشترك لكل الموظفين — WhatsApp Business Cloud API"
          width="full"
          actions={
            <>
              <Button variant="secondary" size="sm" onClick={() => setBotOpen(true)}>
                <RiSparkling2Line className="w-4 h-4" />
                {botAgent.active ? `البوت: ${botAgent.name}` : 'بوت الطلبات'}
              </Button>
              {conn?.connection && (
                <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-note font-semibold ${STATUS_COLORS[conn.status] || STATUS_COLORS.NEEDS_SETUP}`}>
                  <span className={`w-2 h-2 rounded-full ${conn.status === 'CONNECTED' ? 'bg-[var(--sys-success)]' : 'bg-[var(--sys-warning)]'}`} />
                  {conn.status === 'CONNECTED' ? 'متصل' : 'يحتاج إعداد'}
                </span>
              )}
            </>
          }
        />
        <Modal isOpen={botOpen} onClose={() => setBotOpen(false)} title="بوت الطلبات على واتساب" maxWidth="4xl">
          {botOpen && (
            <React.Suspense fallback={<p className="p-6 text-center text-note text-[var(--sys-muted-foreground)]">جارٍ التحميل...</p>}>
              <WhatsAppBotCard embedded onSaved={(a) => setBotAgent(a)} />
            </React.Suspense>
          )}
        </Modal>

        {/* No connection state */}
        {!loading && conn && conn.status !== 'CONNECTED' ? (
          <div className="flex-1 flex items-center justify-center px-6">
            <Card className="text-center p-8 max-w-md">
              <div className="w-14 h-14 mx-auto rounded-full bg-[var(--sys-surface)] flex items-center justify-center">
                <RiChat3Line className="w-6 h-6 text-[var(--sys-muted-foreground)]" />
              </div>
              <h2 className="mt-4 font-bold text-[var(--sys-heading)]">لم يتم ربط WhatsApp بعد</h2>
              <p className="mt-2 text-note text-[var(--sys-muted-foreground)] leading-relaxed">
                {conn.envConfigured
                  ? 'تم إعداد البيانات لكن الاتصال غير مفعّل. جرّب إعادة الاتصال من الإعدادات.'
                  : 'متغيّرات البيئة على الخادم غير مكتملة. صفحةُ الإعداد تسرد المطلوبَ بأسمائه وخطواتِ التفعيل.'}
              </p>
              {canManage && (
                <Link href="/settings/links#whatsapp" className="mt-5 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-semibold hover:opacity-90">
                  <RiSettings3Line className="w-4 h-4" />
                  إعداد WhatsApp
                </Link>
              )}
            </Card>
          </div>
        ) : (
          /* 3-pane inbox */
          <div className="flex-1 min-h-0 px-4 md:px-6 pb-4 grid grid-cols-1 lg:grid-cols-[320px_1fr_300px] gap-4 overflow-hidden">
            {/* ── Column 1: conversations list ── */}
            <Card className={`wa-list flex flex-col min-h-0 overflow-hidden ${mobileView === 'chat' ? 'hidden lg:flex' : 'flex'}`}>
              <div className="p-3 border-b border-[var(--sys-border)] space-y-2">
                <div className="relative">
                  <RiSearchLine className="absolute top-1/2 -translate-y-1/2 start-3 w-4 h-4 text-[var(--sys-muted)] pointer-events-none" />
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && loadConversations()}
                    placeholder="بحث برقم أو اسم..."
                    aria-label="بحث في المحادثات"
                    className="wa-search w-full ps-9 pe-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--sys-primary)]/20"
                  />
                </div>
                <Segmented
                  size="sm"
                  aria-label="حالة المحادثات"
                  options={[
                    { value: 'OPEN', label: 'مفتوحة' },
                    { value: 'CLOSED', label: 'مغلقة' },
                  ]}
                  value={statusFilter}
                  onChange={(v) => setStatusFilter(v as 'OPEN' | 'CLOSED')}
                />
              </div>
              <div className="flex-1 overflow-y-auto min-h-0">
                {loading ? (
                  <div className="p-6 text-center text-note text-[var(--sys-muted-foreground)]">جارٍ التحميل...</div>
                ) : error && !offline ? (
                  <div className="p-4 m-3 rounded-lg bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] text-[var(--sys-destructive)] text-note flex flex-col gap-2">
                    <span className="flex items-center gap-1.5"><RiErrorWarningLine className="w-4 h-4" />{error}</span>
                    <Button variant="quiet" size="sm" onClick={() => { setError(null); loadConversations(); }} className="self-start">
                      <RiRefreshLine className="w-4 h-4" /> إعادة المحاولة
                    </Button>
                  </div>
                ) : offline ? (
                  <div className="p-4 m-3 rounded-lg bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)] text-[var(--sys-warning)] text-note">
                    لا يوجد اتصال بالشبكة — سيتم تحديث الصندوق تلقائيًا عند عودة الاتصال
                  </div>
                ) : conversations.length === 0 ? (
                  <div className="p-8 text-center text-note text-[var(--sys-muted-foreground)]">
                    {statusFilter === 'OPEN' ? 'لا توجد محادثات مفتوحة بعد' : 'لا توجد محادثات مغلقة'}
                  </div>
                ) : (
                  conversations.map((c) => {
                    const cBot = botAgent.active ? c.bot : undefined;
                    return (
                    <button key={c.id} onClick={() => selectConversation(c)}
                      aria-current={selectedId === c.id ? 'true' : undefined}
                      className="wa-row">
                      <Avatar name={c.customerName} phone={c.customerPhone} />
                      <div className="wa-row-body">
                        <div className="wa-row-top">
                          <span className="wa-name" dir="auto">{c.customerName || c.customerPhone}</span>
                          <span className={`wa-time${c.unreadCount > 0 ? ' unread' : ''}`}>{listTime(c.lastMessageAt)}</span>
                        </div>
                        <div className="wa-row-bottom">
                          {cBot?.typing ? (
                            <p className="wa-prev typing"><span>{botAgent.name} يكتب…</span></p>
                          ) : (
                            <p className="wa-prev">
                              <KindIcon type={c.lastMessageType} />
                              <span dir="auto">{c.lastMessagePreview || '—'}</span>
                            </p>
                          )}
                          <span className="wa-tags">
                            {cBot?.handoff ? (
                              <span className="wa-tag hand" title="الزبون بدّه موظف — البوت ساكت هون">
                                <RiCustomerService2Line className="w-4 h-4" aria-hidden="true" /> موظف
                              </span>
                            ) : cBot && !cBot.paused ? (
                              <span className="wa-tag bot" title={`${botAgent.name} شغّال بهالمحادثة`}>
                                <RiSparkling2Line className="w-4 h-4" aria-hidden="true" /> بوت
                              </span>
                            ) : null}
                            {c.unreadCount > 0 && (
                              <span aria-label={`${c.unreadCount} غير مقروءة`} className="wa-unread">{c.unreadCount}</span>
                            )}
                          </span>
                        </div>
                        {c.assignedTo && <p className="wa-sub">مُسندة إلى: {c.assignedTo.name}</p>}
                      </div>
                    </button>
                    );
                  })
                )}
              </div>
            </Card>

            {/* ── Column 2: conversation ── */}
            <Card className={`wa-pane overflow-hidden ${mobileView === 'list' ? 'hidden lg:flex' : 'flex'}`}>
              {!selected ? (
                <div className="wa-wall flex flex-col items-center justify-center gap-3 p-6 text-center">
                  <span className="wa-av lg">
                    <RiChat3Line className="w-6 h-6" />
                  </span>
                  <p className="text-sm font-semibold text-[var(--sys-heading)]">اختر محادثة لعرضها</p>
                  <p className="text-note text-[var(--sys-muted-foreground)] max-w-xs">الصور والرسائل الصوتية والملفات والمواقع تظهر هنا كما أرسلها الزبون.</p>
                </div>
              ) : (
                <>
                  <div className="wa-head">
                    <IconButton
                      size="sm"
                      className="lg:hidden shrink-0"
                      onClick={() => setMobileView('list')}
                      label="عد إلى المحادثات"
                    ><RiArrowRightSLine className="icon-mirror w-5 h-5" /></IconButton>
                    <Avatar name={selected.customerName} phone={selected.customerPhone} size="sm" />
                    <div className="flex-1 min-w-0">
                      <p className="wa-head-name" dir="auto">{selected.customerName || selected.customerPhone}</p>
                      <p className="wa-head-sub">
                        <span dir="ltr">{selected.customerPhone}</span>
                        {sBot && (
                          <>
                            <span aria-hidden="true">·</span>
                            {sBot.typing ? (
                              <span className="on">{botAgent.name} يكتب…</span>
                            ) : botSilent ? (
                              <span className="off">موقوف — {sBot.reasonAr || (sBot.handoff ? 'الزبون بدّه موظف' : 'رد موظف')}</span>
                            ) : (
                              <span className="bot"><RiSparkling2Line className="w-4 h-4" aria-hidden="true" /> {botAgent.name} شغّال</span>
                            )}
                          </>
                        )}
                      </p>
                    </div>
                    {windowClosed && (
                      <span className="hidden md:flex items-center gap-1 px-2 py-1 rounded-full bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] text-note font-semibold shrink-0" title={WINDOW_CLOSED_MESSAGE}>
                        <RiTimeLine className="w-4 h-4" /> نافذة الـ24 ساعة مغلقة
                      </span>
                    )}
                    {sBot && canSend && (
                      botSilent ? (
                        <Button variant="secondary" size="sm" onClick={() => { void setBot('resume'); }} loading={botBusy} className="shrink-0">
                          رجّع البوت
                        </Button>
                      ) : (
                        <Button variant="quiet" size="sm" onClick={() => { void setBot('pause'); }} loading={botBusy} className="shrink-0">
                          أوقف البوت
                        </Button>
                      )
                    )}
                    <Button variant="secondary" size="sm" onClick={toggleStatus} className="shrink-0">
                      {selected.status === 'OPEN' ? 'إغلاق المحادثة' : 'إعادة فتح'}
                    </Button>
                  </div>

                  {canAssign && (
                    <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--sys-border)] bg-[var(--sys-surface)]">
                      <span className="text-note text-[var(--sys-muted-foreground)] shrink-0">مُسندة إلى:</span>
                      <select
                        value={selected.assignedUserId || ''}
                        disabled={assigning}
                        onChange={(e) => assign(e.target.value || null)}
                        aria-label="إسناد المحادثة"
                        className="min-h-11 md:min-h-0 inline-flex items-center text-sm border border-[var(--sys-border-input)] rounded-lg px-2 py-1 bg-[var(--sys-card)] text-[var(--sys-heading)] focus:outline-none focus:ring-2 focus:ring-[var(--sys-primary)]/20"
                      >
                        <option value="">غير معين</option>
                        {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                      </select>
                    </div>
                  )}

                  {/* Messages */}
                  {msgsLoading ? (
                    <div className="wa-wall flex items-center justify-center text-note text-[var(--sys-muted-foreground)]">جارٍ التحميل...</div>
                  ) : messages.length === 0 ? (
                    <div className="wa-wall overflow-y-auto px-4 py-4">
                      <EmptyState
                        title="لا رسائل في هذه المحادثة"
                        why="المحادثة مفتوحة ولم يصل منها شيء بعد. رسائل واتساب لا تُسحب بأثرٍ رجعيّ — ما قبل الربط ليس هنا."
                      />
                    </div>
                  ) : (
                    <ThreadView
                      key={selected.id}
                      messages={messages}
                      hasOlder={Boolean(selected.hasOlder)}
                      loadingOlder={loadingOlder}
                      onLoadOlder={() => { void loadOlder(); }}
                      onReact={mayReact ? (id, e) => { void react(id, e); } : undefined}
                      botName={botAgent.name}
                      botTyping={Boolean(sBot?.typing)}
                    />
                  )}

                  {/* The customer asked for a person, or the bot stopped: say so where the reply is written. */}
                  {sBot?.handoff && (
                    <div className="wa-note" role="status">
                      <RiCustomerService2Line className="w-5 h-5" aria-hidden="true" />
                      <p>{sBot.reason === 'HANDOFF' ? 'الزبون طلب يحكي مع موظف' : `البوت وقف: ${sBot.reasonAr || 'راجع المحادثة'}`} — {botAgent.name} ساكت بهالمحادثة لحتى ترجّعوه.</p>
                      {canSend && (
                        <Button variant="secondary" size="sm" onClick={() => { void setBot('resume'); }} loading={botBusy} className="shrink-0">
                          رجّع البوت
                        </Button>
                      )}
                    </div>
                  )}

                  {/* Composer */}
                  {canSend && selected.status === 'OPEN' && (
                    <div className="wa-foot space-y-2">
                      {sendError && (
                        <div role="alert" className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] text-[var(--sys-destructive)] text-note">
                          <span className="flex items-center gap-1.5"><RiErrorWarningLine className="w-4 h-4 shrink-0" />{sendError}</span>
                          {retryText && (
                            <Button variant="quiet" size="sm" onClick={() => { void retrySend(); }} className="shrink-0">
                              <RiRefreshLine className="w-4 h-4" /> إعادة الإرسال
                            </Button>
                          )}
                        </div>
                      )}
                      {windowClosed ? (
                        <div className="flex flex-col sm:flex-row sm:items-center gap-2 px-3 py-2.5 rounded-lg bg-[var(--sys-warning-soft)] text-note text-[var(--sys-heading)]">
                          <RiTimeLine className="w-5 h-5 shrink-0 text-[var(--sys-warning)]" />
                          <span className="flex-1 leading-relaxed">{WINDOW_CLOSED_MESSAGE}</span>
                          {selected.templateReady ? (
                            <Button variant="primary" size="sm" onClick={() => { void sendTemplate(); }} loading={sendingTemplate} className="shrink-0 self-start">
                              إرسال القالب المعتمد
                            </Button>
                          ) : (
                            <span className="text-[var(--sys-muted-foreground)]">لا قالب مسمّى بعد — يسمّيه المدير من إعدادات «بعد لا يرد».</span>
                          )}
                        </div>
                      ) : (
                        <Composer
                          value={composing}
                          onChange={setComposing}
                          onSend={() => { void sendMessage(); }}
                          onSendFile={sendFile}
                          sending={sending}
                          onRefuse={(why) => setSendError(why)}
                        />
                      )}
                    </div>
                  )}
                  {selected.status === 'CLOSED' && (
                    <div className="wa-foot p-3 text-center text-note text-[var(--sys-muted-foreground)]">المحادثة مغلقة — أعد فتحها للإرسال</div>
                  )}
                  {!canSend && (
                    <div className="wa-foot p-3 text-center text-note text-[var(--sys-muted-foreground)]">ليس لديك صلاحية لإرسال الرسائل</div>
                  )}
                </>
              )}
            </Card>

            {/* ── Column 3: customer panel ── */}
            <Card className="overflow-y-auto min-h-0 hidden lg:block">
              {!selected ? (
                <div className="flex items-center justify-center h-full text-note text-[var(--sys-muted-foreground)]">لوحة العميل</div>
              ) : (
                <div className="p-4 space-y-5">
                  <div className="text-center">
                    <div className="flex justify-center"><Avatar name={selected.customerName} phone={selected.customerPhone} size="lg" /></div>
                    <p className="mt-2 font-bold text-sm text-[var(--sys-heading)]">{selected.customerName || 'عميل غير مرتبط'}</p>
                    <p className="text-note text-[var(--sys-muted-foreground)] flex items-center justify-center gap-1 mt-1" dir="ltr">
                      <RiPhoneLine className="w-4 h-4" /> {selected.customerPhone}
                    </p>
                  </div>

                  <div>
                    <p className="text-note font-bold text-[var(--sys-muted)] mb-2">المحادثات</p>
                    <p className="text-note text-[var(--sys-muted-foreground)]">{convCountByPhone[selected.customerPhone] || 1} محادثة (مفتوحة)</p>
                    {selected.customerId ? (
                      <Link href={`/customers?search=${encodeURIComponent(selected.customerPhone)}`} className="mt-2 inline-flex items-center gap-1 text-note font-semibold text-[var(--sys-primary)] hover:underline">
                        <RiUserLine className="w-4 h-4" /> فتح العميل
                      </Link>
                    ) : (
                      <p className="mt-2 text-note text-[var(--sys-muted)]">عميل غير مرتبط</p>
                    )}
                  </div>

                  <div>
                    <p className="text-note font-bold text-[var(--sys-muted)] mb-2">الطلبات الأخيرة</p>
                    {selected.customerId ? (
                      recentOrders.length === 0 ? (
                        <p className="text-note text-[var(--sys-muted-foreground)]">
                          لا طلبَ لهذا الرقم بعد — المحادثة سابقةٌ لأوّل طلب.
                        </p>
                      ) : (
                        <div className="space-y-1.5">
                          {recentOrders.map((o: any) => (
                            <Link key={o.id} href={`/orders/${o.id}`} className="flex items-center justify-between gap-2 p-2 rounded-lg bg-[var(--sys-surface)] hover:bg-[var(--sys-primary-soft)] text-note">
                              <span className="font-semibold text-[var(--sys-heading)]" dir="ltr">#{o.orderNumber}</span>
                              <span className="text-note text-[var(--sys-muted-foreground)]">{o.status}</span>
                              <span className="font-semibold text-[var(--sys-heading)]" dir="ltr"><Money value={o.totalAmount} currency={o.currency} /></span>
                            </Link>
                          ))}
                        </div>
                      )
                    ) : (
                      <p className="text-note text-[var(--sys-muted)] flex items-center gap-1"><RiShoppingBagLine className="w-4 h-4" /> لا يوجد عميل مرتبط</p>
                    )}
                  </div>
                </div>
              )}
            </Card>
          </div>
        )}
      </div>
    </>
  );
}
