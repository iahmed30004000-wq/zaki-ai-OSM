'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useApp } from '@/context/AppContext';
import { screenApi as crmApi, qs } from '@/lib/screen-api';
import { findRoute, routeLabel } from '@/lib/route-registry';
import { RiArrowRightSLine, RiChat3Line, RiCheckDoubleLine, RiCheckLine, RiCloseLine, RiErrorWarningLine, RiPhoneLine, RiRefreshLine, RiSearchLine, RiSendPlaneLine, RiSettings3Line, RiShieldFlashLine, RiShoppingBagLine, RiUserLine } from '@remixicon/react';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { arTime } from '@/lib/format';
import { Money } from '@/components/ui/Money';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { userCan } from '@/lib/can';
import { FAST_POLL_MS, listSignature, paceFor } from '@/lib/inbox-pace';

interface Conversation {
  id: string;
  customerPhone: string;
  customerName: string | null;
  status: string;
  unreadCount: number;
  lastMessageAt: string | null;
  lastMessagePreview?: string | null;
  assignedUserId?: string | null;
  assignedTo?: { id: string; name: string } | null;
  customerId?: string | null;
  customer?: { id: string; fullName: string; phone: string; rawPhone?: string; city?: string } | null;
}

interface WMsg {
  id: string;
  direction: string;
  messageType: string;
  text: string | null;
  status: string;
  createdAt: string;
}

const STATUS_COLORS: Record<string, string> = {
  CONNECTED: 'bg-[var(--sys-success-soft)] text-[var(--sys-success)]',
  NEEDS_SETUP: 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)]',
};

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

  const [composing, setComposing] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [retryText, setRetryText] = useState<string | null>(null);

  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [assigning, setAssigning] = useState(false);
  const [recentOrders, setRecentOrders] = useState<any[]>([]);
  const [mobileView, setMobileView] = useState<'list' | 'chat'>('list');

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
  const inFlightRef = useRef(false);

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
  useEffect(() => {
    const back = () => {
      if (!document.hidden) speedUp();
    };
    document.addEventListener('visibilitychange', back);
    window.addEventListener('focus', back);
    return () => {
      document.removeEventListener('visibilitychange', back);
      window.removeEventListener('focus', back);
    };
  }, [speedUp]);

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

  const loadMessages = useCallback(async (convId: string, silent = false) => {
    if (silent && inFlightRef.current) return;
    if (silent) inFlightRef.current = true;
    try {
      const after = silent && messages.length ? messages[messages.length - 1].createdAt : '';
      const d: any = await crmApi(`/api/whatsapp/conversations/${convId}` + qs({ after }));
      if (selectedIdRef.current !== convId) return;
      const conv = d.conversation;
      setSelected((s) => ({ ...(s || conv), ...conv }));
      if (!after) setRecentOrders(d.recentOrders || []);
      if (after) {
        if ((d.messages || []).length > 0) speedUp();
        setMessages((prev) => {
          const known = new Set(prev.map((m) => m.id));
          return [...prev, ...(d.messages || []).filter((m: WMsg) => !known.has(m.id))];
        });
        const hasNewInbound = (d.messages || []).some((m: WMsg) => m.direction === 'INBOUND');
        if (hasNewInbound) {
          crmApi(`/api/whatsapp/conversations/${convId}/read`, { method: 'POST' }).catch(() => {});
        }
      } else {
        setMessages(d.messages || []);
        if (conv.unreadCount > 0) {
          crmApi(`/api/whatsapp/conversations/${convId}/read`, { method: 'POST' }).catch(() => {});
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

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
   * These lines were the third hand-written copy of that idea (the
   * dashboard and the orders list had the other two). They are the one
   * hook now, and the `online` listener that only this screen had is in
   * it for every screen.
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
    { everyMs: pace, enabled: canView }
  );

  const selectConversation = (c: Conversation) => {
    speedUp();
    setSelectedId(c.id);
    setSelected(c);
    setMessages([]);
    setMsgsLoading(true);
    setSendError(null);
    setRetryText(null);
    setMobileView('chat');
    loadMessages(c.id);
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
      setMessages((prev) => [...prev, d.message]);
      setComposing('');
      setConversations((prev) => prev.map((c) => c.id === selectedId
        ? { ...c, lastMessagePreview: text.slice(0, 120), lastMessageAt: new Date().toISOString() } : c));
    } catch (e: any) {
      setSendError(e.message || 'تعذر إرسال الرسالة');
      setRetryText(text);
    } finally {
      setSending(false);
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

  const connected = conn?.status === 'CONNECTED';
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
          <div className="max-w-md mx-auto mt-20 text-center p-8 bg-[var(--sys-card)] rounded-lg border border-[var(--sys-border)]">
            <RiShieldFlashLine className="w-6 h-6 mx-auto text-[var(--sys-primary)]" />
            <h2 className="mt-4 font-bold text-[var(--sys-heading)]">ليس لديك صلاحية لعرض واتساب</h2>
            <p className="mt-2 text-xs text-[var(--sys-muted-foreground)]">تواصل مع مدير الشركة لمنحك صلاحية whatsapp.view</p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {/* The window minus the header AS IT IS: the bar grows when it wraps, so a fixed 72 left the inbox
          taller than the window by the extra row and the page scrolled under it. */}
      <div className="flex flex-col" style={{ height: 'calc(100dvh - var(--sys-header-h, 72px))' }}>
        {/* Header */}
        <PageHeader title={routeLabel('/growth/whatsapp/inbox')}
            description="صندوق وارد مشترك لكل الموظفين — WhatsApp Business Cloud API"
            actions={
              <>{conn?.connection && (
            <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold ${STATUS_COLORS[conn.status] || STATUS_COLORS.NEEDS_SETUP}`}>
              <span className={`w-2 h-2 rounded-full ${conn.status === 'CONNECTED' ? 'bg-[var(--sys-success)]' : 'bg-[var(--sys-warning)]'}`} />
              {conn.status === 'CONNECTED' ? 'متصل' : 'يحتاج إعداد'}
            </span>
          )}</>
            }
          />

        {/* No connection state */}
        {!loading && conn && conn.status !== 'CONNECTED' ? (
          <div className="flex-1 flex items-center justify-center px-6">
            <div className="text-center p-8 bg-[var(--sys-card)] rounded-lg border border-[var(--sys-border)] max-w-md">
              <div className="w-14 h-14 mx-auto rounded-full bg-[var(--sys-surface)] flex items-center justify-center">
                <RiChat3Line className="w-6 h-6 text-[var(--sys-muted-foreground)]" />
              </div>
              <h2 className="mt-4 font-bold text-[var(--sys-heading)]">لم يتم ربط WhatsApp بعد</h2>
              <p className="mt-2 text-xs text-[var(--sys-muted-foreground)] leading-relaxed">
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
            </div>
          </div>
        ) : (
          /* 3-pane inbox */
          <div className="flex-1 min-h-0 px-4 md:px-6 pb-4 grid grid-cols-1 lg:grid-cols-[320px_1fr_300px] gap-4 overflow-hidden">
            {/* ── Column 1: conversations list ── */}
            <div className={`bg-[var(--sys-card)] rounded-lg border border-[var(--sys-border)] flex flex-col min-h-0 ${mobileView === 'chat' ? 'hidden lg:flex' : 'flex'}`}>
              <div className="p-3 border-b border-[var(--sys-surface-strong)] space-y-2">
                <div className="relative">
                  <RiSearchLine className="absolute top-2.5 left-3 w-4 h-4 text-[var(--sys-muted)] rtl:right-3 rtl:left-auto" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && loadConversations()}
                    placeholder="بحث برقم أو اسم..."
                    className="w-full pl-9 rtl:pr-9 rtl:pl-3 py-2 text-xs rounded-lg border border-[var(--sys-border-input)] focus:outline-none focus:ring-2 focus:ring-[var(--sys-primary)]/20"
                  />
                </div>
                <div className="flex gap-1 text-xs font-semibold">
                  {(['OPEN', 'CLOSED'] as const).map((s) => (
                    <button key={s} onClick={() => setStatusFilter(s)}
                      className={`min-h-11 md:min-h-0 inline-flex items-center px-3 py-1 rounded-full ${statusFilter === s ? 'bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)]' : 'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)]'}`}>
                      {s === 'OPEN' ? 'مفتوحة' : 'مغلقة'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex-1 overflow-y-auto min-h-0">
                {loading ? (
                  <div className="p-6 text-center text-xs text-[var(--sys-muted-foreground)]">جارٍ التحميل...</div>
                ) : error && !offline ? (
                  <div className="p-4 m-3 rounded-lg bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] text-[var(--sys-destructive)] text-xs flex flex-col gap-2">
                    <span className="flex items-center gap-1.5"><RiErrorWarningLine className="w-4 h-4" />{error}</span>
                    <button onClick={() => { setError(null); loadConversations(); }} className="inline-flex items-center gap-1 text-[var(--sys-heading)] font-semibold">
                      <RiRefreshLine className="w-4 h-4" /> إعادة المحاولة
                    </button>
                  </div>
                ) : offline ? (
                  <div className="p-4 m-3 rounded-lg bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)] text-[var(--sys-warning)] text-xs">
                    لا يوجد اتصال بالشبكة — سيتم تحديث الصندوق تلقائيًا عند عودة الاتصال
                  </div>
                ) : conversations.length === 0 ? (
                  <div className="p-8 text-center text-xs text-[var(--sys-muted-foreground)]">
                    {statusFilter === 'OPEN' ? 'لا توجد محادثات مفتوحة بعد' : 'لا توجد محادثات مغلقة'}
                  </div>
                ) : (
                  conversations.map((c) => (
                    <button key={c.id} onClick={() => selectConversation(c)}
                      className={`w-full text-right flex items-start gap-3 px-4 py-3 border-b border-[var(--sys-surface)] hover:bg-[var(--sys-surface)] transition-colors ${selectedId === c.id ? 'bg-[var(--sys-primary-soft)]' : ''}`}>
                      <div className="w-10 h-10 rounded-full bg-[var(--sys-heading)] text-[var(--sys-primary-foreground)] flex items-center justify-center shrink-0 text-sm font-bold">
                        {(c.customerName || c.customerPhone).slice(0, 2)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-[var(--sys-heading)] truncate">{c.customerName || c.customerPhone}</span>
                          {c.unreadCount > 0 && (
                            <span className="shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-xs font-bold flex items-center justify-center">{c.unreadCount}</span>
                          )}
                        </div>
                        <p className="text-xs text-[var(--sys-muted-foreground)] truncate mt-0.5">{c.lastMessagePreview || '—'}</p>
                        {c.assignedTo && <p className="text-xs text-[var(--sys-muted)] mt-0.5">مُسندة إلى: {c.assignedTo.name}</p>}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>

            {/* ── Column 2: conversation ── */}
            <div className={`bg-[var(--sys-card)] rounded-lg border border-[var(--sys-border)] flex flex-col min-h-0 ${mobileView === 'list' ? 'hidden lg:flex' : 'flex'}`}>
              {!selected ? (
                <div className="flex-1 flex items-center justify-center text-xs text-[var(--sys-muted-foreground)]">اختر محادثة لعرضها</div>
              ) : (
                <>
                  <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--sys-surface-strong)]">
                    <button
                      className="lg:hidden text-[var(--sys-muted-foreground)]"
                      onClick={() => setMobileView('list')}
                      aria-label="عد إلى المحادثات"
                      title="عد إلى المحادثات"
                    ><RiArrowRightSLine className="icon-mirror w-5 h-5" /></button>
                    <div className="w-9 h-9 rounded-full bg-[var(--sys-heading)] text-[var(--sys-primary-foreground)] flex items-center justify-center text-xs font-bold">
                      {(selected.customerName || selected.customerPhone).slice(0, 2)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-[var(--sys-heading)] truncate">{selected.customerName || selected.customerPhone}</p>
                      <p className="text-xs text-[var(--sys-muted-foreground)] truncate" dir="ltr">{selected.customerPhone}</p>
                    </div>
                    <button onClick={toggleStatus}
                      className={`min-h-11 md:min-h-0 inline-flex items-center shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold ${selected.status === 'OPEN' ? 'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-destructive-soft)] hover:text-[var(--sys-destructive)]' : 'bg-[var(--sys-success-soft)] text-[var(--sys-success)]'}`}>
                      {selected.status === 'OPEN' ? 'إغلاق المحادثة' : 'إعادة فتح'}
                    </button>
                  </div>

                  {canAssign && (
                    <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--sys-surface)] bg-[var(--sys-surface)]">
                      <span className="text-xs text-[var(--sys-muted-foreground)] shrink-0">مُسندة إلى:</span>
                      <select
                        value={selected.assignedUserId || ''}
                        disabled={assigning}
                        onChange={(e) => assign(e.target.value || null)}
                        className="min-h-11 md:min-h-0 inline-flex items-center text-xs border border-[var(--sys-border-input)] rounded-lg px-2 py-1 bg-[var(--sys-card)] focus:outline-none focus:ring-2 focus:ring-[var(--sys-primary)]/20"
                      >
                        <option value="">غير معين</option>
                        {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                      </select>
                    </div>
                  )}

                  {/* Messages */}
                  <div className="flex-1 overflow-y-auto min-h-0 px-4 py-4 space-y-2 bg-[var(--sys-surface)]" dir="ltr">
                    {msgsLoading ? (
                      <div className="text-center text-xs text-[var(--sys-muted-foreground)] py-8">جارٍ التحميل...</div>
                    ) : messages.length === 0 ? (
                      <EmptyState
                        title="لا رسائل في هذه المحادثة"
                        why="المحادثة مفتوحة ولم يصل منها شيء بعد. رسائل واتساب لا تُسحب بأثرٍ رجعيّ — ما قبل الربط ليس هنا."
                      />
                    ) : (
                      messages.map((m) => (
                        <div key={m.id} className={`flex ${m.direction === 'OUTBOUND' ? 'justify-end' : 'justify-start'}`}>
                          <div className={`max-w-[75%] rounded-lg px-3.5 py-2 text-sm shadow-raised ${m.direction === 'OUTBOUND' ? 'bg-[#d9fdd3] text-[var(--sys-heading)]' : 'bg-[var(--sys-card)] text-[var(--sys-heading)] border border-[#eef1f5]'}`}>
                            {m.messageType !== 'TEXT' && !m.text && (
                              <span className="text-xs font-semibold text-[var(--sys-muted-foreground)]">[{m.messageType}]</span>
                            )}
                            <p className="whitespace-pre-wrap break-words" dir="auto">{m.text || ''}</p>
                            <div className="flex items-center gap-1 justify-end mt-0.5">
                              <span className="text-xs text-[var(--sys-muted)]">{arTime(m.createdAt)}</span>
                              {m.direction === 'OUTBOUND' && (
                                m.status === 'READ' ? <RiCheckDoubleLine className="w-4 h-4 text-[#53bdeb]" />
                                : m.status === 'FAILED' ? <RiCloseLine className="w-4 h-4 text-[var(--sys-destructive)]" />
                                : <RiCheckLine className="w-4 h-4 text-[var(--sys-muted)]" />
                              )}
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  {/* Composer */}
                  {canSend && selected.status === 'OPEN' && (
                    <div className="border-t border-[var(--sys-surface-strong)] p-3 space-y-2">
                      {sendError && (
                        <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] text-[var(--sys-destructive)] text-xs">
                          <span className="flex items-center gap-1.5"><RiErrorWarningLine className="w-4 h-4 shrink-0" />{sendError}</span>
                          {retryText && (
                            <button onClick={retrySend} className="shrink-0 inline-flex items-center gap-1 font-semibold text-[var(--sys-heading)]">
                              <RiRefreshLine className="w-4 h-4" /> إعادة الإرسال
                            </button>
                          )}
                        </div>
                      )}
                      <div className="flex items-end gap-2">
                        <textarea
                          value={composing}
                          onChange={(e) => setComposing(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
                          }}
                          rows={1}
                          placeholder="اكتب رسالة..."
                          className="flex-1 resize-none max-h-32 px-3 py-2.5 text-sm rounded-lg border border-[var(--sys-border-input)] focus:outline-none focus:ring-2 focus:ring-[var(--sys-primary)]/20"
                        />
                        <button onClick={sendMessage} disabled={sending || !composing.trim()}
                          className="shrink-0 w-10 h-11 md:h-10 rounded-full bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] flex items-center justify-center disabled:opacity-40 hover:opacity-90">
                          {sending ? <RiRefreshLine className="w-4 h-4 animate-spin" /> : <RiSendPlaneLine className="icon-mirror w-4 h-4" />}
                        </button>
                      </div>
                    </div>
                  )}
                  {selected.status === 'CLOSED' && (
                    <div className="border-t border-[var(--sys-surface-strong)] p-3 text-center text-xs text-[var(--sys-muted-foreground)]">المحادثة مغلقة — أعد فتحها للإرسال</div>
                  )}
                  {!canSend && (
                    <div className="border-t border-[var(--sys-surface-strong)] p-3 text-center text-xs text-[var(--sys-muted-foreground)]">ليس لديك صلاحية لإرسال الرسائل</div>
                  )}
                </>
              )}
            </div>

            {/* ── Column 3: customer panel ── */}
            <div className={`bg-[var(--sys-card)] rounded-lg border border-[var(--sys-border)] overflow-y-auto min-h-0 hidden lg:block`}>
              {!selected ? (
                <div className="flex items-center justify-center h-full text-xs text-[var(--sys-muted-foreground)]">لوحة العميل</div>
              ) : (
                <div className="p-4 space-y-5">
                  <div className="text-center">
                    <div className="w-16 h-16 mx-auto rounded-full bg-[var(--sys-heading)] text-[var(--sys-primary-foreground)] flex items-center justify-center text-lg font-bold">
                      {(selected.customerName || selected.customerPhone).slice(0, 2)}
                    </div>
                    <p className="mt-2 font-bold text-sm text-[var(--sys-heading)]">{selected.customerName || 'عميل غير مرتبط'}</p>
                    <p className="text-xs text-[var(--sys-muted-foreground)] flex items-center justify-center gap-1 mt-1" dir="ltr">
                      <RiPhoneLine className="w-4 h-4" /> {selected.customerPhone}
                    </p>
                  </div>

                  <div>
                    <p className="text-xs font-bold text-[var(--sys-muted)] mb-2">المحادثات</p>
                    <p className="text-xs text-[var(--sys-muted-foreground)]">{convCountByPhone[selected.customerPhone] || 1} محادثة (مفتوحة)</p>
                    {selected.customerId ? (
                      <Link href={`/customers?search=${encodeURIComponent(selected.customerPhone)}`} className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[var(--sys-primary)] hover:underline">
                        <RiUserLine className="w-4 h-4" /> فتح العميل
                      </Link>
                    ) : (
                      <p className="mt-2 text-xs text-[var(--sys-muted)]">عميل غير مرتبط</p>
                    )}
                  </div>

                  <div>
                    <p className="text-xs font-bold text-[var(--sys-muted)] mb-2">الطلبات الأخيرة</p>
                    {selected.customerId ? (
                      recentOrders.length === 0 ? (
                        <p className="text-xs text-[var(--sys-muted-foreground)]">
                          لا طلبَ لهذا الرقم بعد — المحادثة سابقةٌ لأوّل طلب.
                        </p>
                      ) : (
                        <div className="space-y-1.5">
                          {recentOrders.map((o: any) => (
                            <Link key={o.id} href={`/orders/${o.id}`} className="flex items-center justify-between gap-2 p-2 rounded-lg bg-[var(--sys-surface)] hover:bg-[var(--sys-primary-soft)] text-xs">
                              <span className="font-semibold text-[var(--sys-heading)]" dir="ltr">#{o.orderNumber}</span>
                              <span className="text-xs text-[var(--sys-muted-foreground)]">{o.status}</span>
                              <span className="font-semibold text-[var(--sys-heading)]" dir="ltr"><Money value={o.totalAmount} currency={o.currency} /></span>
                            </Link>
                          ))}
                        </div>
                      )
                    ) : (
                      <p className="text-xs text-[var(--sys-muted)] flex items-center gap-1"><RiShoppingBagLine className="w-4 h-4" /> لا يوجد عميل مرتبط</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
