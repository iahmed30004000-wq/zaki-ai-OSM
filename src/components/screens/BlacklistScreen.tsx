'use client';

import React, { useCallback, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { Modal } from '@/components/ui/Modal';
import { ScreenTitle } from '@/components/shell/ScreenTitle';
import { RiAddCircleLine, RiArrowGoBackLine, RiLoader4Line, RiSearchLine } from '@remixicon/react';
import { Rows } from '@/components/ui/Rows';
import { EmptyState } from '@/components/ui/EmptyState';
import { arDate } from '@/lib/format';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';

/**
 * /control/blacklist — who may not order again.
 *
 * Keyed on the phone and company-wide, because the phone is the identity and
 * the same person is the same person in every store. The list shows what
 * each blocked number actually did — orders, delivered, cancelled — so the
 * decision can be judged rather than taken on faith.
 *
 * Releasing keeps the row. Nothing here is deleted.
 */

interface Block {
  id: string;
  phone: string;
  name: string | null;
  reason: string;
  createdAt: string;
  blockedByName: string | null;
  releasedAt: string | null;
  releasedByName: string | null;
  releaseReason: string | null;
  active: boolean;
  customer: { totalOrders: number; deliveredOrders: number; cancelledOrders: number } | null;
}

export function BlacklistScreen() {
  // Seeing the list is `control.blacklist`; blocking a number and lifting a block is its own key (PR-6), asked of the server too.
  const { currentUser } = useApp();
  const mayManage = userCan(currentUser, 'control.blacklist_manage');
  const [blocks, setBlocks] = useState<Block[] | null>(null);
  const [term, setTerm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [releasing, setReleasing] = useState<Block | null>(null);
  const [showReleased, setShowReleased] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const q = term.trim() ? `?q=${encodeURIComponent(term.trim())}` : '';
      const data = await apiJson<{ blocks: Block[] }>(`/api/control/blacklist${q}`);
      setBlocks(data.blocks);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, [term]);

  useLiveRefresh(load, { key: term });

  const rows = (blocks ?? []).filter((b) => (showReleased ? true : b.active));
  /** Why the list is empty, if it is — the three answers are not the same. */
  const searching = term.trim().length > 0;
  const releasedHidden = !showReleased && (blocks ?? []).some((b) => !b.active);

  return (
    <div className="max-w-5xl space-y-3">
      <ScreenTitle />

      <p className="text-xs text-[var(--sys-muted-foreground)] bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg p-3">
        الحظر على <b>رقم الهاتف</b> وعلى مستوى الشركة كلها — لأن الرقم هو الهوية، والشخص نفسه هو الشخص
        نفسه في كل متجر. الطلبات القائمة لا تتأثر؛ الحظر يمنع الطلب <b>القادم</b>. وفكّ الحظر يبقي السجل.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
        className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4 flex flex-wrap gap-3 items-end"
      >
        <label className="flex-1 min-w-[220px]">
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">بحث</span>
          <div className="relative">
            <RiSearchLine className="w-4 h-4 text-[var(--sys-muted)] absolute right-3 top-3" />
            <input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="رقم الهاتف، الاسم أو السبب"
              className="w-full h-11 md:h-10 pr-9 pl-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
            />
          </div>
        </label>
        <label className="flex items-center gap-2 h-10 text-sm text-[var(--sys-foreground)]">
          <input type="checkbox" checked={showReleased} onChange={(e) => setShowReleased(e.target.checked)} />
          أظهر المفكوكين
        </label>
        {mayManage && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="h-11 md:h-10 px-4 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-medium inline-flex items-center gap-1.5"
          >
            <RiAddCircleLine className="w-4 h-4" /> حظر رقم
          </button>
        )}
      </form>

      {error && <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">{error}</p>}
      {done && <p className="text-sm text-[var(--sys-success)] bg-[var(--sys-success-soft)] border border-[var(--sys-success)]/30 rounded-lg p-3">{done}</p>}

      {/*
        «لا أرقام محظورة» WAS NOT SOMETHING THIS SCREEN KNEW.

        Two empty states stood here and the worse one won. A bare paragraph
        short-circuited the list, so the `Rows` empty state below — the one
        with the reason in it — could never render at all. And the paragraph's
        sentence was read off `activeCount`, which the route computes over the
        SEARCHED rows: type a number nobody blocked, and a screen holding a
        full blacklist announced «لا أرقام محظورة». A reassurance that is not
        true is worse than no reassurance.

        One empty state, and it says WHICH of the three things is true:
        nothing searched and nothing blocked, a search that matched nothing,
        or every block released and the released ones hidden.
      */}
      {!blocks ? (
        <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-16">
          <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
        </div>
      ) : (
        <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg overflow-hidden">
                    <Rows
            rows={rows}
            keyOf={(b) => b.id}
            columns={[
              { key: 'c0', label: "الرقم", primary: true,
                render: (b) => (b.phone) },
              { key: 'c1', label: "الاسم", primary: true,
                render: (b) => (b.name ?? '—') },
              { key: 'c2', label: "سجله معنا", align: 'end',
                render: (b) => (
                  <>{b.customer
                      ? `${b.customer.totalOrders} طلب · ${b.customer.deliveredOrders} مسلّم · ${b.customer.cancelledOrders} ملغى`
                      : 'لا سجل'}</>
                ) },
              { key: 'c3', label: "السبب",
                render: (b) => (
                  <>{b.reason}
                    {!b.active && b.releaseReason && (
                      <span className="block text-xs text-[var(--sys-success)] mt-0.5">
                        فُك: {b.releaseReason} — {b.releasedByName ?? '—'}
                      </span>
                    )}</>
                ) },
              { key: 'c4', label: "حظره",
                render: (b) => (
                  <>{b.blockedByName ?? '—'}
                    <span className="block text-xs text-[var(--sys-muted)]">
                      {arDate(b.createdAt)}
                    </span></>
                ) },
            ]}
            empty={
              searching ? (
                <EmptyState
                  title="لا نتائج مطابقة"
                  why={`لا رقمَ محظوراً يطابق «${term.trim()}». البحث يمرّ على الرقم والاسم وسبب الحظر — والقائمة قد تكون عامرةً وراء هذا البحث.`}
                  action={{ label: 'امسح البحث', onClick: () => setTerm('') }}
                />
              ) : releasedHidden ? (
                <EmptyState
                  title="لا حظرَ سارياً الآن"
                  why="كلُّ ما في السجلّ فُكَّ حظرُه. السجلّ باقٍ — أظهِر المفكوكين لتراه."
                  action={{ label: 'أظهر المفكوكين', onClick: () => setShowReleased(true) }}
                />
              ) : (
                <EmptyState
                  title="لا أرقامَ محظورة"
                  why="الحظر على الهاتف لا على الاسم: مَن رفض الاستلام ثلاث مرّات يطلب من جديد باسمٍ آخر. أضِف رقماً حين يلزم."
                  action={mayManage ? { label: 'حظر رقم', onClick: () => setAdding(true) } : undefined}
                />
              )
            }
            actions={(b) => (
              <>{b.active && !mayManage ? (
                      <span className="text-xs text-[var(--sys-muted)]">محظور</span>
                    ) : b.active ? (
                      <button
                        onClick={() => setReleasing(b)}
                        className="text-xs text-[var(--sys-success)] hover:underline inline-flex items-center gap-1"
                      >
                        <RiArrowGoBackLine className="icon-mirror w-4 h-4" /> فك الحظر
                      </button>
                    ) : (
                      <span className="text-xs text-[var(--sys-muted)]">مفكوك</span>
                    )}</>
            )}
          />
        </div>
      )}

      {adding && (
        <BlockDialog
          onClose={() => setAdding(false)}
          onSaved={async (message) => {
            setAdding(false);
            setDone(message);
            await load();
          }}
        />
      )}

      {releasing && (
        <ReleaseDialog
          block={releasing}
          onClose={() => setReleasing(null)}
          onSaved={async (message) => {
            setReleasing(null);
            setDone(message);
            await load();
          }}
        />
      )}
    </div>
  );
}

function BlockDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (m: string) => void }) {
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  return (
    <Modal isOpen onClose={onClose} title="حظر رقم">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError(null);
          try {
            await apiJson('/api/control/blacklist', {
              method: 'POST',
              body: JSON.stringify({ phone: phone.trim(), name: name.trim() || undefined, reason: reason.trim() }),
            });
            onSaved(`حُظر الرقم ${phone.trim()}`);
          } catch (err) {
            setError(err instanceof Error ? err.message : 'تعذر الحظر');
          } finally {
            setSaving(false);
          }
        }}
        className="space-y-3"
      >
        <label className="block">
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">رقم الهاتف</span>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            required
            autoFocus
            placeholder="0790123456"
            className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
            dir="ltr"
          />
          <span className="block text-xs text-[var(--sys-muted)] mt-1">
            يُطابَق بصيغته المجرّدة، فلا يهم كيف كُتب.
          </span>
        </label>

        <label className="block">
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">الاسم (اختياري)</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
          />
        </label>

        <label className="block">
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">السبب (إلزامي)</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            minLength={3}
            rows={3}
            placeholder="مثال: رفض الاستلام 3 مرات متتالية"
            className="w-full p-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
          />
        </label>

        {error && <p className="text-sm text-[var(--sys-destructive)]">{error}</p>}

        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="h-11 md:h-10 px-4 rounded-lg border border-[var(--sys-border)] text-sm">
            إلغاء
          </button>
          <button
            type="submit"
            disabled={saving}
            className="h-11 md:h-10 px-4 rounded-lg bg-[var(--sys-destructive)] text-[var(--sys-primary-foreground)] text-sm font-medium disabled:opacity-50"
          >
            {saving ? 'جارٍ الحظر…' : 'حظر'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ReleaseDialog({
  block,
  onClose,
  onSaved,
}: {
  block: Block;
  onClose: () => void;
  onSaved: (m: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  return (
    <Modal isOpen onClose={onClose} title={`فك الحظر — ${block.phone}`}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError(null);
          try {
            await apiJson('/api/control/blacklist', {
              method: 'PATCH',
              body: JSON.stringify({ blockId: block.id, reason: reason.trim() }),
            });
            onSaved(`فُك الحظر عن ${block.phone}`);
          } catch (err) {
            setError(err instanceof Error ? err.message : 'تعذر فك الحظر');
          } finally {
            setSaving(false);
          }
        }}
        className="space-y-3"
      >
        <p className="text-sm text-[var(--sys-foreground)] bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg p-3">
          سبب الحظر الأصلي: <b>{block.reason}</b>
          <span className="block text-xs text-[var(--sys-muted)] mt-1">
            يبقى السجل بعد فك الحظر — لا يُحذف شيء.
          </span>
        </p>

        <label className="block">
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">سبب فك الحظر (إلزامي)</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            minLength={3}
            rows={3}
            placeholder="مثال: تواصل واعتذر والتزم بالاستلام"
            className="w-full p-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
          />
        </label>

        {error && <p className="text-sm text-[var(--sys-destructive)]">{error}</p>}

        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="h-11 md:h-10 px-4 rounded-lg border border-[var(--sys-border)] text-sm">
            إلغاء
          </button>
          <button
            type="submit"
            disabled={saving}
            className="h-11 md:h-10 px-4 rounded-lg bg-[var(--sys-success)] text-[var(--sys-primary-foreground)] text-sm font-medium disabled:opacity-50"
          >
            فك الحظر
          </button>
        </div>
      </form>
    </Modal>
  );
}
