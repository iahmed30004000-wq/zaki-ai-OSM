'use client';

import React from 'react';

/**
 * The button that sends a visitor to the form.
 *
 * A plain `#anchor` lands on the TOP of the form card — its coloured header,
 * the product name, the price — and the visitor still has to find the first
 * field and tap it. So this scrolls to the form's FIRST field and focuses it:
 * one tap, the cursor is in the box, and on a phone the keyboard is already
 * up.
 *
 * The first field is the shop's to choose («الدفع» orders them), so the form
 * marks it (`data-zf-first`) and this reads the mark. The name field — the
 * first one until the shop could order them — is the answer when nothing is
 * marked, and the anchor href stays as the fallback for a browser with no JS.
 */
export function OrderCta({
  className,
  children,
  ref,
  ...rest
}: {
  className: string;
  children: React.ReactNode;
  /** The floating one watches the form through this. React 19 takes a ref
      as an ordinary prop, so there is no forwardRef wrapper to explain. */
  ref?: React.Ref<HTMLAnchorElement>;
  /** `data-edit` and friends — the button's words are the seller's to type. */
  [key: `data-${string}`]: string | undefined;
}) {
  function go(e: React.MouseEvent<HTMLAnchorElement>) {
    const field =
      document.querySelector<HTMLElement>('#zaki-order-form [data-zf-first]') ?? document.getElementById('zf-full_name');
    if (!field) return; // let the href do its job
    e.preventDefault();
    field.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Focus after the scroll, or the browser jumps a second time.
    window.setTimeout(() => field.focus({ preventScroll: true }), 450);
  }

  return (
    <a href="#zf-full_name" onClick={go} className={className} ref={ref} {...rest}>
      {children}
    </a>
  );
}
