'use client';

import React from 'react';
import { Button, type ButtonProps } from './Button';

/**
 * A BUTTON WITH A PICTURE AND NO WORDS — AND THEREFORE A NAME IT MUST BE GIVEN.
 *
 * About eighty-six of the hand-written buttons in the product are an icon
 * and nothing else: a pencil, a bin, an arrow. A screen reader announces
 * «زر» for each and stops, and the hover text a mouse shows is not a name
 * (see the note in `Button` on why `title` is no substitute).
 *
 * So `label` is required — by the type, so a call without one does not
 * compile, and at run time in development, so an empty one (the type cannot
 * tell `''` from a sentence) is said out loud in the console instead of
 * shipping a nameless control. It becomes the accessible name and the
 * tooltip both, and the picture is hidden from a screen reader so the name
 * is not read as the icon's own name followed by the label.
 *
 * IT IS A `Button` UNDERNEATH — the promise-as-busy-flag, the tick and the
 * shake are the same code, not a copy: a row action that deletes something
 * must not be pressable twice either.
 *
 * AND THE HIT AREA IS THE CONTROL. 44px square on a phone, 32 · 40 · 44 on a
 * desk, with the width stated beside the height (`Button`'s `square`).
 * Nothing invisible grows past the edge to be tapped, so the control beside
 * it is never covered by this one's reach.
 */
export interface IconButtonProps
  extends Omit<ButtonProps, 'children' | 'aria-label' | 'aria-labelledby' | 'title' | 'square'> {
  /** What pressing it does, in a few Arabic words. The accessible name. */
  label: string;
  /** The picture: an icon, drawn at 16px or 20px. */
  children: React.ReactNode;
}

export function IconButton({ label, children, variant = 'quiet', size = 'md', ...props }: IconButtonProps) {
  const nameless = typeof label !== 'string' || label.trim() === '';
  React.useEffect(() => {
    if (nameless && process.env.NODE_ENV !== 'production') {
      console.error('IconButton: لا اسم له — مرّر label بجملة تقول ماذا يفعل الزرّ.');
    }
  }, [nameless]);

  return (
    <Button
      {...props}
      square
      variant={variant}
      size={size}
      aria-label={nameless ? undefined : label}
      title={nameless ? undefined : label}
    >
      <span aria-hidden="true" className="inline-flex">
        {children}
      </span>
    </Button>
  );
}
