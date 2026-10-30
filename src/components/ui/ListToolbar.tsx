'use client';

import React, { useEffect, useId, useRef } from 'react';
import { RiArrowGoBackLine, RiSearchLine } from '@remixicon/react';
import { Button } from './Button';
import { Select } from './Input';

/**
 * THE SEARCH BOX AND THE DROPDOWNS UNDER IT — ONE COPY, FOR EVERY LIST.
 *
 * «العملاء بدي الهم فلاتر», then the same for the postponed, the cancelled-
 * and-recoverable, the returns and the shipments under follow-up. The shape the
 * customers screen found is the one all of them want, so it is written once:
 *
 *   · a search box, with the placeholder saying WHAT it searches — a box that
 *     does not say is a box people type the wrong thing into;
 *   · the dropdowns, ALWAYS DRAWN, each with its label above it and its numbers
 *     beside the words — a filter behind a button is one nobody finds, and a
 *     number that cannot be pressed is a question the screen asks and will not
 *     let you follow («القرار المركزي يُرى ولا يُطلب فتحه»);
 *   · «إعادة تعيين (N)» only while something is chosen, with the count — and
 *     nothing at all when nothing is, so the row does not hold a dead button.
 *
 * It owns no state. The screen holds what was chosen (so it can send it, and
 * start again at page one when it changes — see `usePagedList`) and hands it
 * back here to draw; this is a face, not a store.
 *
 * A desk that SCANS has three more needs, each optional and each off by default:
 * the scan button beside the box (`searchExtra` — a scan is a search typed by a
 * camera, so it lands in the same box), the cursor already in it (`searchAutoFocus`
 * — a hand holding a parcel has no hand free to click), and a left-to-right box
 * (`searchDir` — a waybill is Latin, and in a right-to-left box «123-ABC» reads
 * back to front). A screen that asks for none of them gets exactly the markup
 * it always had.
 *
 * And one for a screen whose field must be a REAL label (`searchLabel`): a
 * `<label htmlFor>` is clickable and widens the hit area of the box, which on a
 * phone is the difference between a tap that lands and one that does nothing;
 * an `aria-label` is announced and is neither. The shipment follow-up holds that
 * bar in a test, so its box is drawn with the word «بحث» above it.
 *
 * Every class below is one the customers screen already carried, so the
 * stylesheet does not grow by a byte for the fifth list.
 */

export interface ToolbarFilter {
  /** Stable, for the key and for tests. */
  key: string;
  /** Above the box: what this question is. */
  label: string;
  /** The chosen value; `all` is no filter. */
  value: string;
  /** In the order they read. The first should be «كل …» with the value `all`. */
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}

/**
 * THE CHOSEN VALUE IS ALWAYS IN THE BOX.
 *
 * The numbers beside the options come from the server and are counted over what the list can hold NOW, so a choice
 * made a moment ago may have no row left in them (the last parcel of a courier was just received). The box must not
 * snap back to «all» behind the reader's back, or draw an empty control: the choice stays in the list, with a zero.
 */
export const withChosen = (value: string, options: ToolbarFilter['options']): ToolbarFilter['options'] =>
  value === 'all' || options.some((o) => o.value === value) ? options : [...options, { value, label: `${value} (0)` }];

export function ListToolbar({
  search,
  onSearch,
  placeholder,
  filters,
  activeCount,
  onReset,
  searchExtra,
  searchAutoFocus,
  searchDir,
  searchLabel,
}: {
  search: string;
  onSearch: (value: string) => void;
  /** What the box searches: «بحث برقم الطلب أو اسم العميل أو هاتفه…». */
  placeholder: string;
  filters: ToolbarFilter[];
  /** How many of the filters (and the search) are not at their default. */
  activeCount: number;
  onReset: () => void;
  /** Something that belongs beside the box — a scan button. Nothing, for the lists that have none. */
  searchExtra?: React.ReactNode;
  /** The cursor is in the box when the screen opens. */
  searchAutoFocus?: boolean;
  /** `ltr` for a box that takes codes. Unset, the box follows the page. */
  searchDir?: 'ltr' | 'rtl';
  /** A visible label above the box, wired to it as a real `<label htmlFor>`. Unset, the box is named by its placeholder. */
  searchLabel?: string;
}) {
  const searchId = useId();
  // «The cursor is in the box when the screen opens» is a desk's convenience — a hand holding a parcel has no
  // hand free to click. On a phone it raises the keyboard over half the list before anybody has asked to
  // search, so it is done only where the main pointer is a mouse (and where nothing can say, as before).
  const searchBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!searchAutoFocus) return;
    const hasMouse = typeof window.matchMedia !== 'function' || window.matchMedia('(pointer: fine)').matches;
    if (hasMouse) searchBox.current?.focus();
  }, [searchAutoFocus]);
  const icon = <RiSearchLine className="absolute left-3 rtl:left-auto rtl:right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--sys-muted)]" />;
  const input = (
    <input
      type="text"
      id={searchLabel ? searchId : undefined}
      aria-label={searchLabel ? undefined : placeholder}
      placeholder={placeholder}
      value={search}
      onChange={(e) => onSearch(e.target.value)}
      ref={searchBox}
      dir={searchDir}
      className="h-11 md:h-auto w-full pl-9 pr-4 rtl:pl-4 rtl:pr-9 md:py-2 text-xs bg-[var(--sys-card)] border border-[var(--sys-border-input)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--sys-primary)]/30 focus:border-[var(--sys-primary)] shadow-raised"
    />
  );
  const box = (
    <div className={searchExtra ? 'relative max-w-md flex-1' : 'relative max-w-md'}>
      {searchLabel ? (
        <>
          <label htmlFor={searchId} className="block text-xs font-medium text-[var(--sys-heading)] mb-1.5">
            {searchLabel}
          </label>
          <div className="relative">
            {icon}
            {input}
          </div>
        </>
      ) : (
        <>
          {icon}
          {input}
        </>
      )}
    </div>
  );

  return (
    <div className="space-y-2">
      {searchExtra ? (
        <div className="flex items-center gap-2">
          {box}
          {searchExtra}
        </div>
      ) : (
        box
      )}

      {(filters.length > 0 || activeCount > 0) && (
        <div className="grid grid-cols-2 items-end gap-2 md:grid-cols-4">
          {filters.map((f) => (
            <Select key={f.key} label={f.label} value={f.value} onChange={(e) => f.onChange(e.target.value)} className="text-xs py-2">
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          ))}

          {activeCount > 0 && (
            <Button variant="outline" onClick={onReset} className="w-full gap-1.5 text-[var(--sys-destructive)]">
              <RiArrowGoBackLine className="icon-mirror w-4 h-4" />
              إعادة تعيين ({activeCount})
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
