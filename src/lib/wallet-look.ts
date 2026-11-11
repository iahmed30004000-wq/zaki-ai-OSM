/**
 * THE LOOK OF A WALLET — A PICTURE, AN ICON AND A COLOUR, AND THE ONE PLACE THAT DECIDES THEM.
 *
 * The owner, 11/11: «كل محفظة لازم تكون مميزة — ابحث عن صور عشان البنت تميزها بسرعة.» A girl who moves money between
 * five wallets reads a name, a country and a currency on every one of them, and the names are alike. She recognises a
 * wallet the way she recognises a drawer: by what it looks like. So every wallet may carry
 *
 *   · a PICTURE  — what the owner uploads (the exchange's logo, the bank's card, a photo of the drawer);
 *   · an ICON    — one of the few in `WALLET_ICON_KEYS`;
 *   · a COLOUR   — one of the few in `WALLET_COLOR_KEYS`, each a variable of the theme (so it follows the dark and
 *                  the light themes and keeps the contrast the theme was tuned for).
 *
 * A wallet with nothing set STILL looks like itself and unlike its neighbours: the icon its currency says, and a
 * colour picked from its own id — the same colour every time, on every screen, for as long as the id exists.
 *
 * ONE FUNCTION DECIDES WHAT A WALLET WEARS: `walletLook`. A screen asks it and draws the answer; none re-derives an
 * icon or a colour (the day a second screen guessed its own colour, one wallet would be green here and violet there).
 *
 * THIS FILE HOLDS THE ALLOWED LISTS TOO, AND THE SERVER READS THEM FROM HERE. The door that saves a look validates
 * against these arrays, so a screen cannot offer a choice the door refuses and a client cannot save one the screen
 * cannot draw. It is plain data and functions — no React, no storage, no database — so the door, the screens and the
 * tests all import the same thing.
 */

/* ── the icons ───────────────────────────────────────────────────────────── */

/** What a wallet's money IS, in a picture. The component for each key is in `components/ui/WalletPicture.tsx`. */
export const WALLET_ICON_KEYS = ['cash', 'bank', 'wallet', 'coins', 'crypto', 'phone', 'card', 'dollar', 'drawer'] as const;
export type WalletIconKey = (typeof WALLET_ICON_KEYS)[number];

/** The name of each icon, as the person hears it (the button's name for a screen reader, and its tooltip). */
export const WALLET_ICON_LABEL: Record<WalletIconKey, string> = {
  cash: 'نقد',
  bank: 'بنك',
  wallet: 'محفظة',
  coins: 'عملات',
  crypto: 'عملة رقمية',
  phone: 'هاتف',
  card: 'بطاقة',
  dollar: 'دولار',
  drawer: 'درج',
};

export const isWalletIconKey = (value: unknown): value is WalletIconKey =>
  typeof value === 'string' && (WALLET_ICON_KEYS as readonly string[]).includes(value);

/**
 * THE ICON A WALLET WEARS WHEN NOBODY CHOSE ONE — what its currency says.
 *
 * A dollar for dollars, coins for any other three-letter currency, a plain wallet for a code that is not one. It is
 * the rule `walletGlyph` has always applied (`WalletChip` keeps that name and answers it from here).
 */
export function defaultWalletIconKey(currencyCode: string | null | undefined): WalletIconKey {
  const c = (currencyCode ?? '').trim().toUpperCase();
  if (c === 'USD') return 'dollar';
  if (c.length === 3) return 'coins';
  return 'wallet';
}

/* ── the colours ─────────────────────────────────────────────────────────── */

/**
 * THE COLOURS A WALLET MAY WEAR — eight variables of the system theme, named by the variable.
 *
 * `primary`, `success`, `warning` and `destructive` are the theme's four named hues. `chart-3`, `chart-4`, `chart-5`
 * and `chart-6` are four of the six chart series, which every one of the thirteen themes tunes to clear 3:1 on its own
 * surfaces. NOTHING NEW IS INVENTED: a key is `--sys-<key>`, and `a-wallet-wears-its-own-look.test.ts` reads the theme
 * list and fails if one of these ever stops being a variable every theme declares.
 *
 * WHY THESE FOUR OF THE SIX. The first pick was `chart-2` instead of `chart-5`, and it was MEASURED against the themes
 * (CIE76 distance between each pair of the eight, in every theme): in `day` and `calm` `chart-2` IS `primary` — the same
 * hex, distance 0 — and in `layl` it sits 6 from `destructive`. Of the forty-five ways to take eight of the ten candidates
 * this is the one whose closest pair, in the worst theme, is farthest apart; in the default theme every pair is at least
 * 25 apart, in eleven of the thirteen at least 16. The test beside it keeps that: a token swapped for one that matches
 * another colour in some theme fails there.
 *
 * The key is the VARIABLE, not a colour word, on purpose: «بنفسجي» is a lie in the themes where `chart-3` is blue, and
 * a person looking at the dots does not read a name — she reads a colour.
 */
export const WALLET_COLOR_KEYS = ['primary', 'success', 'warning', 'destructive', 'chart-3', 'chart-4', 'chart-5', 'chart-6'] as const;
export type WalletColorKey = (typeof WALLET_COLOR_KEYS)[number];

export const isWalletColorKey = (value: unknown): value is WalletColorKey =>
  typeof value === 'string' && (WALLET_COLOR_KEYS as readonly string[]).includes(value);

/** The theme variable a colour key wears — a value for a `style`, not a class: the stylesheet does not grow for it. */
export const walletColorVar = (key: WalletColorKey): string => `var(--sys-${key})`;

/**
 * A SMALL PURE HASH — the same text always gives the same number, and nearby ids give far-apart numbers.
 *
 * FNV-1a over the characters, then the murmur3 finalizer: FNV alone leaves its low bits poorly mixed, and a colour is
 * chosen by `% 8`, which reads exactly those bits. Nothing here is secret or needs to be: it only has to be stable.
 */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * THE COLOUR A WALLET WEARS WHEN NOBODY CHOSE ONE — picked from its own id, so it never moves.
 *
 * It cannot know its neighbours (the transfers screen lists the whole company, the wallets screen one store), so two
 * wallets can land on the same colour — about one pair in eight. That is why the icon, the picture and the editor
 * exist: the default makes wallets differ at once, and the owner finishes the job where two still look alike.
 */
export function defaultWalletColorKey(walletId: string | null | undefined): WalletColorKey {
  return WALLET_COLOR_KEYS[hash32(String(walletId ?? '')) % WALLET_COLOR_KEYS.length];
}

/* ── the picture ─────────────────────────────────────────────────────────── */

/**
 * WHAT A WALLET'S PICTURE MAY BE — png, jpeg or webp. NO SVG, which can carry a script.
 *
 * The limit is smaller than the shop's pictures' (10 MB): this one is drawn 32 to 44 pixels wide. The door shrinks the
 * longest side to `WALLET_IMAGE_SIDE` before it is stored, so what is kept is a few kilobytes.
 */
export const WALLET_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const WALLET_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const WALLET_IMAGE_SIDE = 256;

/** The sentences the screen and the door both say, so a refusal reads the same wherever it is caught first. */
export const WALLET_IMAGE_BAD_TYPE = 'صيغة الملف غير مدعومة. المسموح: PNG وJPG وWEBP';
export const WALLET_IMAGE_TOO_BIG = 'حجم الصورة يتجاوز الحد المسموح (5 ميجابايت)';
/** One sentence for every key that is not this wallet's own — a foreign one, a URL, a path: none is told apart. */
export const WALLET_IMAGE_NOT_OURS = 'هالصورة مش من صور هالمحفظة — ارفعها من جديد';

const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const IMAGE_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:webp|png|jpg)$/;

/**
 * `companies/{company}/products/{wallet}/{uuid}.{webp|png|jpg}` — the key the picture door writes, taken apart.
 *
 * The folder is the shop's own (`saveProductImage` writes `…/products/{namespace}/…`, and the media door serves exactly
 * that shape to the company that owns it); the wallet's id is the namespace, which is what makes a picture belong to
 * ONE wallet. Anything else — another depth, a dot segment, a backslash, a scheme, a URL, a file name that is not a
 * uuid — is not a key of ours and comes back null.
 */
export function parseWalletImageKey(key: unknown): { companyId: string; walletId: string; file: string } | null {
  if (typeof key !== 'string' || key.length > 200) return null;
  const parts = key.split('/');
  if (parts.length !== 5 || parts[0] !== 'companies' || parts[2] !== 'products') return null;
  if (!SEGMENT.test(parts[1]) || !SEGMENT.test(parts[3]) || !IMAGE_FILE.test(parts[4])) return null;
  return { companyId: parts[1], walletId: parts[3], file: parts[4] };
}

export const isWalletImageKey = (key: unknown): key is string => parseWalletImageKey(key) !== null;

/**
 * IS THIS KEY ONE THAT THIS COMPANY'S PICTURE DOOR WROTE FOR THIS VERY WALLET?
 *
 * The rule the PATCH door applies before it writes a key onto a wallet, in the media door's own terms (the company is
 * the first folder) plus one more: the wallet's own id is the next. Without the company a key of another company would
 * be saved; without the wallet, any picture the company holds — a product's, the shop's — could be hung on a wallet.
 */
export function isOwnWalletImageKey(key: unknown, own: { companyId: string; walletId: string }): key is string {
  const parsed = parseWalletImageKey(key);
  return parsed !== null && parsed.companyId === own.companyId && parsed.walletId === own.walletId;
}

/** Where a key is served from. Only for a key that passed `isWalletImageKey` — `walletLook` is the one caller. */
export const walletImageUrl = (key: string): string => `/api/media/${key}`;

/* ── the look ────────────────────────────────────────────────────────────── */

/** What `walletLook` needs of a wallet: who it is, what it holds, and whatever look was saved on it. */
export interface WalletLookSource {
  id: string;
  currencyCode: string;
  imageKey?: string | null;
  iconKey?: string | null;
  colorKey?: string | null;
}

export interface WalletLook {
  /** The address of the picture, when the wallet has a well-formed one. Absent otherwise. */
  image?: string;
  /** Always an icon: what was chosen, or what the currency says. It is also what is drawn when the picture cannot load. */
  icon: WalletIconKey;
  /** Always a colour: what was chosen, or the one the wallet's id picks. */
  color: WalletColorKey;
}

/**
 * WHAT A WALLET WEARS. Set values win; what is not set — or is not one of the allowed keys — falls back, never fails.
 *
 * A key that is not in the lists (a value written by a newer release and read by an older one, or by hand) is treated as
 * unset rather than drawn as nothing: a wallet always has an icon and a colour, and a picture only when its key is one
 * the door could have written.
 */
export function walletLook(wallet: WalletLookSource): WalletLook {
  return {
    ...(isWalletImageKey(wallet.imageKey) ? { image: walletImageUrl(wallet.imageKey) } : {}),
    icon: isWalletIconKey(wallet.iconKey) ? wallet.iconKey : defaultWalletIconKey(wallet.currencyCode),
    color: isWalletColorKey(wallet.colorKey) ? wallet.colorKey : defaultWalletColorKey(wallet.id),
  };
}
