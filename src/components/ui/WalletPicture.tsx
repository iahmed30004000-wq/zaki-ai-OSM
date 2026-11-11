'use client';

import React, { useState } from 'react';
import clsx from 'clsx';
import {
  RiArchiveDrawerLine,
  RiBankCardLine,
  RiBankLine,
  RiBitCoinLine,
  RiCashLine,
  RiCoinsLine,
  RiMoneyDollarCircleLine,
  RiSmartphoneLine,
  RiWallet3Line,
  type RemixiconComponentType,
} from '@remixicon/react';
import { defaultWalletIconKey, walletColorVar, walletLook, type WalletIconKey, type WalletLookSource } from '@/lib/wallet-look';

/**
 * A WALLET'S FACE — drawn from `walletLook`, and nowhere else.
 *
 * It is a small square beside a name: the owner's picture when the wallet has one, otherwise its icon in its colour.
 * Every screen that names a wallet draws THIS, so one wallet is the same face in the list, in the transfer chips, in the
 * ledger's heading and in the dialogs; none of them chooses an icon or a colour of its own.
 *
 * IT IS DECORATION, AND SAYS SO: `aria-hidden`, and the picture's `alt` is empty — the wallet's name is always written
 * next to it, and a screen reader that read «صورة» before every name would only be slower. For the same reason it
 * never carries a word of its own.
 *
 * A PICTURE THAT WILL NOT LOAD (the file is gone, the connection dropped, the volume was restored from before it) falls
 * back to the icon in the colour — the face the wallet wears without a picture — instead of a broken-image square. The
 * failure is remembered for THAT address only, so a new picture is tried afresh.
 *
 * THE COLOUR IS A THEME VARIABLE IN A `style`, NOT A CLASS: eight colours as eight classes would be eight more rules in
 * the stylesheet every page of the system loads, and a `style` costs it nothing. The tint behind the icon is the colour
 * at a sixteenth over whatever is under it, so it reads on the dark themes and on the light ones; the picture keeps the
 * colour as its edge, so a wallet with a picture is still found by its colour.
 */

/** The component for each icon key. Exhaustive by type: a key added to `WALLET_ICON_KEYS` without one does not compile. */
export const WALLET_ICON_COMPONENT: Record<WalletIconKey, RemixiconComponentType> = {
  cash: RiCashLine,
  bank: RiBankLine,
  wallet: RiWallet3Line,
  coins: RiCoinsLine,
  crypto: RiBitCoinLine,
  phone: RiSmartphoneLine,
  card: RiBankCardLine,
  dollar: RiMoneyDollarCircleLine,
  drawer: RiArchiveDrawerLine,
};

/**
 * The glyph a wallet wears when nobody chose one — what its currency says. It is the name `WalletChip` has always had for
 * this, kept so that an older caller and its tests still stand; the rule itself is `defaultWalletIconKey`.
 */
export function walletGlyph(currencyCode: string): RemixiconComponentType {
  return WALLET_ICON_COMPONENT[defaultWalletIconKey(currencyCode)];
}

/** Pixels: a chip or a row (32), a card (44), the editor's preview (64). Never below 32 — a face is for recognising. */
const SIDE = { sm: 32, md: 44, lg: 64 } as const;
export type WalletPictureSize = keyof typeof SIDE;

export function WalletPicture({
  wallet,
  size = 'md',
  className,
}: {
  wallet: WalletLookSource;
  size?: WalletPictureSize;
  className?: string;
}) {
  const look = walletLook(wallet);
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = look.image !== undefined && failed !== look.image;
  const Icon = WALLET_ICON_COMPONENT[look.icon];
  const side = SIDE[size];
  const colour = walletColorVar(look.color);

  return (
    <span
      aria-hidden="true"
      data-wallet-picture=""
      data-icon={look.icon}
      data-color={look.color}
      data-has-image={showImage ? 'true' : 'false'}
      style={{
        width: side,
        height: side,
        color: colour,
        borderColor: colour,
        backgroundColor: `color-mix(in srgb, ${colour} 16%, transparent)`,
      }}
      className={clsx('inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg border', className)}
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={look.image}
          alt=""
          loading="lazy"
          onError={() => setFailed(look.image ?? null)}
          className="h-full w-full object-cover"
        />
      ) : (
        <Icon size={Math.round(side / 2)} />
      )}
    </span>
  );
}
