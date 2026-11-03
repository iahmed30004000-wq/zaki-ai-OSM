import { z } from 'zod';
import { LAYOUT_SLOTS } from './layout-slots';
import { richTextSchema } from './rich-text';
import { COUNTDOWN_SOURCES, countdownRefusal, type CountdownFact } from './countdown';
import { fontValueSchema } from './landing-theme';

/**
 * LANDING SECTIONS — a page is an ordered list of blocks, not a blob of HTML.
 *
 * The old editor handed the seller a textarea and asked for HTML. That gives
 * total freedom and, in practice, an ugly page: nobody writing a product page
 * at midnight is also going to get the spacing rhythm right.
 *
 * So the page is assembled from a FIXED set of blocks. The seller chooses
 * which to show, in what order, and what goes in them. Every block is already
 * designed and already themed, so the worst page anyone can build here is a
 * plain one — never a broken one.
 *
 * Content that the system already knows (product name, price, the offer
 * tiers, the regions) is NOT copied into a block. The block names the source
 * and the renderer reads it live, so raising a price in the catalogue raises
 * it on the page instead of leaving a stale number to sell at.
 */

// ─────────────────────────────────────────────────────
// The blocks
// ─────────────────────────────────────────────────────

/**
 * HOW A BLOCK LOOKS — the same three questions for all thirteen.
 *
 * Every block already knows WHAT it says. This is how wide it sits, where
 * its content lines up, how much air it gets, and what is behind it. Put on
 * the shared base rather than into each block, so adding a look never means
 * touching thirteen schemas and remembering all of them.
 *
 * Nothing here is a pixel, and nothing here is per-device. A phone, a
 * tablet and a desktop are not three designs to keep in step by hand — they
 * are one intention rendered at three widths. "wide" means wide on a laptop
 * and edge-to-edge on a phone because that is what wide MEANS on a phone.
 * The renderer does that with clamp(); the seller never sees a breakpoint.
 */
const background = z.object({
  kind: z.enum(['none', 'solid', 'gradient', 'image']).default('none'),
  /** Solid fill, or the first stop of a gradient. */
  from: z.string().max(9).default(''),
  /** The second stop. Gradients only. */
  to: z.string().max(9).default(''),
  angle: z.number().int().min(0).max(360).default(160),
  image: z.string().max(2048).default(''),
  /**
   * How much dark is laid over a background image, 0–0.8.
   *
   * Not decoration: white text on somebody's photograph is unreadable
   * exactly as often as the photograph is bright, and that is discovered
   * by the customer, not by the person who chose the photo.
   */
  overlay: z.number().min(0).max(0.8).default(0.35),
}).default({ kind: 'none', from: '', to: '', angle: 160, image: '', overlay: 0.35 });

/**
 * The words themselves.
 *
 * An empty value means "whatever the page decided" — the theme's font, the
 * palette's colour, the block's own size. That is deliberate: a page where
 * every block was set by hand is a page where changing the theme changes
 * nothing, and the theme is the thing that keeps it looking like one page.
 *
 * The font list is the THEME's list, not a second one. A page with two font
 * systems has two ways to be wrong.
 */
const typography = z.object({
  /**
   * '' = the page's own font; otherwise a key from the theme's library, or
   * an uploaded family as `u:<slug>`.
   *
   * This was a hardcoded list, and it had fallen eight faces behind the
   * picker: the seller could choose them and the save would be rejected
   * with "أقسام الصفحة غير صالحة", which names nothing. One rule now, in
   * landing-theme, and the list is no longer written down twice.
   */
  font: fontValueSchema,
  /** Relative, never px — so it still fits on a phone. */
  scale: z.enum(['xs', 's', 'm', 'l', 'xl']).default('m'),
  weight: z.enum(['', 'normal', 'medium', 'bold', 'black']).default(''),
  italic: z.boolean().default(false),
  /** The body text. '' = derived from the palette and what is behind it. */
  color: z.string().max(9).default(''),
  /**
   * Headings, separately.
   *
   * One colour for a whole block turned the heading, the price and the
   * button's words the same shade — which is almost never what anybody
   * means. A heading is its own decision; '' follows the body colour.
   */
  headingColor: z.string().max(9).default(''),
}).default({ font: '', scale: 'm', weight: '', italic: false, color: '', headingColor: '' });

/**
 * The order button, which is not text.
 *
 * It was taking the block's font colour, so choosing red for a paragraph
 * turned the words on a green button red too. A button has its own fill,
 * its own label colour and its own size, and they are asked for here.
 */
const button = z.object({
  /** '' = the theme's accent, which is the safe default. */
  fill: z.string().max(9).default(''),
  label: z.string().max(9).default(''),
  size: z.enum(['s', 'm', 'l']).default('m'),
  /** Full width on the row it sits in — the usual choice on a phone. */
  wide: z.boolean().default(false),
}).default({ fill: '', label: '', size: 'm', wide: false });

export type BlockButton = z.infer<typeof button>;

export type BlockTypography = z.infer<typeof typography>;

const look = z.object({
  width: z.enum(['narrow', 'normal', 'wide', 'full']).default('normal'),
  align: z.enum(['start', 'center', 'end']).default('center'),
  space: z.enum(['none', 'tight', 'normal', 'roomy']).default('normal'),
  background,
  text: typography,
  button,
}).default({
  width: 'normal',
  align: 'center',
  space: 'normal',
  background: { kind: 'none', from: '', to: '', angle: 160, image: '', overlay: 0.35 },
  text: { font: '', scale: 'm', weight: '', italic: false, color: '', headingColor: '' },
  button: { fill: '', label: '', size: 'm', wide: false },
});

export type BlockLook = z.infer<typeof look>;
export type BlockBackground = z.infer<typeof background>;

const base = { id: z.string().min(1), enabled: z.boolean().default(true), look };

/** A thin strip above everything — free delivery, a deadline, a promise. */
const announcement = z.object({
  ...base,
  type: z.literal('announcement'),
  text: richTextSchema(140).default(''),
});

/** The first screen: image, headline, price, and the button that scrolls to the form. */
const hero = z.object({
  ...base,
  type: z.literal('hero'),
  /**
   * WHAT THE FIRST SCREEN LEADS WITH.
   *
   * From the engine's parts catalogue, so a template and a page cannot
   * name different things — and so there is no name here that means «the
   * shop's name, alone», which is «البطل ضايع على الاسم» and the first
   * complaint the brief makes about this storefront.
   */
  variant: z.enum(LAYOUT_SLOTS.hero).default('productFirst'),
  image: z.string().max(2048).default(''),
  headline: richTextSchema(120).default(''),
  subheadline: richTextSchema(240).default(''),
  /** Show the product's price from the catalogue under the headline. */
  showPrice: z.boolean().default(true),
  ctaText: z.string().max(40).default('اطلب الآن'),
});

/** Why to buy it. Short lines, not paragraphs. */
const benefits = z.object({
  ...base,
  type: z.literal('benefits'),
  title: richTextSchema(120).default(''),
  items: z.array(z.object({
    title: richTextSchema(80).default(''),
    text: richTextSchema(200).default(''),
  })).max(8).default([]),
});

/** More photos. People buy what they can see. */
const gallery = z.object({
  ...base,
  type: z.literal('gallery'),
  title: richTextSchema(120).default(''),
  images: z.array(z.string().max(2048)).max(12).default([]),
  /**
   * HOW THE PICTURES SIT.
   *
   * `grid` is the gallery as it always was: squares, two across. `stack` is one picture under another at its
   * own shape, uncropped — for a poster that IS the page (a tall picture with its words on it), where a
   * square would cut the words. Additive: every saved page lacks the field and reads as `grid`.
   */
  layout: z.enum(['grid', 'stack']).default('grid'),
});

/**
 * A link a seller may put on their page.
 *
 * Only http(s) and same-site paths. `javascript:` and `data:` are the two
 * that turn a footer link into a script running on the page, and a landing
 * page is public, so the check lives in the schema — the one place both the
 * editor and the server go through.
 */
const externalUrl = z
  .string()
  .max(2048)
  .refine(
    (v) => v === '' || /^https?:\/\//i.test(v) || /^\/[^/]/.test(v) || /^(mailto|tel):/i.test(v),
    'رابط غير صالح'
  );

/**
 * Photos that turn by themselves — the first screen of a product, one image
 * at a time. The same uploads as the gallery; the difference is the
 * movement, and the visitor can always swipe or stop it.
 */
const slider = z.object({
  ...base,
  type: z.literal('slider'),
  title: richTextSchema(120).default(''),
  images: z.array(z.string().max(2048)).max(10).default([]),
  /** Turn by themselves. Off = only when the visitor swipes. */
  autoplay: z.boolean().default(true),
  /** Seconds per slide. */
  seconds: z.number().int().min(2).max(10).default(4),
  /**
   * «الشرائح» — EACH SLIDE ITS OWN WORDS, as their slider has them: a title,
   * a line, and a button that goes somewhere.
   *
   * OPTIONAL AND WITHOUT A DEFAULT, on purpose: a block saved before this
   * existed parses with no `slides` key and is drawn from `images` exactly as
   * it always was. Once present, the slides are the block's pictures (and
   * `images` is kept in step with them by the editor, so anything that reads
   * only `images` still sees the same photographs). The link is the footer's
   * rule — http(s), a same-site path, mailto or tel; never `javascript:`.
   */
  slides: z
    .array(
      z.object({
        image: z.string().max(2048).default(''),
        title: z.string().trim().max(120).default(''),
        text: z.string().trim().max(240).default(''),
        button: z.string().trim().max(40).default(''),
        link: externalUrl.default(''),
      })
    )
    .max(10)
    .optional(),
});

/** Long-form description — the one place free text belongs. */
const text = z.object({
  ...base,
  type: z.literal('text'),
  title: richTextSchema(120).default(''),
  body: z.string().max(4000).default(''),
});

/**
 * The quantity tiers. Their content comes from LandingPageOffer, because the
 * price a customer is charged must be the price the server holds — a number
 * typed into a section would be a second source of truth for money.
 */
const offers = z.object({
  ...base,
  type: z.literal('offers'),
  title: richTextSchema(120).default('اختر العرض المناسب'),
});

/**
 * WHAT OTHER BUYERS SAID — THE SELLER'S HALF OF IT.
 *
 * Owner decision D8: social proof has two sources per product, يدوي and
 * تلقائي. This block is the MANUAL one, and it stays manual for ever: an
 * item here is a sentence the seller transcribed out of WhatsApp, a
 * Facebook comment or a phone call, and however true it is, NOBODY HERE
 * CAN CHECK IT.
 *
 * So each item now records WHERE IT CAME FROM, an optional PRIVATE proof
 * image, and WHO added it and WHEN. The source is not decoration: the
 * moderation screen lists manual items beside verified ones, and «واتساب»
 * is the honest label for what it is. The proof image is never rendered on
 * a public page — it is somebody's chat, kept so the claim can be checked,
 * not shown.
 *
 * AND AN ITEM HERE CAN NEVER WEAR «مشتري مؤكَّد». That badge is bound to a
 * `ProductReview` row with an `orderId` (src/lib/product-reviews.ts), and
 * there is no field in this schema that could carry one — which is the
 * enforcement, the same way the `comparison` block has nowhere to type a
 * competitor's name.
 */
const reviews = z.object({
  ...base,
  type: z.literal('reviews'),
  title: richTextSchema(120).default('آراء المشترين'),
  items: z.array(z.object({
    name: richTextSchema(60).default(''),
    text: richTextSchema(400).default(''),
    stars: z.number().int().min(1).max(5).default(5),
    /**
     * واتساب · تعليق فيسبوك · مكالمة · غيره.
     *
     * `order` is deliberately NOT one of the options: a verified rating
     * never arrives through this editor, and offering the word here would
     * be offering the badge.
     */
    source: z.enum(['whatsapp', 'facebook', 'call', 'other']).default('other'),
    /** A PRIVATE screenshot of the message. Never rendered publicly. */
    proofImage: z.string().max(2048).default(''),
    /** Who typed this in, and when — the id and an ISO day, set on save. */
    addedBy: z.string().max(80).default(''),
    addedAt: z.string().max(40).default(''),
  })).max(12).default([]),
});

/** Questions that stop a sale, answered before they are asked. */
const faq = z.object({
  ...base,
  type: z.literal('faq'),
  title: richTextSchema(120).default('أسئلة شائعة'),
  items: z.array(z.object({
    q: z.string().max(200).default(''),
    a: z.string().max(800).default(''),
  })).max(12).default([]),
});

/**
 * «منتجنا / البدائل» — AND NEVER A COMPETITOR BY NAME.
 *
 * «المقارنة بتكون عادلة وقابلة للتحقق — ما في تشهير بعلامة منافسة
 * بالاسم». There is no field here for the other side's name, which is the
 * enforcement: a seller cannot write one because there is nowhere to put
 * it. The column is «البدائل», and what is compared is an ASPECT a
 * customer can check — a material, a size, a delivery time — not an
 * opinion about somebody else's product.
 *
 * Six rows at most. A table of fifteen differences is not a comparison, it
 * is a seller listing everything they can think of.
 */
const comparison = z.object({
  ...base,
  type: z.literal('comparison'),
  title: richTextSchema(120).default('لماذا هذا وليس غيره'),
  /** What the two columns are called. The second has no brand in it. */
  oursLabel: z.string().max(40).default('منتجنا'),
  theirsLabel: z.string().max(40).default('البدائل'),
  rows: z.array(z.object({
    aspect: z.string().max(80).default(''),
    ours: z.string().max(120).default(''),
    theirs: z.string().max(120).default(''),
  })).max(6).default([]),
});

/**
 * A TIMELINE, NOT A BEFORE-AND-AFTER.
 *
 * «خط زمني بدل صور قبل/بعد — لأن منصات الإعلان بتقيّد صور قبل/بعد بفئات
 * كتير». The block carries no image field at all: a page that cannot hold
 * the picture cannot have the ad refused for it, and a seller who wants
 * one has the gallery block beside this one.
 */
const timeline = z.object({
  ...base,
  type: z.literal('timeline'),
  title: richTextSchema(120).default('ماذا يحدث مع الوقت'),
  points: z.array(z.object({
    when: z.string().max(40).default(''),
    what: z.string().max(240).default(''),
  })).max(5).default([]),
});

/**
 * «ثلاث أسئلة بضغطة ← التوصية المناسبة».
 *
 * Three questions at most, and that is the whole design: «ثلاث ضغطات كحد
 * أقصى». A quiz that asks seven is a form, and a visitor who came from an
 * ad does not fill forms to be sold to.
 *
 * It recommends, it does not decide: the recommendation names what to look
 * at, and the offers block below still shows every tier. «الي بيجاوب نيته
 * أعلى — مرتجعات أقل» only holds if the answer is a suggestion.
 */
const quiz = z.object({
  ...base,
  type: z.literal('quiz'),
  title: richTextSchema(120).default('أي واحد يناسبك؟'),
  questions: z.array(z.object({
    ask: z.string().max(120).default(''),
    options: z.array(z.string().max(60)).max(4).default([]),
  })).max(3).default([]),
  /** What is said once they have answered. Not a price, and not a promise. */
  result: richTextSchema(240).default(''),
});

/**
 * «ممكن تكون عم تفكر…» × خمسة اعتراضات وجوابها.
 *
 * Different from the FAQ beside it, and the difference is the point: a
 * question is something a visitor wants to know, an objection is a reason
 * they have already decided not to buy. Naming it out loud before they do
 * is what this block is for — «للمنتجات الأغلى والأجهزة».
 */
const objections = z.object({
  ...base,
  type: z.literal('objections'),
  title: richTextSchema(120).default('ممكن تكون عم تفكر…'),
  items: z.array(z.object({
    doubt: z.string().max(160).default(''),
    answer: z.string().max(600).default(''),
  })).max(6).default([]),
  /** The guarantee, which this structure puts in front rather than at the end. */
  guarantee: richTextSchema(240).default(''),
});

/**
 * «رسم كيف بيشتغل ← المكوّنات وكل واحد شو بيعمل».
 *
 * «الإقناع بالفهم. ادعاءات متواضعة ومحددة» — so each ingredient says what
 * it DOES, in its own short line, and there is no field for a percentage
 * or a certificate: a number here would be a claim this system cannot
 * stand behind, and the facts engine is where numbers come from.
 */
const mechanism = z.object({
  ...base,
  type: z.literal('mechanism'),
  title: richTextSchema(120).default('كيف يشتغل'),
  steps: z.array(z.object({
    title: z.string().max(80).default(''),
    text: z.string().max(240).default(''),
  })).max(5).default([]),
  ingredients: z.array(z.object({
    name: z.string().max(60).default(''),
    does: z.string().max(160).default(''),
  })).max(8).default([]),
});

/**
 * Urgency. Deliberately narrow: a note and a countdown of real minutes from
 * the moment the visitor arrives. There is no "only 3 left" field, because
 * the system knows the real stock and inventing a smaller number to hurry
 * someone is a lie we would be shipping.
 */
const urgency = z.object({
  ...base,
  type: z.literal('urgency'),
  text: richTextSchema(140).default(''),
  /**
   * WHERE THIS COUNTDOWN'S ENDING COMES FROM — owner decision D8.
   *
   * `visitor` is what this block always did: `minutes` counting down from
   * page load, restarting for the next visitor, and NOTHING HAPPENING at
   * zero. It stays, and the editor now says so out loud — see
   * `VISITOR_TIMER_WARNING` in src/lib/countdown.ts.
   *
   * `offer` reads `Offer.endsAt`, which is the moment the price itself
   * stops applying — so the clock and the price are ONE FACT and the offer
   * really does stop at zero. It is REFUSED at the save door when the
   * product has no offer with a future ending (`countdownRefusal`): a
   * countdown wearing the word «تلقائي» with nothing automatic behind it
   * would be the dishonest widget with a better name on it.
   *
   * Defaults to `visitor` so every page saved before this keeps meaning
   * exactly what it meant.
   */
  countdown: z.enum(COUNTDOWN_SOURCES).default('visitor'),
  /** 0 = no countdown. Read only when `countdown` is `visitor`. */
  minutes: z.number().int().min(0).max(1440).default(0),
  /** Show the real remaining stock when it is genuinely low. */
  showRealStock: z.boolean().default(false),
});

/*
 * THE MINUTES FIELD WAS RETIRED ON THIS BRANCH, AND IS NOT RETIRED.
 *
 * This branch read «عدّاد فقط من تاريخ انتهاء عرض حقيقي» as «the per-visitor
 * timer has no source, so take the field away». S6 landed first with the
 * owner's own D8 and a better answer to the same sentence: the field stays,
 * the editor makes the seller CHOOSE between «يدوي» and «تلقائي», the
 * per-visitor one carries the warning out loud, and «تلقائي» is REFUSED at
 * the save door when the product has no offer with a future ending —
 * `countdown.ts`, `countdownRefusal`.
 *
 * Theirs is kept whole. A retirement note beside a field that is not retired
 * would be the second answer, and the sentence it answered is answered.
 */

/**
 * THE SENTENCE THAT SAYS NOBODY PAYS NOW.
 *
 * «النواة المقفولة: السعر مع العرض، وزر الطلب، وسطر الدفع عند الاستلام —
 * ظاهرة فوق أول شاشة على 360 بكسل.»
 *
 * It was written out separately in the form's default subtitle and on the
 * shop's product page, and the first screen of a landing page did not say it
 * at all — `firstScreen.codLine` was declared `true` by all ten structures
 * and nothing drew one. A promise in a schema that no renderer keeps is the
 * most expensive kind of rule: it reads as enforced.
 *
 * One constant, because the same sentence in three files drifts into three
 * sentences, and a shopper who reads two of them wonders which is true.
 */
export const COD_LINE = 'ادفع عند الاستلام — لا حاجة لبطاقة';

/** The order form. Always rendered; this block only fixes WHERE. */
const form = z.object({
  ...base,
  type: z.literal('form'),
  title: richTextSchema(120).default('أكمل الطلب'),
  /*
   * NOT THE COD LINE AGAIN.
   *
   * It was this sentence's default, and now the hero carries it as part of
   * the locked core — so a visitor scrolling one page read «ادفع عند
   * الاستلام» here, again beside the amount inside the form, and a third
   * time in the trust row under the button. The fact is not in doubt by the
   * time somebody reaches the fields; what they need here is what to do.
   */
  subtitle: richTextSchema(240).default('املأ بياناتك ويتواصل معك فريقنا للتأكيد'),
  /**
   * THE LOOK OF THE FORM. `card` is the form as it always was; `compact` is a plain column — name and phone
   * side by side, the address under them, one wide button — the way a YouCan order form reads.
   * Additive: every saved page lacks the field and reads as `card`.
   */
  formStyle: z.enum(['card', 'compact']).default('card'),
  /**
   * HOW THE BUNDLE IS CHOSEN INSIDE THE FORM. `cards` is what it always was; `radio` is a plain list with a
   * radio button per bundle («عبوة عدد 2 = 35 دولار») under «اختر الكمية»; `select` is a dropdown — «العرض خيار دروب
   * داون ليست» — the one the form already drew when the page had its own offers block, now the seller's to choose.
   * Display only: the choice is still the offer's id, and the server prices it.
   */
  offerStyle: z.enum(['cards', 'radio', 'select']).default('cards'),
  /**
   * AFTER THE ORDER: the WhatsApp button on the thank-you screen — «تواصل معنا عبر الواتس بعد ما يتمم الطلب… اقدر اعدل
   * النص والرقم». On by default with the words it always had, so a saved page reads as before. `{رقم_الطلب}` in the
   * message becomes the order number. An empty number uses the store's. `whatsappAutoOpen` opens WhatsApp by itself a
   * moment after the order — off by default, because leaving the page also leaves the «زيد علبة» offer behind.
   */
  whatsappAfter: z.boolean().default(true),
  whatsappLabel: z.string().max(40).default('أكّد طلبك على واتساب'),
  whatsappMessage: z.string().max(300).default('مرحباً، بدّي أأكّد طلبي رقم {رقم_الطلب}'),
  whatsappNumber: z.string().max(30).regex(/^[+0-9 ()-]*$/).default(''),
  whatsappAutoOpen: z.boolean().default(false),
  /**
   * «متى اقدر اظهر زر الواتس بعد الشراء… واتحكم بشكل الزر، اشكالو والوانو». Every default is the button as it was —
   * shown at once, a plain outlined button, no icon — so a saved page reads as before.
   *
   *   · `whatsappWhen` — `now` at once; `end` last, under the offers, once the customer is done with them (the bundle
   *     answered, the suggestions answered or one of them added); `delay` after `whatsappDelay` seconds.
   *     `whatsappAutoOpen` then opens WhatsApp three seconds after the button APPEARS, never before it is seen.
   *   · `whatsappLook` — `outline` · `solid` (the store's colour) · `green` (WhatsApp's) · `floating` (a round
   *     button in the corner of the screen); `whatsappShape` its corners; `whatsappWide` the full width;
   *     `whatsappColor` a colour of the seller's own over the look's; `whatsappIcon` and `whatsappPulse` as named.
   */
  whatsappWhen: z.enum(['now', 'end', 'delay']).default('now'),
  whatsappDelay: z.number().int().min(1).max(120).default(5),
  whatsappLook: z.enum(['outline', 'solid', 'green', 'floating']).default('outline'),
  whatsappShape: z.enum(['curved', 'pill', 'square']).default('curved'),
  whatsappWide: z.boolean().default(false),
  whatsappColor: z.string().regex(/^(#[0-9a-fA-F]{6})?$/).default(''),
  whatsappIcon: z.boolean().default(false),
  whatsappPulse: z.boolean().default(false),
  /**
   * The words on the form's own button — «بعد ما يعبي بياناته زر واضح كمان». The price still follows them. The
   * default is what it always said, so a saved page reads as before.
   */
  submitLabel: z.string().max(40).default('تأكيد الطلب'),
  /**
   * THE THANK-YOU SCREEN'S OFFERS — HOW THEY ARE SHOWN. Every default is the screen as it always was, so a saved page
   * reads as before.
   *
   *   · `afterOrderFlow` — «يكونو يا مع بعض الأب سيل والكروس سيل، يا ورا بعض». `together` shows both at once;
   *     `sequence` shows the suggested products only once the «زيد علبة» offer is answered (added, refused, gone).
   *   · `afterOrderBanner` — «شريط: مبروك، حابين نهديك عرض — أو عدّاد». `congrats` is a strip in the seller's words;
   *     `countdown` counts down the REAL window the server enforces (`postOrderGate`), never an invented one.
   *   · `upsellLook` / `crossSellLook` — the shapes of the two: a card, a full-width strip or one compact row; a list
   *     of rows or a grid of cards.
   */
  afterOrderFlow: z.enum(['together', 'sequence']).default('together'),
  afterOrderBanner: z.enum(['none', 'congrats', 'countdown']).default('none'),
  afterOrderBannerText: z.string().max(80).default('مبروك! حابين نهديك عرض خاص قبل ما نجهّز طلبك'),
  upsellLook: z.enum(['card', 'banner', 'compact']).default('card'),
  crossSellLook: z.enum(['list', 'cards']).default('list'),
});

/** The three reassurances under the button. */
const trust = z.object({
  ...base,
  type: z.literal('trust'),
  items: z.array(z.object({
    title: richTextSchema(40).default(''),
    text: richTextSchema(80).default(''),
  })).max(4).default([]),
});

const footer = z.object({
  ...base,
  type: z.literal('footer'),
  text: richTextSchema(200).default(''),
  /**
   * LEGACY — no longer edited. The footer shows the STORE's logo and support
   * phone (its identity, set once in «البلدان والمتاجر»). A value saved here
   * before that is shown only while the store has none of its own, so no
   * live page lost its number when the field moved.
   */
  phone: z.string().max(40).default(''),
  logo: z.string().max(2048).default(''),
  /** Columns of links — policies, about, contact. */
  columns: z.array(z.object({
    title: z.string().max(60).default(''),
    links: z.array(z.object({
      label: z.string().max(60).default(''),
      url: externalUrl.default(''),
    })).max(8).default([]),
  })).max(4).default([]),
});

/**
 * What the customer reads after ordering, in the seller's words.
 *
 * Not a section of the page: it replaces the form once the order is in.
 * Its position in the list means nothing. The order number and the
 * post-order offers are shown under it by the form itself — they are the
 * system's, not text a seller could get wrong.
 */
const thankyou = z.object({
  ...base,
  type: z.literal('thankyou'),
  title: z.string().max(80).default('تم تسجيل طلبك بنجاح'),
  message: z.string().max(400).default('سنتواصل معك قريبًا لتأكيد الطلب.'),
});

/**
 * A button that follows the visitor down the page and lands them on the form.
 *
 * It is a block like any other so it is toggled the same way, but its
 * position in the list means nothing — it is fixed to the bottom of the
 * screen wherever it sits in the order.
 */
const sticky = z.object({
  ...base,
  type: z.literal('sticky'),
  text: z.string().max(40).default('اطلب الآن'),
  /** Show the current price on the button. */
  showPrice: z.boolean().default(true),
  /**
   * A gentle movement that draws the eye: `bounce` (up and down) or `sway` (side to side). `none` is the button
   * as it always was. Off for anyone whose device asks for reduced motion. Additive: saved pages read `none`.
   */
  motion: z.enum(['none', 'bounce', 'sway']).default('none'),
  /**
   * How fast that movement goes — «اضف سرعة حركة الزر العائم». `normal` is the speed it always had, so a saved page
   * reads exactly as before. Meaningless with `none`.
   */
  motionSpeed: z.enum(['slow', 'normal', 'fast']).default('normal'),
});

/**
 * THE SHOP'S OWN THINGS, LAID OUT IN IT.
 *
 * Every other block carries its content: the seller types the headline,
 * uploads the photos, writes the questions. This one carries none — it
 * carries the ARRANGEMENT, and what it arranges is what the store already
 * has: its landing pages and its products.
 *
 * That is the whole reason it exists. A store with four landing pages had
 * no way to show them. Its address rendered one of them, or a plain grid
 * of products, and the pages the seller had built — the ones with the
 * offers and the photos and the reviews on them — were reachable only by
 * their own links.
 *
 * WHAT IT SHOWS is never typed here either: `source` names a set and the
 * server fills it at render time, from THIS store. A list of page ids
 * copied into a block would be a second place that decides what is in the
 * shop, and it would be wrong the first time a page was unpublished.
 *
 * The size, the colours and the background are not this block's invention:
 * `...base` brings `look` and `background`, which every block has, and
 * `columns` and `cardSize` are the two this one adds because a catalogue
 * is the one block whose shape the seller actually argues with.
 */
const catalog = z.object({
  ...base,
  type: z.literal('catalog'),
  title: richTextSchema(120).default('تسوّق من المتجر'),
  /**
   * PAGES, PRODUCTS, OR BOTH.
   *
   * A landing page sells better than a product card — it is the one the
   * seller built on purpose — so pages come first when both are shown.
   */
  source: z.enum(['pages', 'products', 'both']).default('pages'),
  /** Across, on a wide screen. A phone decides for itself; see the CSS. */
  columns: z.number().int().min(2).max(4).default(3),
  cardSize: z.enum(['sm', 'md', 'lg']).default('md'),
  /** Show the price under each card, where there is one to show. */
  showPrice: z.boolean().default(true),
  /**
   * Let the shopper narrow by category.
   *
   * The categories are the ones THIS store's products actually carry —
   * derived, never a list stored here. A shop whose products have no
   * category shows no filter rather than an empty row of chips.
   */
  showCategories: z.boolean().default(true),
  /** Nothing, or at most this many. Zero means all of them. */
  limit: z.number().int().min(0).max(60).default(0),
  /**
   * IN WHAT ORDER — the rows of a home design («وصل حديثاً», «الأكثر مبيعاً»,
   * «الأقل سعراً»). `shelf` is the order every catalogue block always drew
   * in, and a saved block reads as `shelf`, so nothing that exists moves.
   *
   * «الأكثر مبيعاً» is an ORDER and never a number: it ranks by this shop's
   * DELIVERED orders above the sample floor (`bestSellers` in store-facts),
   * shows no count, and with nothing proven it keeps the shelf's order under
   * the heading «مختارات» — see `catalogHeading` in PageBlocks.
   */
  sort: z.enum(['shelf', 'newest', 'best', 'priceAsc']).default('shelf'),
});

export const landingSectionSchema = z.discriminatedUnion('type', [
  announcement, hero, slider, benefits, gallery, text, offers,
  reviews, faq, comparison, timeline, quiz, objections, mechanism,
  urgency, form, trust, footer, sticky, thankyou, catalog,
]);

export type LandingSection = z.infer<typeof landingSectionSchema>;
export type SectionType = LandingSection['type'];

export const landingSectionsSchema = z.array(landingSectionSchema).max(40);

/**
 * WHO ADDED THIS MANUAL REVIEW, AND WHEN — STAMPED BY THE SERVER.
 *
 * Owner decision D8 asks a manual item to record «who added it and when».
 * The editor has the fields, and the editor must NOT be the one that fills
 * them: a value the browser sends is a value the person at the browser can
 * choose, and «أضافه المالك» typed by somebody else is worse than no
 * attribution at all.
 *
 * So the two doors that write sections call this, and it stamps only the
 * items that have no stamp yet. An item already attributed keeps its
 * author: the seller who tidies a typo in somebody else's transcription is
 * not its source, and overwriting it would quietly reassign the claim. The
 * edit itself is in the audit log, which is where «who changed what» has
 * always lived.
 *
 * A DAY, not a timestamp. The hour a seller typed a WhatsApp message in is
 * a detail about their evening.
 */
export function stampManualReviews(
  sections: LandingSection[],
  by: { name: string; at?: Date }
): { sections: LandingSection[]; stamped: number } {
  const day = (by.at ?? new Date()).toISOString().slice(0, 10);
  let stamped = 0;
  const out = sections.map((s) => {
    if (s.type !== 'reviews') return s;
    return {
      ...s,
      items: s.items.map((item) => {
        // Only a REAL item: an empty row the editor opened and nobody
        // filled is not somebody's transcription.
        if (item.addedBy || !item.text.trim()) return item;
        stamped++;
        return { ...item, addedBy: by.name.slice(0, 80), addedAt: day };
      }),
    };
  });
  return { sections: out, stamped };
}

/**
 * WHY A COUNTDOWN IS REFUSED AT THE SAVE DOOR, or null.
 *
 * The honesty rule cannot live in the zod schema: the schema sees one
 * block and the question is about the PRODUCT'S OFFERS, which are rows in
 * another table. So it is checked where the sections are written — the two
 * doors that write them, `/api/landing-pages/[id]/content` and
 * `/api/store/design` — against the offers read there.
 *
 * REFUSED AND NOT CORRECTED. Quietly rewriting `countdown: 'offer'` back
 * to `'visitor'` would leave the seller looking at a screen that says
 * «تلقائي» over the per-visitor timer, which is the exact confusion this
 * item exists to end. The save fails and the sentence says what to do.
 */
export function countdownRefusalIn(
  sections: readonly LandingSection[],
  fact: CountdownFact
): string | null {
  for (const s of sections) {
    if (s.type !== 'urgency') continue;
    // A disabled block is not on the page and not a promise to anybody.
    if (!s.enabled) continue;
    const refusal = countdownRefusal(s.countdown, fact);
    if (refusal) return refusal;
  }
  return null;
}

// ─────────────────────────────────────────────────────
// Names, for the editor
// ─────────────────────────────────────────────────────


// Whole-page templates live in page-templates.ts — the one registry the
// create dialog and the builder both read.

export const SECTION_LABEL: Record<SectionType, string> = {
  announcement: 'شريط إعلان',
  hero: 'الواجهة',
  slider: 'سلايدر صور',
  benefits: 'المميزات',
  gallery: 'معرض الصور',
  text: 'نص وشرح',
  offers: 'العروض',
  reviews: 'آراء المشترين',
  faq: 'أسئلة شائعة',
  comparison: 'جدول مقارنة',
  timeline: 'خط زمني',
  quiz: 'اختبار قصير',
  objections: 'الاعتراضات وجوابها',
  mechanism: 'كيف يشتغل',
  urgency: 'تحفيز',
  form: 'نموذج الطلب',
  trust: 'ضمانات',
  footer: 'التذييل',
  sticky: 'زر عائم',
  thankyou: 'صفحة الشكر',
  catalog: 'معروضات المتجر',
};

export const SECTION_HINT: Record<SectionType, string> = {
  announcement: 'سطر واحد فوق الصفحة كلها',
  hero: 'أول ما يراه الزائر: صورة وعنوان وسعر',
  slider: 'صور تتقلّب وحدها، ويسحبها الزائر بإصبعه',
  benefits: 'لماذا يشتري — أسطر قصيرة لا فقرات',
  gallery: 'صور إضافية للمنتج',
  text: 'شرح مطوّل بخط الصفحة',
  offers: 'عروض الكميات — تُدار من تبويب العروض',
  reviews: 'تجارب مشترين سابقين',
  faq: 'الأسئلة التي تمنع الشراء',
  comparison: 'منتجك والبدائل — بلا ذكر علامة منافسة بالاسم',
  timeline: 'ما يحدث مع الوقت — بدل صور قبل وبعد',
  quiz: 'ثلاثة أسئلة ثم توصية — ثلاث ضغطات كحد أقصى',
  objections: 'الشكوك التي تمنع الطلب، مسمّاة ومجابة',
  mechanism: 'الخطوات والمكوّنات، وما يفعله كل واحد',
  urgency: 'عدّاد وقت وملاحظة مخزون حقيقية',
  form: 'مكان النموذج في الصفحة',
  trust: 'ثلاث طمأنات تحت الزر',
  footer: 'شعار وروابط صفحات وحقوق',
  sticky: 'يلاحق الزائر وينقله لتعبئة البيانات',
  thankyou: 'ما يقرؤه الزبون بعد إرسال الطلب',
  catalog: 'صفحات الهبوط ومنتجات هذا المتجر — بالحجم والترتيب اللذين تختارهما',
};

/** Blocks that may appear only once; the editor hides them when present. */
export const SINGLETON: SectionType[] = ['announcement', 'hero', 'offers', 'form', 'trust', 'footer', 'urgency', 'sticky', 'thankyou'];

// ─────────────────────────────────────────────────────
// Reading what is stored
// ─────────────────────────────────────────────────────

/**
 * Parse stored sections, dropping anything that no longer validates.
 *
 * A page that has been live for a year must keep selling after a block gains
 * a field or loses one. So a bad block is skipped, never fatal: a page with
 * one missing section still takes orders, a page that throws takes none.
 */
export function parseSections(raw: unknown): LandingSection[] {
  const json = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!Array.isArray(json)) return [];

  const out: LandingSection[] = [];
  const seen = new Set<string>();
  for (const item of json) {
    const parsed = landingSectionSchema.safeParse(item);
    if (!parsed.success) continue;
    if (seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    out.push(parsed.data);
  }
  return out;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** A fresh block of a given type, with its defaults filled in. */
export function newSection(type: SectionType): LandingSection {
  const id = `${type}-${Math.random().toString(36).slice(2, 8)}`;
  const seed: Record<SectionType, unknown> = {
    announcement: { text: 'توصيل مجاني لجميع المحافظات' },
    hero: { headline: '', subheadline: '', image: '', showPrice: true, ctaText: 'اطلب الآن' },
    slider: { title: '', images: [], autoplay: true, seconds: 4 },
    benefits: {
      title: 'لماذا هذا المنتج؟',
      items: [
        { title: 'جودة مضمونة', text: '' },
        { title: 'توصيل سريع', text: '' },
        { title: 'دفع عند الاستلام', text: '' },
      ],
    },
    gallery: { title: 'صور المنتج', images: [] },
    // Pages first, because a landing page is the one the seller built on
    // purpose — it sells better than a bare product card.
    catalog: {
      title: 'تسوّق من المتجر',
      source: 'pages',
      columns: 3,
      cardSize: 'md',
      showPrice: true,
      showCategories: true,
      limit: 0,
    },
    text: { title: '', body: '' },
    offers: { title: 'اختر العرض المناسب' },
    reviews: { title: 'آراء المشترين', items: [{ name: '', text: '', stars: 5 }] },
    faq: { title: 'أسئلة شائعة', items: [{ q: '', a: '' }] },
    comparison: { title: 'لماذا هذا وليس غيره', oursLabel: 'منتجنا', theirsLabel: 'البدائل', rows: [{ aspect: '', ours: '', theirs: '' }] },
    timeline: { title: 'ماذا يحدث مع الوقت', points: [{ when: '', what: '' }] },
    quiz: { title: 'أي واحد يناسبك؟', questions: [{ ask: '', options: ['', ''] }], result: '' },
    objections: { title: 'ممكن تكون عم تفكر…', items: [{ doubt: '', answer: '' }], guarantee: '' },
    mechanism: { title: 'كيف يشتغل', steps: [{ title: '', text: '' }], ingredients: [{ name: '', does: '' }] },
    urgency: { text: '', minutes: 0, showRealStock: false },
    form: { title: 'أكمل الطلب', subtitle: 'املأ بياناتك ويتواصل معك فريقنا للتأكيد' },
    /*
     * EMPTY ON PURPOSE — AND THAT IS NOT AN EMPTY ROW.
     *
     * It used to arrive holding «طلب آمن · بياناتك محفوظة» and «توصيل سريع ·
     * خلال أيام»: two sentences nobody measured, pre-written into the one
     * block whose whole job is to be believed, on a shop that had never
     * delivered anything. A seller who never opened the block published
     * them, and a shopper cannot check «سريع».
     *
     * With no items the renderer draws the facts instead (`trustRow`): cash
     * on delivery always, the delivery window only once this shop's own
     * deliveries clear the sample floor, the returns line only when the
     * seller wrote a guarantee or published a policy. Typing items still
     * wins — those are their words about their shop.
     */
    trust: { items: [] },
    footer: {
      text: '',
      phone: '',
      logo: '',
      columns: [
        { title: 'عن المتجر', links: [{ label: '', url: '' }] },
        { title: 'الشروط والسياسات', links: [{ label: '', url: '' }] },
      ],
    },
    sticky: { text: 'اطلب الآن', showPrice: true },
    thankyou: { title: 'تم تسجيل طلبك بنجاح', message: 'سنتواصل معك قريبًا لتأكيد الطلب.' },
  };

  return landingSectionSchema.parse({ id, type, enabled: true, ...(seed[type] as object) });
}

/**
 * The page a seller gets before touching anything — already a real page.
 * An empty canvas is not a starting point; it is a second task.
 */
export function starterSections(): LandingSection[] {
  // Offers sit high, right under the hero, the way a one-product page has
  // always worked — and the benefits then separate them from the form, which
  // carries its own offer picker. Side by side the two would read as a bug.
  return (['announcement', 'hero', 'offers', 'benefits', 'form', 'trust', 'footer'] as SectionType[])
    .map(newSection);
}

/**
 * THE TWO BLOCKS A SELLING PAGE IS NEVER WITHOUT.
 *
 * The form, because without it the page cannot take an order — and the
 * floating button, because «النموذج على بُعد ضغطة واحدة من أي موضع
 * تمرير». A page a visitor has scrolled two screens down has its order
 * form off the screen, and the only thing that keeps the order one tap
 * away at that depth is a button that came with them.
 *
 * It is the same rule the structure contract already states twice — every
 * one of the ten sequences must contain `sticky`, and `stickyOnMobile` is a
 * `z.literal(true)` with no value that turns it off — and nothing kept it
 * on a page assembled by hand in the builder. A seller who pressed «إخفاء»
 * on it, or built a page before the block existed, shipped a page where
 * the order was a scroll away at every depth.
 *
 * ENABLED, NOT APPENDED BLINDLY: a page that already holds the block keeps
 * the seller's own words and its own id, because the words on the button
 * are theirs and only its presence is ours. Its POSITION in the list means
 * nothing — it is fixed to the bottom of the screen wherever it sits — so
 * appending at the end moves nothing anybody arranged.
 */
export const LOCKED_SECTIONS: SectionType[] = ['form', 'sticky'];

function ensureEnabled(sections: LandingSection[], type: SectionType): LandingSection[] {
  if (sections.some((s) => s.type === type && s.enabled)) return sections;
  const existing = sections.find((s) => s.type === type);
  if (existing) return sections.map((s) => (s.id === existing.id ? { ...s, enabled: true } : s));
  return [...sections, newSection(type)];
}

/** The form is not optional: without it the page cannot take an order. */
export function ensureForm(sections: LandingSection[]): LandingSection[] {
  return ensureEnabled(sections, 'form');
}

/** Nor is the button that carries a visitor back to it from any depth. */
export function ensureSticky(sections: LandingSection[]): LandingSection[] {
  return ensureEnabled(sections, 'sticky');
}

/** Both, for the one caller that renders a page to a shopper. */
export function ensureSellingCore(sections: LandingSection[]): LandingSection[] {
  return ensureSticky(ensureForm(sections));
}
