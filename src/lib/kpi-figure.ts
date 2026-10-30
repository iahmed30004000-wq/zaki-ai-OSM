import React from 'react';
import { moneyText } from './money';

/**
 * THE BIG NUMBER ON A CARD HAS TO STAY INSIDE THE CARD.
 *
 * «بتحس الأرقام طالعة من مكانها» — the owner, looking at the dashboard at
 * 1546px. The figure was one size, 32px, whatever it said: «60%» had room to
 * spare and «257,229.32 USD» (fourteen characters) filled the card from edge
 * to edge, touching the border it should have sat well inside.
 *
 * SO THE SIZE FOLLOWS THE LENGTH, ON THE STEPS THE TYPE SCALE ALREADY HAS.
 *
 * Four steps, taken from the ladder the product ships (display · 2xl · xl ·
 * lg), so the stylesheet gains nothing: the longer the figure, the smaller
 * the step, and a short one keeps the full size that makes a card a card.
 * This is DISPLAY ONLY. The figure arrives from the server already worked
 * out; nothing here adds, rounds or reads a currency into a number.
 *
 * WHY A COUNT OF CHARACTERS AND NOT A MEASUREMENT.
 *
 * Measuring needs the browser, and a card is drawn on the server first: the
 * figure would paint large and then jump. A count is the same on both sides,
 * and the steps leave room for the difference between a narrow digit and a
 * wide one.
 */

/** Longest text each step carries, in characters, and the step it takes. */
export const FIGURE_STEPS: ReadonlyArray<{ upTo: number; size: string }> = [
  { upTo: 9, size: 'text-display' },
  { upTo: 12, size: 'text-2xl' },
  { upTo: 15, size: 'text-xl' },
  { upTo: Number.POSITIVE_INFINITY, size: 'text-lg' },
];

/** The size class for a figure that prints as `text`. */
export function figureScale(text: string): string {
  const length = text.trim().length;
  for (const step of FIGURE_STEPS) {
    if (length <= step.upTo) return step.size;
  }
  return FIGURE_STEPS[FIGURE_STEPS.length - 1].size;
}

/**
 * WHAT A FIGURE WILL PRINT, WORKED OUT WITHOUT DRAWING IT.
 *
 * A card is handed a node, usually a `<Money value=… />`, and the length of
 * what it prints is the only thing the size needs. A string or a number is
 * itself; a list is its parts; an element that carries a `value` and no
 * children is a money figure and is spelled out the way `Money` spells it
 * (with a three-letter code when it does not name one, which is the common
 * case and errs on the side of the longer, hence the smaller, text).
 */
export function figureText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(figureText).join('');
  if (React.isValidElement(node)) {
    const props = node.props as {
      value?: number | string | null;
      currency?: string | null;
      minorUnit?: number;
      children?: React.ReactNode;
    };
    if (props.children !== undefined) return figureText(props.children);
    if (props.value !== undefined) {
      const n = Number(props.value ?? 0);
      const code = props.currency === null ? null : props.currency ?? 'USD';
      return moneyText(Number.isFinite(n) ? n : 0, code, props.minorUnit ?? 2);
    }
  }
  return '';
}
