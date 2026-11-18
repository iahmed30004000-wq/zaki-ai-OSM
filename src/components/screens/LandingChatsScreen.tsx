'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '@/context/AppContext';
import { screenApi as crmApi, qs } from '@/lib/screen-api';
import { routeLabel } from '@/lib/route-registry';
import { RiArrowRightSLine, RiErrorWarningLine, RiExternalLinkLine, RiPhoneLine, RiRefreshLine, RiRobot2Line, RiSearchLine, RiSendPlaneLine, RiShieldFlashLine, RiUserVoiceLine } from '@remixicon/react';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { OrderRef } from '@/components/orders/OrderRef';
import { arTime } from '@/lib/format';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { userCan } from '@/lib/can';
import { FAST_POLL_MS, listSignature, paceFor } from '@/lib/inbox-pace';

/**
 * «رسائل اللاندينج» — every conversation of the landing pages' chat assistant, relayed by Zaki pages from its first
 * message (contract oms-lp.v1 §11). The WhatsApp inbox's layout, polling pace and permissions: `whatsapp.view` to read,
 * `whatsapp.send` to answer and to give the conversation back to the bot.
 *
 * The first reply a person sends pauses the bot for that conversation; the header then says so, and «رجّع للبوت» hands
 * it back. The customer sees the reply in the page's chat window under «فريق الدعم».
 */

interface Thread {
  id: string;
  mode: string;
  pageName: string | null;
  pageSlug: string | null;
  pageUrl?: string | null;
  productName: string | null;
  orderNumber: string | null;
  orderId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  botPaused: boolean;
  unreadCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  createdAt: string;
}

interface Line {
  id: string;
  seq: string;
  direction: 'CUSTOMER' | 'BOT' | 'STAFF' | 'EVENT' | string;
  text: string | null;
  event: string | null;
  authorName: string | null;
  at: string;
}

type Filter = 'all' | 'unread' | 'staff';
const FILTER_AR: Record<Filter, string> = { all: 'الكل', unread: 'غير مقروءة', staff: 'بيد الموظفين' };

const who = (t: Pick<Thread, 'customerName' | 'customerPhone'>) => t.customerName || t.customerPhone || 'زائر';
const initials = (t: Pick<Thread, 'customerName' | 'customerPhone'>) => (t.customerName || t.customerPhone || 'ز').slice(0, 2);
/** Under the name in the list: the page, and whether an order came of it. */
const whereFrom = (t: Thread) => [t.pageName || 'صفحة هبوط', t.orderId ? 'فيها طلب' : null].filter(Boolean).join(' · ');

export function LandingChatsScreen() {
  const { currentUser } = useApp();
  const canView = userCan(currentUser, 'whatsapp.view');
  const canSend = userCan(currentUser, 'whatsapp.send');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Thread | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [linesLoading, setLinesLoading] = useState(false);
  const [mobileView, setMobileView] = useState<'list' | 'chat'>('list');

  const [composing, setComposing] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // The open thread and the last line it holds, read by the poll's callback (see WhatsAppInboxScreen for why after commit).
  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);
  const lastSeqRef = useRef<string>('');
  useEffect(() => {
    lastSeqRef.current = lines.length ? lines[lines.length - 1].seq : '';
  }, [lines]);
  const inFlightRef = useRef(false);

  // Five seconds while anything moves, fifteen after a quiet minute — the WhatsApp inbox's pace (RV182).
  const quietRef = useRef(0);
  const listSigRef = useRef('');
  const [pace, setPace] = useState(FAST_POLL_MS);
  const speedUp = useCallback(() => {
    quietRef.current = 0;
    setPace(FAST_POLL_MS);
  }, []);

  const loadThreads = useCallback(
    async (silent = false) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const d: any = await crmApi('/api/landing-chats' + qs({ filter, q: search }));
        const list: Thread[] = d.threads || [];
        setThreads(list);
        setOffline(false);
        setError(null);
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
    },
    [filter, search]
  );

  const markRead = (id: string) => crmApi(`/api/landing-chats/${id}/read`, { method: 'POST' }).catch(() => {});

  const loadLines = useCallback(async (id: string, silent = false) => {
    try {
      const after = silent ? lastSeqRef.current : '';
      const d: any = await crmApi(`/api/landing-chats/${id}` + qs({ after }));
      if (selectedIdRef.current !== id) return;
      setSelected((s) => ({ ...(s || d.thread), ...d.thread }));
      const fresh: Line[] = d.messages || [];
      if (after) {
        if (fresh.length) {
          speedUp();
          setLines((prev) => {
            const known = new Set(prev.map((m) => m.id));
            return [...prev, ...fresh.filter((m) => !known.has(m.id))];
          });
          if (fresh.some((m) => m.direction === 'CUSTOMER')) markRead(id);
        }
      } else {
        setLines(fresh);
        if (d.thread?.unreadCount > 0) {
          markRead(id);
          setSelected((s) => (s ? { ...s, unreadCount: 0 } : s));
        }
      }
    } catch (e: any) {
      if (/network|fetch/i.test(String(e))) setOffline(true);
      if (!silent) setError(e.message || 'تعذر تحميل الرسائل');
    } finally {
      setLinesLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!canView) {
      setLoading(false);
      return;
    }
    loadThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  useLiveRefresh(
    () => {
      if (!canView) return;
      loadThreads(true);
      if (selectedIdRef.current) loadLines(selectedIdRef.current, true);
    },
    { everyMs: pace, enabled: canView, onReturn: speedUp }
  );

  const open = (t: Thread) => {
    speedUp();
    setSelectedId(t.id);
    setSelected(t);
    setLines([]);
    setLinesLoading(true);
    setSendError(null);
    setMobileView('chat');
    setThreads((prev) => prev.map((x) => (x.id === t.id ? { ...x, unreadCount: 0 } : x)));
    loadLines(t.id);
  };

  const send = async () => {
    const text = composing.trim();
    if (!selectedId || !text || sending) return;
    speedUp();
    setSending(true);
    setSendError(null);
    try {
      const d: any = await crmApi(`/api/landing-chats/${selectedId}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
      setComposing('');
      setSelected((s) => (s ? { ...s, botPaused: true } : s));
      // The pause line and the reply come back with the next read; the reply is shown at once.
      setLines((prev) => (prev.some((m) => m.id === d.message.id) ? prev : [...prev, d.message]));
      loadLines(selectedId, true);
      loadThreads(true);
    } catch (e: any) {
      setSendError(e.message || 'تعذر إرسال الرسالة');
    } finally {
      setSending(false);
    }
  };

  const giveBack = async () => {
    if (!selectedId) return;
    setSendError(null);
    try {
      const d: any = await crmApi(`/api/landing-chats/${selectedId}/bot`, { method: 'POST', body: JSON.stringify({ paused: false }) });
      setSelected((s) => (s ? { ...s, botPaused: d.botPaused } : s));
      loadLines(selectedId, true);
      loadThreads(true);
    } catch (e: any) {
      setSendError(e.message || 'تعذر تغيير حالة البوت');
      throw e;
    }
  };

  if (!canView) {
    return (
      <div className="p-8">
        <Card padding="lg" className="max-w-md mx-auto mt-20 text-center">
          <RiShieldFlashLine className="w-6 h-6 mx-auto text-[var(--sys-primary)]" />
          <h2 className="mt-4 font-bold text-[var(--sys-heading)]">ليس لديك صلاحية لعرض المحادثات</h2>
          <p className="mt-2 text-note text-[var(--sys-muted-foreground)]">تواصل مع مدير الشركة لمنحك صلاحية whatsapp.view</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col" style={{ height: 'calc(100dvh - var(--sys-header-h, 72px))' }}>
      <PageHeader
        title={routeLabel('/growth/landing-chats')}
        description="محادثات الزوار مع المساعدة على صفحات الهبوط — من أول رسالة، وبتقدر ترد عليهم من هون"
      />

      <div className="flex-1 min-h-0 px-4 md:px-6 pb-4 grid grid-cols-1 lg:grid-cols-[320px_1fr_300px] gap-4 overflow-hidden">
        {/* ── Column 1: the threads ── */}
        <Card className={`flex-col min-h-0 ${mobileView === 'chat' ? 'hidden lg:flex' : 'flex'}`}>
          <div className="p-3 border-b border-[var(--sys-surface-strong)] space-y-2">
            <div className="relative">
              <RiSearchLine className="absolute top-2.5 left-3 w-4 h-4 text-[var(--sys-muted)] rtl:right-3 rtl:left-auto" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && loadThreads()}
                placeholder="بحث برقم أو اسم أو رقم طلب..."
                className="w-full pl-9 rtl:pr-9 rtl:pl-3 py-2 text-sm rounded-lg border border-[var(--sys-border-input)] focus:outline-none focus:ring-2 focus:ring-[var(--sys-primary)]/20"
              />
            </div>
            <div className="flex gap-1">
              {(['all', 'unread', 'staff'] as const).map((f) => (
                <Button key={f} size="sm" variant={filter === f ? 'primary' : 'secondary'} onClick={() => setFilter(f)} aria-pressed={filter === f}>
                  {FILTER_AR[f]}
                </Button>
              ))}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto min-h-0">
            {loading ? (
              <div className="p-6 text-center text-sm text-[var(--sys-muted-foreground)]">جارٍ التحميل...</div>
            ) : error && !offline ? (
              <div className="p-4 m-3 rounded-lg bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)] text-sm flex flex-col gap-2">
                <span className="flex items-center gap-1.5"><RiErrorWarningLine className="w-4 h-4" />{error}</span>
                <Button variant="quiet" size="sm" onClick={() => { setError(null); return loadThreads(); }}>
                  <RiRefreshLine className="w-4 h-4" /> إعادة المحاولة
                </Button>
              </div>
            ) : offline ? (
              <div className="p-4 m-3 rounded-lg bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] text-sm">
                لا يوجد اتصال بالشبكة — سيتم تحديث الصندوق تلقائيًا عند عودة الاتصال
              </div>
            ) : threads.length === 0 ? (
              <div className="p-8 text-center text-sm text-[var(--sys-muted-foreground)]">
                {filter === 'all' ? 'لا توجد محادثات من صفحات الهبوط بعد' : 'لا توجد محادثات هنا'}
              </div>
            ) : (
              threads.map((t) => (
                <Button
                  key={t.id}
                  variant="quiet"
                  onClick={() => open(t)}
                  aria-current={selectedId === t.id || undefined}
                  className={`w-full h-auto! justify-start! items-start! text-right gap-3! px-4! py-3! rounded-none! border-b! border-b-[var(--sys-surface)]! ${selectedId === t.id ? 'bg-[var(--sys-primary-soft)]!' : ''}`}
                >
                  <span className="w-10 h-10 rounded-full bg-[var(--sys-heading)] text-[var(--sys-primary-foreground)] flex items-center justify-center shrink-0 text-sm font-bold">
                    {initials(t)}
                  </span>
                  <span className="flex-1 min-w-0 text-right">
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-[var(--sys-heading)] truncate">{who(t)}</span>
                      {t.unreadCount > 0 && (
                        <span className="shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-note font-bold flex items-center justify-center">{t.unreadCount}</span>
                      )}
                    </span>
                    <span className="block text-note text-[var(--sys-muted-foreground)] truncate mt-0.5">{t.lastMessagePreview || '—'}</span>
                    <span className="block text-note text-[var(--sys-muted)] truncate mt-0.5">
                      {whereFrom(t)}
                      {t.botPaused && <span className="ms-1 text-[var(--sys-warning)]">· بيد الموظفين</span>}
                    </span>
                  </span>
                </Button>
              ))
            )}
          </div>
        </Card>

        {/* ── Column 2: the conversation ── */}
        <Card className={`flex-col min-h-0 ${mobileView === 'list' ? 'hidden lg:flex' : 'flex'}`}>
          {!selected ? (
            <div className="flex-1 flex items-center justify-center text-sm text-[var(--sys-muted-foreground)]">اختر محادثة لعرضها</div>
          ) : (
            <>
              <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--sys-surface-strong)]">
                <IconButton label="عد إلى المحادثات" className="lg:hidden" onClick={() => setMobileView('list')}>
                  <RiArrowRightSLine className="icon-mirror w-5 h-5" />
                </IconButton>
                <div className="w-9 h-9 rounded-full bg-[var(--sys-heading)] text-[var(--sys-primary-foreground)] flex items-center justify-center text-sm font-bold">{initials(selected)}</div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-[var(--sys-heading)] truncate">{who(selected)}</p>
                  <p className="text-note text-[var(--sys-muted-foreground)] truncate">{[selected.pageName, selected.productName].filter(Boolean).join(' — ') || 'صفحة هبوط'}</p>
                </div>
                {canSend && selected.botPaused && (
                  <Button variant="secondary" size="sm" onClick={giveBack}>
                    <RiRobot2Line className="w-4 h-4" /> رجّع للبوت
                  </Button>
                )}
              </div>

              {/* Who answers this conversation now. */}
              <div
                className={`flex items-center gap-2 px-4 py-2 border-b border-[var(--sys-surface)] text-note font-semibold ${selected.botPaused ? 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)]' : 'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)]'}`}
                role="status"
              >
                {selected.botPaused ? (
                  <><RiUserVoiceLine className="w-4 h-4" /> البوت متوقف — موظفة ترد</>
                ) : (
                  <><RiRobot2Line className="w-4 h-4" /> البوت يرد على هذه المحادثة — أول رد منك يوقفه</>
                )}
              </div>

              <div className="flex-1 overflow-y-auto min-h-0 px-4 py-4 space-y-2 bg-[var(--sys-surface)]" dir="ltr">
                {linesLoading ? (
                  <div className="text-center text-sm text-[var(--sys-muted-foreground)] py-8">جارٍ التحميل...</div>
                ) : lines.length === 0 ? (
                  <EmptyState title="لا رسائل في هذه المحادثة" why="المحادثة انفتحت ولم يصل منها شيء بعد." />
                ) : (
                  lines.map((m) =>
                    m.direction === 'EVENT' ? (
                      <div key={m.id} className="flex justify-center">
                        <span className="px-3 py-1 rounded-full bg-[var(--sys-card)] text-note text-[var(--sys-muted-foreground)]" dir="rtl">
                          {m.event === 'BOT_RESUMED' ? 'رجعت المحادثة للبوت' : 'البوت توقف — موظفة ترد'}
                          {m.authorName ? ` (${m.authorName})` : ''} · {arTime(m.at)}
                        </span>
                      </div>
                    ) : (
                      <div key={m.id} className={`flex ${m.direction === 'CUSTOMER' ? 'justify-start' : 'justify-end'}`}>
                        <div
                          className={`max-w-[75%] rounded-lg px-3.5 py-2 text-sm shadow-raised text-[var(--sys-heading)] ${
                            m.direction === 'CUSTOMER'
                              ? 'bg-[var(--sys-card)]'
                              : m.direction === 'STAFF'
                                ? 'bg-[var(--sys-success-soft)]'
                                : 'bg-[var(--sys-primary-soft)]'
                          }`}
                        >
                          {m.direction !== 'CUSTOMER' && (
                            <span className="block text-note font-semibold text-[var(--sys-muted-foreground)]" dir="rtl">
                              {m.direction === 'STAFF' ? m.authorName || 'فريق الدعم' : 'البوت'}
                            </span>
                          )}
                          <p className="whitespace-pre-wrap break-words" dir="auto">{m.text || ''}</p>
                          <div className="flex items-center gap-1 justify-end mt-0.5">
                            <span className="text-note text-[var(--sys-muted)]">{arTime(m.at)}</span>
                          </div>
                        </div>
                      </div>
                    )
                  )
                )}
              </div>

              {canSend ? (
                <div className="border-t border-[var(--sys-surface-strong)] p-3 space-y-2">
                  {sendError && (
                    <div className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)] text-sm">
                      <RiErrorWarningLine className="w-4 h-4 shrink-0" />
                      {sendError}
                    </div>
                  )}
                  <div className="flex items-end gap-2">
                    <textarea
                      value={composing}
                      onChange={(e) => setComposing(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          send();
                        }
                      }}
                      rows={1}
                      maxLength={2000}
                      placeholder={selected.botPaused ? 'اكتب رسالة...' : 'اكتب رسالة... (بيوقف البوت بهالمحادثة)'}
                      className="flex-1 resize-none max-h-32 px-3 py-2.5 text-sm rounded-lg border border-[var(--sys-border-input)] focus:outline-none focus:ring-2 focus:ring-[var(--sys-primary)]/20"
                    />
                    <IconButton label="إرسال" variant="primary" loading={sending} disabled={!composing.trim()} onClick={send}>
                      <RiSendPlaneLine className="icon-mirror w-4 h-4" />
                    </IconButton>
                  </div>
                </div>
              ) : (
                <div className="border-t border-[var(--sys-surface-strong)] p-3 text-center text-sm text-[var(--sys-muted-foreground)]">ليس لديك صلاحية لإرسال الرسائل</div>
              )}
            </>
          )}
        </Card>

        {/* ── Column 3: what the conversation is about ── */}
        <Card className="overflow-y-auto min-h-0 hidden lg:block">
          {!selected ? (
            <div className="flex items-center justify-center h-full text-sm text-[var(--sys-muted-foreground)]">تفاصيل المحادثة</div>
          ) : (
            <div className="p-4 space-y-5 text-sm">
              <div className="text-center">
                <div className="w-16 h-16 mx-auto rounded-full bg-[var(--sys-heading)] text-[var(--sys-primary-foreground)] flex items-center justify-center text-lg font-bold">{initials(selected)}</div>
                <p className="mt-2 font-bold text-[var(--sys-heading)]">{selected.customerName || 'زائر بلا اسم بعد'}</p>
                {selected.customerPhone ? (
                  <p className="text-[var(--sys-muted-foreground)] flex items-center justify-center gap-1 mt-1" dir="ltr">
                    <RiPhoneLine className="w-4 h-4" /> {selected.customerPhone}
                  </p>
                ) : (
                  <p className="text-note text-[var(--sys-muted)] mt-1">ما عطى رقمه بعد</p>
                )}
              </div>
              <div>
                <p className="text-note font-bold text-[var(--sys-muted)] mb-1">الصفحة</p>
                <p className="text-[var(--sys-heading)]">{selected.pageName || '—'}</p>
                {selected.pageSlug && <p className="text-note text-[var(--sys-muted-foreground)]" dir="ltr">/{selected.pageSlug}</p>}
                {selected.pageUrl && (
                  <a href={selected.pageUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 font-semibold text-[var(--sys-primary)] hover:underline">
                    <RiExternalLinkLine className="icon-mirror w-4 h-4" /> فتح الصفحة
                  </a>
                )}
              </div>
              <div>
                <p className="text-note font-bold text-[var(--sys-muted)] mb-1">المنتج</p>
                <p className="text-[var(--sys-heading)]">{selected.productName || '—'}</p>
              </div>
              <div>
                <p className="text-note font-bold text-[var(--sys-muted)] mb-1">الطلب</p>
                {selected.orderId && selected.orderNumber ? (
                  <OrderRef id={selected.orderId} number={selected.orderNumber} />
                ) : (
                  <p className="text-[var(--sys-muted-foreground)]">{selected.mode === 'intake' ? 'لسا ما في طلب — المساعدة عم تاخد الطلب' : 'لسا ما في طلب'}</p>
                )}
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
