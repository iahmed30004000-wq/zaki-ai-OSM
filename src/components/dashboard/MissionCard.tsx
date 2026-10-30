'use client';

import React from 'react';
import Link from 'next/link';
import { RiArrowRightLine } from '@remixicon/react';
import { missionFor, missionSentence, type Mission } from '@/lib/mission-card';
import { useMayOpen } from '@/hooks/useMayOpen';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';
import type { WorkItem } from '@/lib/my-work';

/**
 * «مهمّتك الجاية» — THE FIRST CARD OF THE DASHBOARD, DRAWN AS ONE THING.
 *
 * The owner's plan, المرحلة ١: «بطاقة «مهمّتك الجاية» أول الرئيسية لكل دور:
 * الرقم من السيرفر وزر واحد». The rule it follows is the one `WorkToday` was
 * written under: the count is the SERVER's, from `/api/me/work`, printed as it
 * arrived — `the-frontend-invariants.test.ts` holds the whole product to that,
 * and a mission card is the last place a browser should start adding.
 *
 * It EXTENDS `WorkToday`, it does not replace it: the grid of every count that
 * is not zero stays, with its sentences and its tests. This is the one card
 * above it that answers «what do I do FIRST», which a grid of six answers only
 * by making the reader rank them. Draws nothing while the answer has not come,
 * and nothing for a person whose work has no door to it — the same silences
 * `WorkToday` keeps, for the same reasons.
 *
 * A person who may open none of the screens their work leads to gets nothing
 * either: a button that ends in «لا تملك صلاحية» is the exact failure the
 * dashboard's own guard exists for (`useMayOpen`).
 *
 * ── ONE DOOR, NOT TWO ──
 *
 * It takes the items `WorkToday` already fetched instead of calling
 * `/api/me/work` a second time. Two pollers a minute apart would be two
 * requests for one answer, and — worse — the card and the grid beneath it
 * could disagree for a minute at a time about what is waiting. The owner's
 * plan gives the dashboard ONE card; it does not give it a second copy of the
 * count.
 */
export function MissionCard({ items }: { items: readonly WorkItem[] }) {
  const mayOpen = useMayOpen();
  const { currentUser } = useApp();
  const mission = missionFor(items, mayOpen, (key) => !!currentUser && userCan(currentUser, key));
  if (!mission) return null;
  return <MissionCardView mission={mission} />;
}

/**
 * THE CARD ITSELF, ALONE SO A TEST CAN RENDER IT WITH A MISSION IN HAND.
 *
 * One number, one sentence, one button. No icon, no illustration, no second
 * link: the mission is not one item among many here — it is THE item, and the
 * grid below carries the rest. The heading is the plan's own name for the
 * card, so the reader learns what this thing above them is called.
 */
export function MissionCardView({ mission }: { mission: Mission }) {
  return (
    <section
      aria-labelledby="mission-card"
      className="rounded-lg border border-[var(--sys-primary)] bg-[var(--sys-card)] p-4"
    >
      <h2 id="mission-card" className="mb-1 text-xs font-bold text-[var(--sys-muted-foreground)]">
        مهمّتك الجاية
      </h2>
      <p className="text-base font-semibold text-[var(--sys-heading)] tabular-nums" data-testid="mission-sentence">
        {missionSentence(mission)}
      </p>
      <Link
        href={mission.href}
        className="mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-md bg-[var(--sys-primary)] px-4 text-sm font-semibold text-white hover:opacity-90 md:min-h-10"
      >
        {mission.cta}
        <RiArrowRightLine className="icon-mirror h-4 w-4 shrink-0" aria-hidden />
      </Link>
    </section>
  );
}
