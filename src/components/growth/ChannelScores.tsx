'use client';

import React, { useCallback, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { Money } from '@/components/ui/Money';
import { HealthChip } from '@/components/ui/HealthChip';
import { healthOf } from '@/lib/health';
import type { ChannelScore } from '@/lib/channel-score';
import type { Trust } from '@/lib/cod-vitals';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { CHANNEL_KIND_AR as KIND_AR } from '@/lib/order-channel-kinds';

/**
 * «سكور القنوات — أيّها يوصِّل فعلاً» ON THE PERFORMANCE BOARD.
 *
 * It stood at the foot of `/settings/channels`, under the list of channels
 * and their on/off switches — a report in a settings screen, and a second
 * «أداء القنوات» beside the one on the performance board. The audit that
 * proposed deleting it called it a duplicate. It is not: the board's table counts
 * what each door brought (orders, shares, the one-order value); this scores what
 * the door DELIVERED and COLLECTED — failed deliveries, cash in hand, the band
 * that cannot be measured yet — and names the orders that came through no door.
 * So it MOVED, whole, to sit under the table it is built from, and the channels
 * screen links here.
 *
 * Its own door (`GET /api/settings/channels/performance`) asks `reports.view`,
 * the key of the board it sits on, so it answers 403 only to somebody the board
 * itself refuses; if it ever does, the section draws nothing rather than an
 * error under every table.
 */

/**
 * WHAT EACH DOOR ACTUALLY PRODUCED — from its own endpoint.
 *
 * Kept off `GET /api/settings/channels` on purpose: that call fills the
 * dropdown on every order-intake form and is open to anyone who may enter an
 * order. Numbers belong behind `reports.view`, and a data-entry form should
 * not wait for a report to load.
 */
interface ChannelPerf {
  id: string;
  name: string;
  kind: string | null;
  isActive: boolean;
  brought: number;
  confirmed: number;
  delivered: number;
  returned: number;
  doorDecided: number;
  collected: number;
  confirmationRate: number | null;
  deliveryRate: number | null;
  returnRate: number | null;
  revenue: number;
  deliveredValue: number | null;
  score: ChannelScore;
  whyNoScore: string | null;
}

interface ShopSpread {
  orders: number;
  delivered: number;
  collected: number;
  withoutChannel: number;
  withoutChannelShare: number | null;
  collection: Trust;
}


/**
 * ─── WHICH DOOR BRINGS MONEY THAT LANDS ───
 *
 * The list above answers «what are my channels called». This answers the
 * question the owner actually asked, which the old screen could not express
 * at all: it printed an order count and a share of the total, so it said
 * الشيت is 87% of the business and never mentioned that 30 of its parcels
 * came back.
 *
 * Every figure here is the server's. Not one rate, share or sum is computed
 * in this component — the score, its bands, the return rate and the money all
 * arrive decided, because a browser that recomputes a displayed figure is how
 * two screens come to disagree about one week.
 */
function ChannelScores({ perf }: { perf: { channels: ChannelPerf[]; shop: ShopSpread } | null }) {
  if (!perf) return null;

  const { shop } = perf;
  // Doors that have ever brought an order. A channel somebody created and
  // never used has nothing to grade and would only pad the section.
  const rows = perf.channels.filter((c) => c.brought > 0);
  const graded = rows.filter((c) => c.score.total !== null);

  return (
    <div className="space-y-3 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-4">
      <div>
        <h2 className="text-sm font-bold text-[var(--sys-heading)]">سكور القنوات — أيّها يوصِّل فعلاً</h2>
        <p className="mt-1 text-xs text-[var(--sys-muted-foreground)]">
          ليس الأكثر طلباً — الأكثر وصولاً. قناة تجلب 100 طلب يرجع منها 40 أسوأ من واحدة تجلب 30 كلها تُسلَّم.
        </p>
      </div>

      {/*
        THE BAND THAT CANNOT BE MEASURED, SAID BEFORE ANY SCORE IS READ.

        The owner asked which channel produces delivered AND COLLECTED money.
        Delivered, this can answer. Collected, it cannot: measured, 0 of 119
        delivered orders have ever been marked settled. Scoring that band
        anyway would give every door the same zero and rank four channels by a
        tie — so it is refused out loud, once, and its 15 points leave every
        score's denominator.
      */}
      {shop.collection.level === 'WITHHELD' && (
        <p className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-3 text-xs text-[var(--sys-muted-foreground)]">
          <span className="font-semibold text-[var(--sys-heading)]">التحصيل خارج السكور: </span>
          {shop.collection.ar} لذلك يُحسب كل سكور من 85 لا من 100، وبند «نسبة التحصيل» يبقى بلا نقاط حتى تُطابَق أول كشف.
        </p>
      )}

      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-[var(--sys-muted-foreground)]">
          لا طلبات على أيّ قناة بعد — السكور يظهر مع أول طلبات تصل.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--sys-border)]">
          {rows.map((c, i) => (
            <li key={c.id} className="py-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                {/* The rank is only drawn for a door that has one. Numbering
                    the ungraded ones 5, 6, 7 would read as «worse», and they
                    are not worse — they are unmeasured. */}
                <span className="w-5 text-xs font-black tabular-nums text-[var(--sys-muted)]">
                  {c.score.total === null ? '—' : i + 1}
                </span>
                <span className="text-sm font-bold text-[var(--sys-heading)]">{c.name}</span>
                <span className="text-xs text-[var(--sys-muted)]">{KIND_AR[c.kind ?? 'OTHER'] ?? c.kind}</span>

                {c.score.total === null ? (
                  <span className="ms-auto text-xs text-[var(--sys-muted-foreground)]">{c.whyNoScore}</span>
                ) : (
                  <span className="ms-auto inline-flex items-baseline gap-1 tabular-nums">
                    <span className="text-lg font-black text-[var(--sys-heading)]">{c.score.total}</span>
                    <span className="text-xs text-[var(--sys-muted-foreground)]">من {c.score.possible}</span>
                  </span>
                )}
              </div>

              {/*
                WHAT IT MEASURED, ALWAYS — never the headline alone. Somebody
                told «your channel scored 67» can do nothing with it; somebody
                told which band cost the points can.
              */}
              {c.score.total !== null && (
                <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                  {c.score.bands.map((b) => (
                    <li key={b.key} className="text-xs text-[var(--sys-muted-foreground)]">
                      {b.ar}{' '}
                      <span className="tabular-nums text-[var(--sys-foreground)]">
                        {b.value === null ? 'لم يُقَس' : null}
                        {b.value !== null && b.unit === 'money' ? <Money value={b.value} /> : null}
                        {b.value !== null && b.unit === 'rate' ? `${Math.round(b.value)}%` : null}
                      </span>{' '}
                      <span className="tabular-nums font-semibold text-[var(--sys-heading)]">
                        {b.points === null ? '—' : `${b.points}/${b.weight}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {/* The plain counts under the bands, so the score can be checked
                  against the orders it was built from. */}
              <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--sys-muted)] tabular-nums">
                <span>{c.brought} طلب</span>
                <span>{c.delivered} مسلَّم</span>
                <span>{c.returned} مرتجع من {c.doorDecided} بتَّ فيه الباب</span>
                <span className="text-[var(--sys-foreground)]"><Money value={c.revenue} /> وصلت الباب</span>
                {c.returnRate !== null && (
                  <HealthChip health={healthOf('returnRate', c.returnRate, c.doorDecided)} />
                )}
              </p>
            </li>
          ))}

          {/*
            THE ORDERS THAT CAME THROUGH NO DOOR AT ALL.

            A row, not an omission. Every share above is a share of the shop's
            orders, and a total that quietly excludes fourteen of them makes
            every other row look bigger than it is. It carries no score: «no
            channel» is not a channel, and grading it would invent a door.
          */}
          {shop.withoutChannel > 0 && (
            <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-3">
              <span className="w-5" />
              <span className="text-sm font-bold text-[var(--sys-muted-foreground)]">بلا قناة</span>
              <span className="text-xs text-[var(--sys-muted)] tabular-nums">
                {shop.withoutChannel} طلب من {shop.orders}
                {shop.withoutChannelShare !== null ? ` · ${shop.withoutChannelShare}%` : ''}
              </span>
              <span className="ms-auto text-xs text-[var(--sys-muted-foreground)]">
                لا سكور — الطلب لم يُنسب لباب، وهذه نسبة تُسدّ عند الإدخال لا هنا.
              </span>
            </li>
          )}
        </ul>
      )}

      {graded.length > 0 && graded.length < rows.length && (
        <p className="text-xs text-[var(--sys-muted)]">
          {graded.length} من {rows.length} قناة عليها ما يكفي للحكم — البقية تُقاس حين تكبر، لا الآن.
        </p>
      )}
    </div>
  );
}


/**
 * The section the board draws: reads its own report, and is silent when the
 * report is refused or fails — the tables above it stand without it.
 */
export function ChannelScoresSection() {
  const [perf, setPerf] = useState<{ channels: ChannelPerf[]; shop: ShopSpread } | null>(null);

  const load = useCallback(async () => {
    try {
      setPerf(await apiJson<{ channels: ChannelPerf[]; shop: ShopSpread }>('/api/settings/channels/performance'));
    } catch {
      setPerf(null);
    }
  }, []);

  useLiveRefresh(load);

  return <ChannelScores perf={perf} />;
}
