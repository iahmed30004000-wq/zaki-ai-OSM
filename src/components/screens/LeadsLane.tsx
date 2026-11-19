'use client';

import React, { useCallback, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Rows } from '@/components/ui/Rows';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { apiJson } from '@/lib/api-client';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useToast } from '@/components/ui/Toast';
import { moneyText } from '@/lib/money';
import { useStoreCurrency } from '@/context/StoreCurrency';

/**
 * «ليدز الصفحات» — THE LEAD LANE (step E2 of Confirmation Center v2). Since R10c (18/11) it is the third tab of «زبائن ما كمّلوا»;
 * «المتابعة» keeps it above its tabs only for a supervisor who may not open that screen.
 *
 * People who left their name and number on a page and have not ordered yet, oldest first (priority 3). For each: call, pick one of the product's LIVE offers, write the address the customer
 * gave, and «حوّل لطلب» — which makes a NORMAL order through the existing landing door (the price is the offer's; there is no field to type one). Or «ما بحتاج» to take it out of the lane.
 * A lead whose number already ordered the same product in the last 24 hours is marked, never hidden. When the owner's switch is off, or the person has no right to the lane, or on any
 * failure or odd answer, this draws NOTHING — or, where it is a tab of its own («زبائن ما كمّلوا», R10c 18/11), the `empty` it is handed, so a tab is never blank.
 */
interface Offer {
  id: string;
  name: string;
  price: number;
}
interface Lead {
  id: string;
  fullName: string;
  phone: string;
  city: string | null;
  productName: string;
  receivedAt: string;
  recentOrder: boolean;
  offers: Offer[];
}
interface Answer {
  enabled: boolean;
  leads?: Lead[];
}

const valid = (x: unknown): x is Answer => !!x && typeof x === 'object' && typeof (x as Answer).enabled === 'boolean';

function waited(at: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(at).getTime()) / 60_000));
  if (minutes < 60) return `${minutes} دقيقة`;
  return minutes < 2880 ? `${Math.floor(minutes / 60)} ساعة` : `${Math.floor(minutes / 1440)} يوم`;
}

export function LeadsLane({ empty = null }: { empty?: React.ReactNode } = {}) {
  const toast = useToast();
  const currency = useStoreCurrency();
  const [data, setData] = useState<Answer | null | 'none'>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [offer, setOffer] = useState<Record<string, string>>({});
  const [address, setAddress] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const a = await apiJson<unknown>('/api/confirmation/leads');
      setData(valid(a) && a.enabled && Array.isArray(a.leads) ? a : 'none');
    } catch {
      setData('none');
    }
  }, []);

  // a lane is a queue of people waiting for a call: it loads on mount, every two minutes, and when she comes back to the screen
  useLiveRefresh(load, { everyMs: 120_000 });

  if (data === 'none') return <>{empty}</>;
  if (data && (data.leads ?? []).length === 0) return <>{empty}</>;

  const post = async (key: string, body: Record<string, unknown>, done: string) => {
    setBusy(key);
    try {
      await apiJson('/api/confirmation/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      toast.done(done);
      await load();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر التنفيذ');
    } finally {
      setBusy(null);
    }
  };

  const field = 'h-11 md:h-8 rounded-md border border-[var(--sys-border-strong)] bg-[var(--sys-card)] px-2 text-note';

  return (
    <Card>
      <CardHeader
        title="ليدز الصفحات"
        subtitle="ناس تركوا رقمهم بصفحة وما طلبوا بعد، الأقدم أول. اتصل، اختار عرض من عروض المنتج، اكتب العنوان وحوّل لطلب عادي. السعر هو سعر العرض؛ ما في سعر حر."
      />
      <CardContent className="p-0">
        {data === null ? (
          <div className="p-4" aria-busy>
            <SkeletonRows rows={3} />
          </div>
        ) : (
          <Rows
            rows={data.leads ?? []}
            keyOf={(l: Lead) => l.id}
            empty="ما في ليدز."
            columns={[
              {
                key: 'who',
                label: 'الليد',
                primary: true,
                render: (l: Lead) => (
                  <span className="space-y-0.5">
                    <span className="block font-semibold">{l.fullName}</span>
                    <a className="block text-note tabular-nums text-[var(--sys-primary)]" href={`tel:${l.phone}`} dir="ltr">
                      {l.phone}
                    </a>
                    {l.recentOrder && <span className="block text-note text-[var(--sys-destructive)]">طلب نفس المنتج من آخر 24 ساعة</span>}
                  </span>
                ),
              },
              { key: 'city', label: 'المدينة', render: (l: Lead) => l.city ?? '—' },
              { key: 'product', label: 'المنتج', render: (l: Lead) => l.productName },
              { key: 'age', label: 'ينتظر', render: (l: Lead) => waited(l.receivedAt) },
              {
                key: 'convert',
                label: 'تحويل',
                render: (l: Lead) => (
                  <span className="flex flex-wrap items-center gap-1">
                    <select aria-label={`العرض — ${l.fullName}`} className={field} value={offer[l.id] ?? ''} disabled={busy !== null || l.offers.length === 0} onChange={(e) => setOffer({ ...offer, [l.id]: e.target.value })}>
                      <option value="">{l.offers.length === 0 ? 'ما في عرض متاح' : '— العرض —'}</option>
                      {l.offers.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name} — {moneyText(o.price, currency?.code, currency?.minorUnit ?? 2)}
                        </option>
                      ))}
                    </select>
                    <input aria-label={`العنوان — ${l.fullName}`} className={`${field} w-44`} placeholder="العنوان" value={address[l.id] ?? ''} disabled={busy !== null} onChange={(e) => setAddress({ ...address, [l.id]: e.target.value })} />
                    {/* «حوّل لطلب» — the same words as the cart's press (R10c); the door and the body are the lane's own */}
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy !== null || !offer[l.id] || (address[l.id] ?? '').trim().length < 3}
                      onClick={() => void post(`c${l.id}`, { action: 'convert', leadId: l.id, offerId: offer[l.id], address: (address[l.id] ?? '').trim() }, 'انعمل الطلب')}
                    >
                      حوّل لطلب
                    </Button>
                    <Button type="button" size="sm" variant="secondary" disabled={busy !== null} onClick={() => void post(`d${l.id}`, { action: 'dismiss', leadId: l.id }, 'انشال من القايمة')}>
                      ما بحتاج
                    </Button>
                  </span>
                ),
              },
            ]}
          />
        )}
      </CardContent>
    </Card>
  );
}
