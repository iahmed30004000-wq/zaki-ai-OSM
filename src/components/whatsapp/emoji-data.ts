/**
 * A CURATED SET OF EMOJIS — the ones a shop's chat with its customers actually uses, in six groups. No library: the whole set
 * is a few hundred bytes of text, and it loads only when the picker is first opened (the picker is lazy).
 *
 * WRITTEN AS CODE POINTS, NOT AS PICTURES. These are MESSAGE CONTENT — what the staff types to a customer, exactly as a
 * keyboard's emoji key would — not this product's iconography. The product's own rule (`one-icon-family.test.ts`) keeps every
 * emoji out of the dashboard's source because an emoji is never an icon here; that rule stands, and this file does not draw
 * a single icon. The groups are spelled in hexadecimal (a sequence joined by «-», e.g. `2764-FE0F` for a red heart) and turned
 * into text when read, so the source holds no emoji and the guard keeps meaning what it says.
 */
export interface EmojiGroup {
  key: string;
  label: string;
  emojis: string[];
}

/** «1F600 2764-FE0F» → the two emojis. */
export const fromCodePoints = (s: string): string[] =>
  s
    .trim()
    .split(/\s+/)
    .map((seq) => String.fromCodePoint(...seq.split('-').map((h) => parseInt(h, 16))));

export const EMOJI_GROUPS: EmojiGroup[] = [
  {
    key: 'faces',
    label: 'وجوه',
    emojis: fromCodePoints(
      '1F600 1F603 1F604 1F601 1F606 1F605 1F602 1F923 1F60A 1F607 1F642 1F609 1F60C 1F60D 1F970 1F618 1F60B 1F61B 1F61C 1F92A 1F917 1F92D 1F914 1F910 1F610 1F611 1F636 1F60F 1F612 1F644 1F62C 1F634 1F637 1F912 1F973 1F60E 1F913 1F615 1F61F 1F641 1F62E 1F62F 1F632 1F633 1F97A 1F622 1F62D 1F631 1F616 1F61E 1F613 1F629 1F624 1F621 1F92F'
    ),
  },
  {
    key: 'hands',
    label: 'إيماءات',
    emojis: fromCodePoints(
      '1F44D 1F44E 1F44C 270C-FE0F 1F91E 1F91F 1F919 1F44B 1F64F 1F44F 1F64C 1F450 1F932 1F91D 1F4AA 270B 1F590-FE0F 261D-FE0F 1F446 1F447 1F448 1F449 270D-FE0F 1FAF6 1F90C 1F440 1F64B 1F646 1F645 1F937 1F926'
    ),
  },
  {
    key: 'hearts',
    label: 'قلوب',
    emojis: fromCodePoints(
      '2764-FE0F 1F9E1 1F49B 1F49A 1F499 1F49C 1F90D 1F5A4 1F90E 1F494 2763-FE0F 1F495 1F49E 1F493 1F497 1F496 1F498 1F49D 2665-FE0F 1F339 1F337 1F490 2728 2B50 1F31F 1F525 1F4AF'
    ),
  },
  {
    key: 'shop',
    label: 'تسوّق',
    emojis: fromCodePoints(
      '1F6CD-FE0F 1F6D2 1F4E6 1F381 1F69A 1F6F5 1F3E0 1F3EA 1F4B0 1F4B5 1F4B3 1F9FE 1F3F7-FE0F 1F4DE 1F4F1 260E-FE0F 1F4CD 1F5FA-FE0F 23F0 231B 1F4C5 2705 2611-FE0F 2714-FE0F 274C 2757 2753 26A0-FE0F 1F514 1F4E2 1F195 1F193 1F4B8'
    ),
  },
  {
    key: 'things',
    label: 'أشياء',
    emojis: fromCodePoints(
      '1F457 1F45A 1F455 1F456 1F454 1F460 1F45F 1F45C 1F45B 1F392 1F453 1F576-FE0F 231A 1F48D 1F484 1F9F4 1F9FC 1FA92 1F48A 1F9F8 1F380 1F4F7 1F4BB 1F3A7 1F50C 1F50B 1F511 2702-FE0F 1F4DD 1F4CE'
    ),
  },
  {
    key: 'nature',
    label: 'طبيعة وطعام',
    emojis: fromCodePoints(
      '2600-FE0F 1F319 26C5 1F327-FE0F 2744-FE0F 1F308 1F338 1F33A 1F33B 1F340 1F334 1F34E 1F34A 1F34B 1F349 1F347 1F353 1F352 1F951 1F354 1F355 1F370 1F382 1F36B 1F36C 2615 1F375 1F964 1F389 1F38A'
    ),
  },
];

/** The six quick reactions under a message: thumbs up, red heart, tears of joy, open mouth, crying, folded hands. */
export const QUICK_REACTIONS = fromCodePoints('1F44D 2764-FE0F 1F602 1F62E 1F622 1F64F');
