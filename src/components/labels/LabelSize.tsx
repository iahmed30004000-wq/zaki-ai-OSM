'use client';

import React, { useCallback, useId, useSyncExternalStore } from 'react';
import { LABEL_SIZES } from '@/lib/labels';

/**
 * WHICH PAPER THE WAYBILL IS PRINTED ON.
 *
 * Three screens print waybills — the orders list, the batches screen and
 * the labels screen — and two of them used to send 100×150 no matter what
 * was loaded in the printer. A warehouse on A4 got thermal-sized labels
 * from the orders screen and correct ones from the labels screen, from the
 * same order, on the same afternoon.
 *
 * The fix is not a third dropdown. The size is a property of the PRINTER IN
 * THE ROOM, not of the click: nobody swaps a thermal roll for A4 between
 * one batch and the next. So it is chosen once and remembered on that
 * device, and every print button in the system reads the same answer.
 *
 * Per device is the point. Two people on two machines with two printers
 * must not overwrite each other's choice, which is exactly what storing it
 * on the account would do.
 */

const KEY = 'salesflow.labelSize';
const DEFAULT_KEY = LABEL_SIZES[0].key;

export interface LabelDims {
  width: number;
  height: number;
  sheetWidth?: number;
  sheetHeight?: number;
}

interface Stored {
  key: string;
  custom: { width: number; height: number };
}

const FALLBACK: Stored = { key: DEFAULT_KEY, custom: { width: 100, height: 150 } };

/** The custom size the server takes: whole millimetres, 40 to 300. */
export const CUSTOM_MIN_MM = 40;
export const CUSTOM_MAX_MM = 300;
/** Under this width a 12-digit barcode's bars get too thin for a 203-dpi head. */
export const NARROW_BARCODE_MM = 60;

/**
 * A typed millimetre, as it may leave this device.
 *
 * The boxes hold what is being typed — «7» on the way to «75», «75.5» —
 * and the batch endpoint refuses anything that is not a whole number from
 * 40 to 300. So the number is settled HERE, before any print button reads
 * it: rounded, then held inside the range. An empty box or nonsense is the
 * default, not 40.
 */
export function wholeMm(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(CUSTOM_MAX_MM, Math.max(CUSTOM_MIN_MM, Math.round(n)));
}

function settled(custom: { width: number; height: number }) {
  return { width: wholeMm(custom.width, FALLBACK.custom.width), height: wholeMm(custom.height, FALLBACK.custom.height) };
}

/** Storage can throw or come back empty; a print button must still work. */
function read(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return FALLBACK;
    const parsed = JSON.parse(raw) as Partial<Stored>;
    const key = typeof parsed.key === 'string' ? parsed.key : DEFAULT_KEY;
    return {
      key,
      custom: settled({ width: Number(parsed.custom?.width), height: Number(parsed.custom?.height) }),
    };
  } catch {
    return FALLBACK;
  }
}

/** The millimetres to send, from a remembered choice. Never a half-typed one. */
export function dimsOf(stored: Stored): LabelDims {
  const preset = LABEL_SIZES.find((s) => s.key === stored.key);
  if (!preset) return settled(stored.custom);
  return {
    width: preset.width,
    height: preset.height,
    sheetWidth: preset.sheet?.width,
    sheetHeight: preset.sheet?.height,
  };
}

/**
 * ONE ANSWER, HOWEVER MANY COMPONENTS ASK.
 *
 * This was a hook over localStorage with a `useState` inside it, and that
 * is why choosing a size did nothing. A screen calls it once for the size
 * it will print at, and renders `<LabelSizePicker />`, which calls it again
 * for the dropdown — two calls, two independent pieces of React state, and
 * nothing connecting them:
 *
 *   `setItem` does not notify the document that called it. The `storage`
 *   event fires in OTHER tabs, by specification, never in this one.
 *
 * So the dropdown changed, storage changed, and the print button went on
 * sending the size that was in storage when the screen mounted. It started
 * working after a reload, which is why it read as "sometimes" and why
 * nobody could pin it down.
 *
 * `useSyncExternalStore` is the cure: one store, every subscriber told at
 * once, in this tab and in the others. The snapshot is cached because the
 * hook compares snapshots by identity — parsing fresh JSON on every render
 * returns a new object each time and spins for ever.
 */

type Listener = () => void;
const listeners = new Set<Listener>();
let snapshot: Stored | null = null;

function currentSnapshot(): Stored {
  if (snapshot === null) snapshot = read();
  return snapshot;
}

function publish(next: Stored) {
  snapshot = next;
  for (const l of listeners) l();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  // Another TAB changing the printer must not leave this one printing the
  // old size either. Same store, both directions.
  const fromOtherTab = (e: StorageEvent) => {
    if (e.key === KEY) publish(read());
  };
  window.addEventListener('storage', fromOtherTab);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', fromOtherTab);
  };
}

/**
 * The server has no localStorage. Rendering the stored size there and the
 * default here would mismatch the markup the server sent, so the server
 * snapshot is always the fallback and the real one arrives on hydration.
 */
const serverSnapshot = (): Stored => FALLBACK;

/** Only for tests: forget what this process has cached. */
export function forgetLabelSize(): void {
  snapshot = null;
}

export function useLabelSize() {
  const stored = useSyncExternalStore(subscribe, currentSnapshot, serverSnapshot);

  const update = useCallback((next: Stored) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* a printer choice is not worth failing a print over */
    }
    // Published even if the write threw: the person chose, and this tab
    // must print what they chose whether or not the choice outlives it.
    publish(next);
  }, []);

  const dims = dimsOf(stored);
  return {
    stored,
    dims,
    label: LABEL_SIZES.find((s) => s.key === stored.key)?.label ?? `${dims.width}×${dims.height} مم`,
    setKey: (key: string) => update({ ...stored, key }),
    setCustom: (custom: { width: number; height: number }) => update({ ...stored, custom }),
  };
}

const INPUT =
  'w-full h-11 md:h-10 px-2 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] text-xs text-[var(--sys-foreground)] focus:outline-none focus:border-[var(--sys-primary)]';

/**
 * The picker itself. `compact` is the one-line form that sits beside a
 * print button in a toolbar; the full form adds the custom millimetres.
 */
export function LabelSizePicker({
  compact,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  const { stored, dims, setKey, setCustom } = useLabelSize();
  const widthId = useId();
  const heightId = useId();
  // Leaving a box writes back what will print, so the box never shows a
  // number the printer is not going to get.
  const settle = () => setCustom(settled(stored.custom));
  // What every custom box shares; each box is still written out below, so
  // the screen census counts the four fields that are on the screen.
  const box = (which: 'width' | 'height') => ({
    type: 'number',
    inputMode: 'numeric' as const,
    min: CUSTOM_MIN_MM,
    max: CUSTOM_MAX_MM,
    step: 1,
    value: stored.custom[which],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setCustom({ ...stored.custom, [which]: Number(e.target.value) }),
    onBlur: settle,
  });
  const narrow =
    stored.key === 'custom' && dims.width < NARROW_BARCODE_MM ? (
      <p className="text-xs text-[var(--sys-warning)] mt-1">
        عرض أقل من {NARROW_BARCODE_MM} مم — الباركود ممكن ما يقرأه الماسح.
      </p>
    ) : null;

  const select = (
    <select
      value={stored.key}
      onChange={(e) => setKey(e.target.value)}
      title="مقاس البوليصة — يُحفظ على هذا الجهاز"
      aria-label="مقاس البوليصة"
      className={compact ? `${INPUT} w-auto max-w-[13rem]` : INPUT}
    >
      {LABEL_SIZES.map((s) => (
        <option key={s.key} value={s.key}>
          {s.label}
        </option>
      ))}
      <option value="custom">مقاس مخصص</option>
    </select>
  );

  if (compact) {
    return (
      <div className={className}>
        {select}
        {stored.key === 'custom' && (
          <span className="ms-2 inline-flex items-center gap-1" dir="ltr">
            {/* Named where they stand: two bare number boxes were a guess at which is which. */}
            <label htmlFor={widthId} className="text-xs text-[var(--sys-muted)]">
              العرض (مم)
            </label>
            <input {...box('width')} id={widthId} className={`${INPUT} w-16`} />
            <span className="text-xs text-[var(--sys-muted)]">×</span>
            <label htmlFor={heightId} className="text-xs text-[var(--sys-muted)]">
              الطول (مم)
            </label>
            <input {...box('height')} id={heightId} className={`${INPUT} w-16`} />
          </span>
        )}
        {narrow}
      </div>
    );
  }

  return (
    <div className={className}>
      <label className="block text-xs text-[var(--sys-muted-foreground)] mb-1">مقاس البوليصة</label>
      {select}
      {stored.key === 'custom' && (
        <div className="grid grid-cols-2 gap-2 mt-2" dir="ltr">
          <div>
            <label htmlFor={widthId} className="block text-xs text-[var(--sys-muted-foreground)] mb-1">
              العرض (مم)
            </label>
            <input {...box('width')} id={widthId} className={INPUT} />
          </div>
          <div>
            <label htmlFor={heightId} className="block text-xs text-[var(--sys-muted-foreground)] mb-1">
              الطول (مم)
            </label>
            <input {...box('height')} id={heightId} className={INPUT} />
          </div>
        </div>
      )}
      {narrow}
      {/* WHAT IT WILL LOOK LIKE.
          A dropdown reading «A5 على ورقة A4» tells somebody the words; it
          does not tell them the waybill will come out lying on its side.
          Drawn to the real proportions, and to real millimetres where the
          screen can (`mm` is a CSS unit), so choosing is looking. */}
      <SizePreview />
      <p className="text-xs text-[var(--sys-muted)] mt-1">يُحفظ على هذا الجهاز ويُستعمل في كل شاشات الطباعة.</p>
    </div>
  );
}

/**
 * The chosen size, drawn.
 *
 * Scaled down by a fixed factor rather than stretched to fit: a preview
 * that fills its box whatever the size teaches nothing, because 100×150
 * and 210×297 then look identical. At this scale the difference between a
 * thermal label and a sheet of A4 is the difference you can see.
 *
 * The sheet is drawn too when the label shares one, with the labels that
 * fit on it — "4 لكل ورقة" is a claim, and this is the claim shown.
 */
function SizePreview() {
  const { dims, label } = useLabelSize();
  const sheetW = dims.sheetWidth ?? dims.width;
  const sheetH = dims.sheetHeight ?? dims.height;
  const across = Math.max(1, Math.floor(sheetW / dims.width));
  const down = Math.max(1, Math.floor(sheetH / dims.height));

  // 0.35mm of screen per mm of paper: A4 fits in a card, a thermal label
  // stays visibly smaller than it.
  const SCALE = 0.35;

  return (
    <figure className="mt-2 flex items-center gap-3">
      <div
        className="shrink-0 border border-[var(--sys-border-strong)] bg-[var(--sys-card)]"
        style={{ width: `${sheetW * SCALE}mm`, height: `${sheetH * SCALE}mm` }}
      >
        <div
          className="grid h-full w-full"
          style={{
            gridTemplateColumns: `repeat(${across}, 1fr)`,
            gridTemplateRows: `repeat(${down}, 1fr)`,
          }}
        >
          {Array.from({ length: across * down }, (_, i) => (
            <span key={i} className="border border-dashed border-[var(--sys-primary)]/40" />
          ))}
        </div>
      </div>
      <figcaption className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
        {label}
        <span className="block" dir="ltr" data-testid="preview-mm">
          {dims.width}×{dims.height} mm
        </span>
        {across * down > 1 && <span className="block">{across * down} لكل ورقة</span>}
      </figcaption>
    </figure>
  );
}
