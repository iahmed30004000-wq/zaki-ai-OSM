'use client';

import React from 'react';
import { EmptyState } from './EmptyState';

/**
 * A TABLE ON A DESK, CARDS IN A HAND.
 *
 * A thirteen-column table on a 360px screen does one of two things: it
 * scrolls sideways, so the row's name is off-screen by the time you reach
 * the number you wanted; or it squeezes, so every cell wraps to four lines
 * and one row fills the phone. Both are the same mistake — a layout built
 * for a shape the device does not have.
 *
 * So the same data renders twice from ONE description of it: a table above
 * `md`, and a card per row below it, each field carrying its own label. Not
 * a second component, not a second query, not a second set of columns that
 * drifts from the first — one `columns` array, read two ways.
 *
 * `primary` marks the one or two fields that title the card. On a phone
 * somebody scans for the order number, not for the tenth column, and a card
 * whose heading is "٣" is a card nobody can scan.
 *
 * `hideOnPhone` drops a column from the cards only. A table can afford a
 * field that is occasionally useful; a card cannot, and thirteen labelled
 * lines is the sideways scroll again, turned vertical.
 */

/**
 * HOW BADLY A ROW NEEDS READING — AND IN WHICH COLOUR.
 *
 * `alert` was a boolean, so every row that needed attention was the same
 * red. The owner's note: «تمييزُ الصفوف: أحمر للملغى، برتقاليّ لمن فيه
 * تعديل». Those are two different sentences to the person scanning forty
 * rows — a cancelled order means STOP CHASING THIS, and a changed one
 * means the address you just read is not the one that is true now. One
 * colour for both says only «something», which is what a reader learns to
 * ignore.
 *
 * `true` still means red, so every screen that passes a boolean keeps the
 * tint it had. Nothing, `false` or `null` means an untouched row.
 */
export type RowTone = 'danger' | 'warn';

/**
 * The tint, per tone, in both shapes this component renders.
 *
 * The card carries the border too: a card has no neighbours above and
 * below to read a background against, so a tinted card with a grey border
 * reads as a rendering accident rather than a warning.
 *
 * `/40` on the fill in both, so the text on top keeps its contrast — these
 * are the same soft tokens the chips inside the row already use, and a row
 * at full strength would compete with the chip it contains.
 */
const ROW_TONE: Record<RowTone, { desk: string; card: string }> = {
  danger: {
    desk: 'bg-[var(--sys-destructive-soft)]/40',
    card: 'border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)]/40',
  },
  warn: {
    desk: 'bg-[var(--sys-warning-soft)]/40',
    card: 'border-[var(--sys-warning)]/40 bg-[var(--sys-warning-soft)]/40',
  },
};

export interface Column<T> {
  key: string;
  /** The column heading, and the label on the card. */
  label: string;
  render: (row: T) => React.ReactNode;
  /** Titles the card. Keep it to one or two. */
  primary?: boolean;
  /** In the table, not on the card. */
  hideOnPhone?: boolean;
  /** Numbers read right-aligned in a table and inline on a card. */
  align?: 'start' | 'end';
  /**
   * A value that is not a figure: buttons, a list, a sentence.
   *
   * On a card every field is a label and a value on ONE line, which is right
   * for «٣» and wrong for two decisions and a comments link, or a list of
   * receipts: they are squeezed into whatever the label left over and wrap
   * into a column a thumb cannot aim at. `wide` puts the label above and the
   * value under it at the full width of the card. A table is unchanged.
   */
  wide?: boolean;
  className?: string;
}

export interface RowsProps<T> {
  columns: Column<T>[];
  /** Absent while the request is in the air; drawn as empty. */
  rows: T[] | null | undefined;
  keyOf: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Said when there is nothing — never an empty frame with no explanation. */
  empty?: React.ReactNode;
  /** Rendered under every card and after every table row's cells. */
  actions?: (row: T) => React.ReactNode;
  /**
   * Picking rows, for the screens that act on a batch of them.
   *
   * `canSelect` decides which rows may be picked at all — a shipment that
   * is not collectable has no checkbox rather than a checkbox that refuses.
   * On a phone the checkbox sits in the card's heading, where a thumb is,
   * instead of in a first column somebody has to aim at.
   */
  selection?: {
    canSelect: (row: T) => boolean;
    isSelected: (row: T) => boolean;
    onToggle: (row: T, next: boolean) => void;
    /**
     * Pick every selectable row at once, or drop them all.
     *
     * Not optional out of politeness: picking thirty orders one at a time
     * is the reason people stop picking and print them one by one. It sits
     * in the table's own heading on a desk, and above the cards on a
     * phone, where there is no heading row to put it in.
     */
    onToggleAll?: (next: boolean) => void;
  };
  /**
   * Marks a row as needing attention, and says in which colour.
   *
   * `'danger'` is red, `'warn'` is orange, `true` is red — see `RowTone`.
   * A row with nothing to say returns nothing and is left alone.
   */
  alert?: (row: T) => boolean | RowTone | null | undefined;
  /**
   * THE ONE THING ABOUT THIS ROW THAT MUST BE READ BEFORE ITS FIELDS.
   *
   * A card has no full-width region, and that is why a warning on one ends
   * up as either a chip crushed into the heading beside the reference, or a
   * label/value line squeezed into the right half of a `<dl>` row. Neither
   * is a warning; both are a field. The tracking screen's «أُلغي الطلب —
   * الطرد ما زال عند الشحن» is not a field: it decides whether anything else
   * on the card is worth acting on, and it carries its own button.
   *
   * CARD ONLY, and deliberately. The desk already has a place for this — a
   * column, read at a glance beside everything else — while a row spanning
   * every column of a table is ambiguous about whether it belongs to the row
   * above it or below it. So the screen puts it in a column for the table
   * and here for the hand, from one render function, which is the same deal
   * every `column` already makes.
   *
   * Returning nothing draws nothing: a row with no notice is untouched, and
   * so is every screen that passes no `notice` at all.
   */
  notice?: (row: T) => React.ReactNode;
}

export function Rows<T>({ columns, rows, keyOf, onRowClick, empty, actions, selection, alert, notice }: RowsProps<T>) {
  /**
   * ONE READING OF `alert`, used by both shapes.
   *
   * The table and the cards each used to write their OWN class string off
   * it. Two renderings of one rule is how a tone ends up red on a desk and
   * orange in a hand — the defect this file exists to avoid in the first
   * place, repeated inside it.
   *
   * It is still called once per row PER SHAPE, because the table and the
   * cards are two separate loops and both are in the DOM. That is unchanged
   * and is not what this fixes.
   */
  const toneOf = (row: T): RowTone | null => {
    const v = alert?.(row);
    if (v === true) return 'danger';
    return v === 'danger' || v === 'warn' ? v : null;
  };
  /**
   * A LIST THAT HAS NOT ARRIVED IS NOT A CRASH.
   *
   * `rows.length` on an undefined list took the dashboard down with
   * «Cannot read properties of undefined» — the orders come from
   * `analytics?.orders?.slice(…)`, which is undefined until the request
   * lands. Every screen that fetches has that moment, and a shared table
   * that dies in it is a trap set for every future caller.
   *
   * Nothing is invented: an absent list draws exactly what an empty one
   * draws, which is the truth of the situation.
   */
  if (!rows || rows.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)]">
        {empty ?? (
          // The default says as little as it honestly can. A list that is
          // empty because a filter is narrow and a list that is empty
          // because nothing was ever created are different situations with
          // different answers, and only the SCREEN knows which it is — so
          // the caller passes an <EmptyState> that names the one it means.
          <EmptyState
            title="لا شيء هنا"
            why="إمّا أنّ الفلاتر أضيق من أن تُطابق شيئاً، أو لم يُسجَّل شيءٌ بعد."
          />
        )}
      </div>
    );
  }

  const selectable = selection ? rows.filter(selection.canSelect) : [];
  const allPicked = selectable.length > 0 && selectable.every(selection!.isSelected);

  const onCard = columns.filter((c) => !c.hideOnPhone);
  const titles = onCard.filter((c) => c.primary);
  const details = onCard.filter((c) => !c.primary);

  return (
    <>
      {/* The desk. */}
      <div className="hidden overflow-x-auto rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] md:block">
        <table className="w-full text-sm">
          <thead className="bg-[var(--sys-surface)] text-xs text-[var(--sys-muted-foreground)]">
            <tr>
              {selection && (
                <th className="w-10 px-3 py-2">
                  {selection.onToggleAll && selectable.length > 0 && (
                    <input
                      type="checkbox"
                      checked={allPicked}
                      onChange={(e) => selection.onToggleAll!(e.target.checked)}
                      aria-label={allPicked ? 'ألغِ اختيار الكل' : 'اختر الكل'}
                    />
                  )}
                </th>
              )}
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={`px-3 py-2 font-medium ${c.align === 'end' ? 'text-left' : 'text-right'}`}
                >
                  {c.label}
                </th>
              ))}
              {actions && <th className="px-3 py-2" />}
            </tr>
          </thead>
          {/*
            A ROW THAT OPENS SOMETHING IS A CONTROL, AND ONLY THEN.
            Every accessibility attribute below is conditional on
            `onRowClick`: making a row that does nothing focusable would
            put a tab stop on every line of every table in the product.
          */}
          <tbody className="divide-y divide-[var(--sys-border)]">
            {rows.map((row) => {
              const tone = toneOf(row);
              return (
              <tr
                key={keyOf(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                role={onRowClick ? 'button' : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        // Only when the row itself has focus — a key pressed
                        // in a checkbox or a button inside it is theirs.
                        if (e.target !== e.currentTarget) return;
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onRowClick(row);
                        }
                      }
                    : undefined
                }
                className={`${onRowClick ? 'cursor-pointer hover:bg-[var(--sys-surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sys-primary)] focus-visible:ring-inset' : ''} ${
                  tone ? ROW_TONE[tone].desk : ''
                }`}
              >
                {selection && (
                  <td className="px-3 py-2">
                    {selection.canSelect(row) && (
                      <input
                        type="checkbox"
                        checked={selection.isSelected(row)}
                        onChange={(e) => selection.onToggle(row, e.target.checked)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={selection.isSelected(row) ? 'ألغِ اختيار السجل' : 'اختر السجل'}
                      />
                    )}
                  </td>
                )}
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={`px-3 py-2 ${c.align === 'end' ? 'text-left' : 'text-right'} ${c.className ?? ''}`}
                  >
                    {c.render(row)}
                  </td>
                ))}
                {actions && <td className="px-3 py-2">{actions(row)}</td>}
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* The hand. */}
      {selection?.onToggleAll && selectable.length > 0 && (
        // There is no heading row on a phone, so the select-all sits above
        // the cards. Without it the only way to pick thirty is thirty taps.
        <label className="mb-2 flex min-h-11 items-center gap-2 px-1 text-xs text-[var(--sys-muted-foreground)] md:min-h-0 md:hidden">
          <input
            type="checkbox"
            className="h-5 w-5"
            checked={allPicked}
            onChange={(e) => selection.onToggleAll!(e.target.checked)}
          />
          {allPicked ? 'ألغِ اختيار الكل' : `اختر الكل (${selectable.length})`}
        </label>
      )}
      <ul className="space-y-2 md:hidden">
        {rows.map((row) => {
          const flag = notice?.(row);
          const tone = toneOf(row);
          return (
          <li
            key={keyOf(row)}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            role={onRowClick ? 'button' : undefined}
            tabIndex={onRowClick ? 0 : undefined}
            onKeyDown={
              onRowClick
                ? (e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onRowClick(row);
                    }
                  }
                : undefined
            }
            className={`rounded-lg border bg-[var(--sys-card)] p-3 ${
              onRowClick
                ? 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sys-primary)]'
                : ''
            } ${tone ? ROW_TONE[tone].card : 'border-[var(--sys-border)]'}`}
          >
            {/* Above the heading, because a reader who has already read the
                reference and rung the customer has been told too late. */}
            {flag && <div className="mb-2">{flag}</div>}

            {(titles.length > 0 || selection) && (
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--sys-border)] pb-1.5">
                {/*
                  A TITLE THAT CANNOT BREAK MUST NOT PUSH THE CARD WIDER.
                  A statement's file name, a barcode, a reference is one
                  unbroken string, and in a flex line with no `min-w-0` its
                  width is the string's: it pushed the status chip off the
                  card and the page sideways. The line wraps, the box may
                  shrink below its content, and the string breaks where it
                  has to rather than overflowing.
                */}
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  {selection && selection.canSelect(row) && (
                    /**
                     * A 44px TARGET AROUND A 20px BOX.
                     *
                     * A checkbox is a replaced element: `::before` and
                     * `::after` never render on one, so the trick that grows
                     * a button's hit area silently does nothing here — and it
                     * was on this line, doing nothing, until the browser was
                     * asked whether a press 21px away landed.
                     *
                     * A <label> works because pressing a label toggles the
                     * input inside it. The box keeps its size; the label is
                     * the thumb's target.
                     */
                    <label
                      className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        className="h-5 w-5"
                        checked={selection.isSelected(row)}
                        onChange={(e) => selection.onToggle(row, e.target.checked)}
                        aria-label={selection.isSelected(row) ? 'ألغِ اختيار السجل' : 'اختر السجل'}
                      />
                    </label>
                  )}
                  {titles.map((c) => (
                    <span key={c.key} className="min-w-0 break-words text-sm font-semibold text-[var(--sys-heading)]">
                      {c.render(row)}
                    </span>
                  ))}
                </span>
              </div>
            )}

            <dl className="space-y-1">
              {details.map((c) => (
                <div key={c.key} className={c.wide ? 'flex flex-col gap-1' : 'flex items-baseline justify-between gap-3'}>
                  {/* Every field says what it is. A bare number on a card is
                      a number somebody has to count columns to identify. */}
                  <dt className="shrink-0 text-xs text-[var(--sys-muted-foreground)]">{c.label}</dt>
                  <dd className={`min-w-0 break-words text-xs text-[var(--sys-foreground)] ${c.className ?? ''}`}>
                    {c.render(row)}
                  </dd>
                </div>
              ))}
            </dl>

            {actions && (
              // `card-acts` is in system.css: under a finger its buttons and
              // links are 44px tall, whatever the caller drew them as.
              <div className="card-acts mt-2 flex flex-wrap gap-2 border-t border-[var(--sys-border)] pt-2">
                {actions(row)}
              </div>
            )}
          </li>
          );
        })}
      </ul>
    </>
  );
}
