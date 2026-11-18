'use client';

import React, { useCallback, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { RiAddCircleLine, RiCheckLine, RiCloseLine, RiDeleteBinLine, RiLoader4Line, RiPencilLine } from '@remixicon/react';
import { PageShell } from '@/components/ui/PageShell';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Card } from '@/components/ui/Card';
import { Switch } from '@/components/ui/Switch';
import { Input, Select } from '@/components/ui/Input';
import { routeLabel } from '@/lib/route-registry';
import { useToast } from '@/components/ui/Toast';
import Link from 'next/link';
import { useMayOpen } from '@/hooks/useMayOpen';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { CHANNEL_KIND_AR as KIND_AR } from '@/lib/order-channel-kinds';
import { useConfirm } from '@/components/ui/Confirm';

/**
 * /settings/channels — where this shop's orders come from.
 *
 * The order's source was free text, so the same channel arrived spelled
 * three different ways and nothing could be counted per channel. Here they
 * are named once. The platform behind the name is a separate field on
 * purpose: "تيكتوك — صفحة الكريم" and "تيكتوك — صفحة القطرة" are two
 * channels and one platform, and both questions get asked.
 *
 * A channel with orders is never deleted, only switched off: it leaves the
 * lists people pick from and stays in the numbers.
 */

const KIND_TONE: Record<string, string> = {
  LANDING_PAGE: 'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)] border-[var(--sys-border)]',
  FACEBOOK: 'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)] border-[var(--sys-border)]',
  INSTAGRAM: 'bg-[var(--sys-primary-soft)] text-[var(--sys-primary)] border-[var(--sys-primary-soft)]',
  TIKTOK: 'bg-[var(--sys-surface-strong)] text-[var(--sys-heading)] border-[var(--sys-border)]',
  WHATSAPP: 'bg-[var(--sys-success-soft)] text-[var(--sys-success)] border-[var(--sys-success-soft)]',
  TELEGRAM: 'bg-[var(--sys-surface)] text-[var(--sys-primary)] border-[var(--sys-primary-soft)]',
  PHONE: 'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)] border-[var(--sys-border)]',
  SHEET: 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] border-[var(--sys-warning)]',
  WEBSITE: 'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)] border-[var(--sys-border)]',
  OTHER: 'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)] border-[var(--sys-border)]',
};

interface Channel {
  id: string;
  name: string;
  kind: string;
  isActive: boolean;
  sortOrder: number;
  orders: number;
}

export function ChannelsScreen() {
  const toast = useToast();
  const confirm = useConfirm();
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', kind: 'LANDING_PAGE' });
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState({ name: '', kind: 'OTHER' });

  const load = useCallback(async () => {
    try {
      const res = await apiJson<{ channels: Channel[] }>('/api/settings/channels');
      setChannels(res.channels);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, []);

  useLiveRefresh(load);

  async function create() {
    if (draft.name.trim().length < 2) {
      toast.failed('اكتب اسم القناة');
      return;
    }
    setBusy('new');
    try {
      await apiJson('/api/settings/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: draft.name.trim(), kind: draft.kind }),
      });
      setDraft({ name: '', kind: 'LANDING_PAGE' });
      setAdding(false);
      await load();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الإضافة');
    } finally {
      setBusy(null);
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    setBusy(id);
    try {
      await apiJson(`/api/settings/channels/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setEditing(null);
      await load();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الحفظ');
    } finally {
      setBusy(null);
    }
  }

  async function remove(channel: Channel) {
    // The button is drawn only while nothing came through the channel, so what goes is the row and its name — and the screen's own
    // «إيقاف» is the way to keep it without using it. Asked first, like every other delete in the product.
    const ok = await confirm({
      title: `حذف القناة «${channel.name}»؟`,
      body: 'ما عليها أي طلب، فيُمحى سجلّها. إن أردتَ إبقاءها بلا استعمال فاضغط «إيقاف» بدل الحذف.',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(channel.id);
    try {
      await apiJson(`/api/settings/channels/${channel.id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الحذف');
    } finally {
      setBusy(null);
    }
  }

  if (!channels) {
    return (
      <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-16">
        <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
      </div>
    );
  }

  const total = channels.reduce((sum, c) => sum + c.orders, 0);

  return (
    // On the frame (R15d, 18/11): the score section that once sat under the
    // editor moved to the performance board, so the editor no longer needs
    // the extra width it was given for it.
    <PageShell title={routeLabel('/settings/channels')}
        width="medium"
        description="من أين تصل الطلبات — تُختار عند الإدخال وتُحسب عليها الأرقام."
        actions={
          <>{!adding && (
        <Button
          size="sm"
          onClick={() => { setAdding(true); setError(null); }}
        >
          <RiAddCircleLine className="w-4 h-4" />
          قناة جديدة
        </Button>
      )}</>
        }
      >

      {error && (
        <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">{error}</p>
      )}

      {adding && (
        <Card padding="md" className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label="اسم القناة"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              autoFocus
              placeholder="مثال: تيكتوك — صفحة كريم الندبات"
            />
            <Select label="المنصة" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
              {Object.entries(KIND_AR).map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </Select>
          </div>
          <p className="text-note text-[var(--sys-muted)]">
            عدة قنوات قد تشترك بمنصة واحدة — هكذا تعرف كم جاء من تيكتوك كلها، وكم من كل صفحة فيها.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => { void create(); }}
              disabled={busy === 'new'}
            >
              {busy === 'new' ? 'جارٍ الإضافة…' : 'أضف القناة'}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => { setAdding(false); setError(null); }}
            >
              إلغاء
            </Button>
          </div>
        </Card>
      )}

      <Card plain className="divide-y divide-[var(--sys-border)]">
        {channels.length === 0 && (
          <p className="p-6 text-sm text-[var(--sys-muted-foreground)] text-center">لا قنوات بعد — أضف أول واحدة.</p>
        )}

        {channels.map((c) => (
          <div key={c.id} className={`p-3 ${c.isActive ? '' : 'bg-[var(--sys-surface)]'}`}>
            {editing === c.id ? (
              <div className="flex flex-wrap items-end gap-2">
                <div className="flex-1 min-w-[180px]">
                  <Input
                    label="الاسم"
                    value={editDraft.name}
                    onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })}
                    autoFocus
                  />
                </div>
                <div className="w-40">
                  <Select
                    label="المنصة"
                    value={editDraft.kind}
                    onChange={(e) => setEditDraft({ ...editDraft, kind: e.target.value })}
                  >
                    {Object.entries(KIND_AR).map(([k, label]) => (
                      <option key={k} value={k}>{label}</option>
                    ))}
                  </Select>
                </div>
                <IconButton
                  variant="primary"
                  label="احفظ التعديل"
                  onClick={() => { void patch(c.id, { name: editDraft.name.trim(), kind: editDraft.kind }); }}
                  disabled={busy === c.id}
                >
                  <RiCheckLine className="w-4 h-4" />
                </IconButton>
                <IconButton
                  variant="secondary"
                  label="ألغِ التعديل"
                  onClick={() => setEditing(null)}
                >
                  <RiCloseLine className="w-4 h-4" />
                </IconButton>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className={`text-note px-2 py-0.5 rounded-md border ${KIND_TONE[c.kind] ?? KIND_TONE.OTHER}`}>
                  {KIND_AR[c.kind] ?? c.kind}
                </span>
                <span className={`text-sm font-medium ${c.isActive ? 'text-[var(--sys-heading)]' : 'text-[var(--sys-muted)] line-through'}`}>
                  {c.name}
                </span>
                <span className="text-note text-[var(--sys-muted)] tabular-nums">
                  {c.orders} طلب
                  {total > 0 && c.orders > 0 && ` · ${Math.round((c.orders / total) * 100)}%`}
                </span>

                <div className="ms-auto flex items-center gap-1">
                  <IconButton
                    size="sm"
                    label="تعديل"
                    onClick={() => { setEditing(c.id); setEditDraft({ name: c.name, kind: c.kind }); setError(null); }}
                  >
                    <RiPencilLine className="w-4 h-4" />
                  </IconButton>
                  {/* On/off is a switch now (R15d). Its name is still the word the old button said — «إيقاف» while on, «تفعيل»
                      while off — because the delete question tells the reader to press «إيقاف» instead, and that sentence stays. */}
                  <Switch
                    checked={c.isActive}
                    aria-label={c.isActive ? 'إيقاف' : 'تفعيل'}
                    title={c.isActive ? 'إيقاف' : 'تفعيل'}
                    onChange={(next) => { void patch(c.id, { isActive: next }); }}
                    disabled={busy === c.id}
                  />
                  {c.orders === 0 && (
                    <IconButton
                      size="sm"
                      label="حذف — لا طلبات عليها"
                      onClick={() => { void remove(c); }}
                      disabled={busy === c.id}
                    >
                      <RiDeleteBinLine className="w-4 h-4" />
                    </IconButton>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </Card>

      <p className="text-note text-[var(--sys-muted)]">
        القناة التي عليها طلبات لا تُحذف — تُوقَف فتختفي من قوائم الاختيار وتبقى في الإحصاءات.
      </p>

      {/* The channel SCORE — which door brings money that lands — moved to the
          performance board, beside the attribution tables it is built from: this
          screen is where channels are NAMED and switched on and off, not read. */}
      <PerformanceLink />
    </PageShell>
  );
}

/** «سكور القنوات» → the performance board, for whoever may open it. */
function PerformanceLink() {
  const mayOpen = useMayOpen();
  if (!mayOpen('/growth/performance')) return null;
  return (
    <p className="text-note text-[var(--sys-muted-foreground)]">
      أيّ قناة توصِّل فعلاً؟{' '}
      <Link href="/growth/performance" className="font-semibold text-[var(--sys-primary)] hover:underline">
        سكور القنوات في لوحة الأداء
      </Link>
    </p>
  );
}
