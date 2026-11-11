'use client';

import React from 'react';
import clsx from 'clsx';
import { Money } from '@/components/ui/Money';
import { WalletPicture } from '@/components/ui/WalletPicture';

/**
 * A WALLET, AS A THING YOU TOUCH — NOT A LINE IN A DROP-DOWN.
 *
 * A transfer is picked by looking: whose money, in which country, in which
 * currency. A native list squeezes that into one line of grey text inside a
 * menu nobody can read the balance of. A chip says it in the open — the name,
 * «البلد · العملة», and what is in it — and a row of them is one press per
 * choice instead of open, scroll, choose.
 *
 * THE PICTURE IS THE WALLET'S OWN. The owner uploads his own image for it (his
 * drawer, his bank's card) or picks an icon and a colour; a wallet with none of
 * those wears the glyph its currency says — a dollar for dollars, coins for
 * anything else, a wallet for a currency nobody has named — in a colour picked
 * from its id. What a wallet wears is decided in ONE place (`walletLook`) and
 * drawn by ONE component (`WalletPicture`): this is the seam the glyph used to
 * be, and the chip replaced one line to take the picture.
 *
 * A TARGET A THUMB CAN HIT: 44px tall on a phone, the desk's height above it.
 * Pressed is said in words for a screen reader (`aria-pressed`) and in the
 * border and weight for the eye — never in colour alone.
 */

export interface ChipWallet {
  id: string;
  name: string;
  currencyCode: string;
  /** What is in it now. Omitted when the viewer does not see balances. */
  balance?: number;
  country?: { name: string } | null;
  /** The look saved on the wallet (lib/wallet-look) — each null, or absent, until somebody chooses. */
  imageKey?: string | null;
  iconKey?: string | null;
  colorKey?: string | null;
}

/** The glyph a wallet of this currency wears with nothing chosen — kept here under the name the chip always had for it. */
export { walletGlyph } from '@/components/ui/WalletPicture';

export function WalletChip({
  wallet,
  selected,
  disabled,
  onPick,
}: {
  wallet: ChipWallet;
  selected: boolean;
  /** The other end of the transfer already holds it: a wallet cannot send to itself. */
  disabled?: boolean;
  onPick: (id: string) => void;
}) {
  const where = [wallet.country?.name, wallet.currencyCode].filter(Boolean).join(' · ');

  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={() => onPick(wallet.id)}
      className={clsx(
        'inline-flex items-center gap-2 rounded-lg border px-3 py-2 min-h-11 md:min-h-0 text-start text-sm disabled:opacity-50',
        selected
          ? 'border-[var(--sys-primary)] bg-[var(--sys-surface)] font-semibold'
          : 'border-[var(--sys-border)] bg-[var(--sys-card)]'
      )}
    >
      <WalletPicture wallet={wallet} size="sm" />
      <span className="min-w-0">
        <span className="block text-sm">{wallet.name}</span>
        <span className="block text-xs font-normal text-[var(--sys-muted)]">{where}</span>
        {typeof wallet.balance === 'number' && (
          <span className="block text-xs font-normal text-[var(--sys-muted)]">
            <Money value={wallet.balance} currency={wallet.currencyCode} />
          </span>
        )}
      </span>
    </button>
  );
}
