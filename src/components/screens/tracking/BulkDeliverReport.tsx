'use client';

import React from 'react';
import { RiCheckLine, RiCloseLine } from '@remixicon/react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';

/**
 * THE REPORT OF «استلم المحدد» — ONE LINE PER PARCEL, SAID BY THE SERVER, KEPT UNTIL THE PERSON READS IT.
 *
 * A press over a page can go through for some parcels and be refused for others, and a green sentence at the top that says
 * «انسجّل 8» tells nobody which two did not. So every parcel gets its line: its reference, then either that it was recorded or
 * the short reason the door gave. The reasons are the server's own words (the screen composes none), and the card stays
 * until «تمام» — the list under it has already moved on, so this is the only place the refused ones are still named.
 */

export interface BulkDeliverLine {
  id: string;
  /** What the row called itself on the screen: the merchant's reference, or our number. */
  label: string;
  ok: boolean;
  reason?: string;
}

export function BulkDeliverReport({
  lines,
  delivered,
  refused,
  onClose,
}: {
  lines: BulkDeliverLine[];
  delivered: number;
  refused: number;
  onClose: () => void;
}) {
  return (
    // The region keeps its name (a screen reader finds the report by it); the surface inside it is the kit's page-level card.
    <section aria-label="تقرير الاستلام الجماعي">
      <Card padding="sm" className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold text-[var(--sys-heading)]">
            {refused === 0 ? `انسجّل ${delivered} طرد` : `انسجّل ${delivered} وما انسجّل ${refused}`}
          </p>
          <Button type="button" variant="quiet" size="sm" onClick={onClose} className="mr-auto">
            تمام
          </Button>
        </div>
        <ul className="space-y-1 max-h-[70vh] overflow-y-auto">
          {lines.map((l) => (
            <li key={l.id} className="flex items-start gap-1.5 text-note">
              {l.ok ? (
                <RiCheckLine className="w-4 h-4 text-[var(--sys-success)] shrink-0" aria-hidden />
              ) : (
                <RiCloseLine className="w-4 h-4 text-[var(--sys-destructive)] shrink-0" aria-hidden />
              )}
              <span className="font-medium text-[var(--sys-heading)]">{l.label}</span>
              <span className="text-[var(--sys-muted-foreground)]">{l.ok ? 'انسجّل' : l.reason}</span>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}
