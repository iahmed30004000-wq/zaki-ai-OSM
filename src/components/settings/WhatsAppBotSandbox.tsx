'use client';

import React, { useEffect, useRef, useState } from 'react';
import { RiCheckLine, RiCloseLine, RiRefreshLine, RiSendPlaneLine } from '@remixicon/react';
import { Money } from '@/components/ui/Money';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Select } from '@/components/ui/Input';
import { screenApi as crmApi } from '@/lib/screen-api';
import { ThreadView } from '@/components/whatsapp/ThreadView';
import { WaStyle } from '@/components/whatsapp/WaStyle';
import type { WaMessage } from '@/components/whatsapp/chat-model';

interface Line {
  role: 'customer' | 'bot';
  text: string;
  at: string;
}

interface Trace {
  name: string;
  args: string;
  ok: boolean;
  error: string;
}

const TOOL_AR: Record<string, string> = {
  get_customer_orders: 'قرأ طلبات الزبون',
  get_order_details: 'قرأ تفاصيل الطلب',
  get_product_information: 'قرأ معلومات المنتج',
  update_customer_details: 'عدّل بيانات الزبون',
  change_order_offer: 'غيّر العرض',
  confirm_order: 'أكّد الطلب',
  transfer_to_human: 'حوّل لموظف',
};

/**
 * «جرّبه» — the owner writes as a made-up customer and the SAME bot answers: the same rules, the same tools and caps, on a
 * practice order built on a real product. Nothing is sent to WhatsApp and no order changes; the conversation lives on this
 * screen only and is gone when it closes. Under the thread: what the bot did with its tools, so the owner sees why.
 */
export default function WhatsAppBotSandbox({ botName, avatarText, products }: { botName: string; avatarText: string; products: Array<{ id: string; name: string }> }) {
  const [productId, setProductId] = useState(products[0]?.id ?? '');
  const [state, setState] = useState<any>(null);
  const [changedAt, setChangedAt] = useState(0);
  const [lines, setLines] = useState<Line[]>([]);
  const [trace, setTrace] = useState<Trace[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  const start = async (id: string) => {
    setError(null);
    setLines([]);
    setTrace([]);
    setChangedAt(0);
    try {
      const d: any = await crmApi('/api/whatsapp/bot/sandbox', { method: 'POST', body: JSON.stringify({ start: { productId: id || null } }) });
      setState(d.state);
      if (d.state?.productId) setProductId(d.state.productId);
    } catch (e: any) {
      setState(null);
      setError(e.message || 'تعذّر فتح التجربة');
    }
  };

  useEffect(() => {
    void start(productId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = async () => {
    const said = text.trim();
    if (!said || busy || !state) return;
    const next: Line[] = [...lines, { role: 'customer', text: said, at: new Date().toISOString() }];
    setLines(next);
    setText('');
    setBusy(true);
    setError(null);
    try {
      const d: any = await crmApi('/api/whatsapp/bot/sandbox', {
        method: 'POST',
        body: JSON.stringify({ transcript: next.map(({ role, text: t }) => ({ role, text: t })), state, changedAt }),
      });
      setState(d.state);
      setChangedAt(d.changedAt ?? changedAt);
      setTrace(d.trace || []);
      if (d.reply) setLines([...next, { role: 'bot', text: d.reply, at: new Date().toISOString() }]);
      if (d.handoff) setError(`البوت حوّل المحادثة لموظف: ${d.handoff} — بالحقيقة رح يسكت هون لحتى ترجّعوه.`);
    } catch (e: any) {
      setError(e.message || 'ما قدر البوت يرد');
    } finally {
      setBusy(false);
      box.current?.focus();
    }
  };

  const messages: WaMessage[] = lines.map((l, i) => ({
    id: `s${i}`,
    direction: l.role === 'customer' ? 'INBOUND' : 'OUTBOUND',
    messageType: 'TEXT',
    text: l.text,
    status: 'READ',
    createdAt: l.at,
    byBot: l.role === 'bot',
  }));
  const order = state?.order;

  return (
    <div className="space-y-3">
      <WaStyle />
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-0">
          <Select
            label="المنتج اللي بنجرّب عليه"
            value={productId}
            disabled={busy}
            options={products.map((p) => ({ value: p.id, label: p.name }))}
            onChange={(e) => {
              setProductId(e.target.value);
              void start(e.target.value);
            }}
          />
        </div>
        <Button variant="secondary" size="sm" onClick={() => { void start(productId); }} disabled={busy}>
          <RiRefreshLine className="w-4 h-4" /> ابدأ من جديد
        </Button>
      </div>
      {order && (
        <p className="text-note text-[var(--sys-muted-foreground)]">
          طلب تجريبي #{order.orderNumber} · {order.product?.name} · {order.offer?.name} · المبلغ عند الاستلام <Money value={order.cod} currency={order.currency} /> · {order.customer?.city} · الحالة: {order.status}
        </p>
      )}
      <div className="wa wa-sandbox">
        <div className="wa-head">
          <span className="wa-av sm bot" aria-hidden="true">{avatarText || Array.from(botName)[0]}</span>
          <div className="flex-1 min-w-0">
            <p className="wa-head-name">{botName}</p>
            <p className="wa-head-sub">{busy ? <span className="on">يكتب…</span> : <span>تجربة — ما بينبعت شي وما بيتغيّر طلب</span>}</p>
          </div>
        </div>
        <ThreadView messages={messages} hasOlder={false} loadingOlder={false} onLoadOlder={() => {}} botName={botName} botTyping={busy} />
        <div className="wa-foot">
          <div className="wa-compose">
            <div className="wa-pill">
              <textarea
                ref={box}
                rows={1}
                dir="auto"
                value={text}
                aria-label="رسالة الزبون التجريبي"
                placeholder="اكتب متل الزبون… مثلاً: مرحبا، وين طلبي؟"
                disabled={!state}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
            </div>
            <IconButton variant="primary" label="إرسال" onClick={() => { void send(); }} loading={busy} disabled={busy || !text.trim() || !state} className="wa-send">
              <RiSendPlaneLine className="icon-mirror w-5 h-5" />
            </IconButton>
          </div>
        </div>
      </div>
      {error && <p role="status" className="text-note text-[var(--sys-warning)]">{error}</p>}
      {trace.length > 0 && (
        <div className="space-y-1">
          <p className="text-note font-semibold text-[var(--sys-heading)]">شو عمل البوت بهالرد</p>
          <ul className="space-y-0.5">
            {trace.map((t, i) => (
              <li key={i} className={`text-note flex items-start gap-1 ${t.ok ? 'text-[var(--sys-muted-foreground)]' : 'text-[var(--sys-warning)]'}`}>
                {t.ok ? <RiCheckLine className="w-4 h-4 shrink-0" aria-label="نجح" /> : <RiCloseLine className="w-4 h-4 shrink-0" aria-label="انرفض" />}
                {TOOL_AR[t.name] ?? t.name}
                {!t.ok && t.error ? ` — ${t.error}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
