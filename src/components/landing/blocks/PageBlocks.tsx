import React from 'react';
import { Check, Star, ShieldCheck, Truck, Wallet, Phone, ChevronUp, ChevronDown, Eye, EyeOff, Trash2, Pencil, CopyPlus, ClipboardCopy, ClipboardPaste } from 'lucide-react';
import { COD_LINE, LOCKED_SECTIONS, type LandingSection } from '@/lib/landing-sections';
import { lowStock, offersCountAr, trustRow, type SellingFamily, type TrustItem } from '@/lib/selling-blocks';
import { lookStyles, isPlainLook } from '@/lib/block-look';
import { sanitizeRich, isRich } from '@/lib/rich-text';
import type { Palette } from '@/lib/landing-theme';
import { OfferCards } from './OfferCards';
import { Countdown } from './Countdown';
import { FaqList } from './FaqList';
import { OrderCta } from './OrderCta';
import { StickyCta } from './StickyCta';
import { Slider } from './Slider';

/**
 * The public renderer for a block-built page.
 *
 * Every block here is already designed: the seller chooses what appears and
 * what it says, never how far apart two things sit or what colour a button
 * is. That is the whole reason this exists — a page assembled from designed
 * parts is coherent by construction, while a page assembled from a CSS box
 * is coherent only on the days its author had taste and time.
 *
 * All colour comes from the CSS variables the theme derived. Nothing here
 * names a colour, so changing the accent restyles the entire page.
 */

import { moneyText } from '@/lib/money';

export interface BlockContext {
  palette: Palette;
  productName: string;
  price: number;
  currency: string;
  /**
   * The country's own decimals. Absent reads as two, which is what the
   * hand-rolled formatter this replaced always assumed — and wrong for
   * every currency that keeps three.
   */
  minorUnit?: number;
  /** Real remaining stock, or null when we do not know it. */
  stock: number | null;
  offers: {
    id: string; name: string; quantity: number; freeQuantity: number; price: number;
    /** This bundle's own price before its own reduction — certain, not a claim. */
    listPrice?: number | null;
    compareAtPrice?: number | null; isDefault?: boolean;
  }[];
  /**
   * THE THREE THINGS A COD SHOPPER WANTS TO KNOW, ALREADY DECIDED.
   *
   * Resolved by the server (`trustRow`), not here: two of the three are
   * claims that have to be earned — a measured delivery window and a
   * returns policy the seller actually published — and a renderer that
   * guessed at either would be a second place deciding what this shop may
   * say about itself.
   *
   * Absent (the builder, the template gallery) draws the one item that is
   * true of every shop on this system, which is how the row looks on a
   * page whose shop has not learned anything yet.
   */
  trust?: TrustItem[];
  /**
   * The shop's WhatsApp, as a link, or null when it has no number.
   *
   * Built by `whatsappHref` upstream so the digits rule is applied once. A
   * button that opens nothing is worse than no button, so null means the
   * contact is simply not drawn.
   */
  whatsapp?: string | null;
  /** Which of the three families this page is drawn in. */
  family?: SellingFamily;
  /** Rendered in place of the `form` block. */
  form: React.ReactNode;
  /**
   * True inside the builder's preview. Only the thank-you block reads it: it
   * is not part of the published page (the form turns into it after an
   * order), but in the builder it must be something the seller can see,
   * click and edit.
   */
  building?: boolean;
  /**
   * The store the page belongs to — its identity, which the footer shows:
   * one logo and one phone per store, set in the store's settings.
   */
  store?: { name: string; logo: string | null; phone: string | null } | null;
  /**
   * DRAW A FRAME WHERE A PHOTOGRAPH WOULD GO.
   *
   * Set ONLY by the template gallery. A template carries no images — it
   * cannot, because an uploaded image belongs to the company that uploaded
   * it — so a hero with no picture renders as a line of text, and eight of
   * the fifteen templates also open a gallery block that renders nothing at
   * all. Previewed that way, every template looks like the same bare page
   * and the gallery teaches that the templates are identical.
   *
   * The published page must never do this: an empty block there is a block
   * the seller has not filled, and drawing a grey box on a customer's
   * screen is worse than drawing nothing.
   */
  placeholders?: boolean;
  /**
   * THE RATINGS THE SERVER FOUND — never stored in the block.
   *
   * Owner decision D8. Filled at render time from `shownReviews`, which
   * already applied the product's mode (يدوي · تلقائي · الاتنين), the
   * published-and-consented filter and the average's floor. Null or absent
   * means «this product shows the seller's items only», which is what a
   * product with no delivered orders honestly is.
   *
   * It carries a FIRST NAME and a CITY. There is no field here for a phone,
   * an address or a surname, and `PUBLIC_REVIEW_FIELDS` in
   * src/lib/product-reviews.ts is compared against this shape in both
   * directions by a guard.
   */
  reviews?: {
    items: { id: string; rating: number; text: string; firstName: string; city: string; verified: boolean; at: string }[];
    count: number;
    average: number | null;
    /** False below the floor: an average over two people is not a measurement. */
    showAverage: boolean;
  } | null;
  /**
   * THE OFFER'S OWN ENDING, as an ISO moment, for an `urgency` block set to
   * «تلقائي».
   *
   * Read from `Offer.endsAt` by the server — the soonest one still ahead —
   * because that is the column the price stops at. A countdown reading
   * anything else would be a second source of truth for when the offer
   * ends, and the two would disagree the first time a seller moved a date.
   */
  offerEndsAt?: string | null;
  /**
   * WHAT THE SHOP HAS, FOR THE `catalog` BLOCK.
   *
   * Filled by the server at render time, never stored in the block. A list
   * of page ids copied into a section would be a second place deciding
   * what is in the shop, and it would be wrong the first time a page was
   * unpublished or a product paused.
   *
   * Both kinds always, whatever the block's `source` says: the filtering
   * happens in the renderer, so the builder's preview answers the «pages ·
   * products · both» toggle instantly instead of waiting for a refetch.
   */
  catalog?: {
    items: CatalogItem[];
    /** The categories THIS store's products actually carry. Derived. */
    categories: { id: string; name: string }[];
    /** The one the shopper picked, from the query string. */
    activeCategory?: string | null;
    /** Where a category chip points. The builder passes none: nothing to browse. */
    categoryHref?: ((id: string | null) => string) | null;
  } | null;
}

export interface CatalogItem {
  id: string;
  /** A landing page the seller built, or a product in the shop. */
  kind: 'page' | 'product';
  name: string;
  image: string | null;
  href: string;
  /** Null when there is no one price to show. */
  price: number | null;
  categoryId: string | null;
}

/**
 * Picking a block by touching it, rather than hunting for its row.
 *
 * Passed ONLY by the builder. The published page never receives it, so the
 * customer's page carries no outlines, no listeners and no chrome — the
 * same renderer draws both, which is the whole reason the preview can be
 * trusted.
 */
export interface BlockSelection {
  activeId: string | null;
  onSelect: (id: string) => void;
  /** The block's Arabic name, for the badge on hover. */
  label: (s: LandingSection) => string;
  onMove?: (id: string, by: -1 | 1) => void;
  onToggle?: (id: string) => void;
  onRemove?: (id: string) => void;
  /** Opens this block's fields — the same thing a click does, said plainly. */
  onEdit?: (id: string) => void;
  /** A second copy right below. Undefined when this block may exist once. */
  onDuplicate?: (id: string) => void;
  /** Take this block's look, to put on another. */
  onCopyLook?: (id: string) => void;
  /** Put the copied look on this one. */
  onPasteLook?: (id: string) => void;
  /** Whether anything has been copied yet — the paste button says so. */
  hasCopiedLook?: boolean;
  /** The block the copied look came from: it shows «نُسخ» and offers no paste onto itself. */
  copiedFromId?: string | null;
  /** The preview's zoom — the bar is drawn at its own size whatever the page is zoomed to. */
  zoom?: number;
  /** False for a block the page may only hold one of. */
  canDuplicate?: (s: LandingSection) => boolean;
  /** The look controls, rendered in the same bar as the handles. */
  toolbar?: (s: LandingSection) => React.ReactNode;
}

export function PageBlocks({
  sections,
  ctx,
  selection,
}: {
  sections: LandingSection[];
  ctx: BlockContext;
  selection?: BlockSelection;
}) {
  const shown = selection ? sections : sections.filter((s) => s.enabled);
  // The first picture a visitor sees: the first gallery among the opening blocks. It is the page's largest paint, so it
  // loads at once and first — `lazy` held it back until layout, on the one image that should never wait.
  const lead = shown.slice(0, 3).find((s) => s.type === 'gallery')?.id;

  return (
    <>
      {shown.map((s, i) => {
        const block = (
          <Dressed section={s}>
            <Block section={s} ctx={ctx} lead={s.id === lead} />
          </Dressed>
        );
        if (!selection) return <React.Fragment key={s.id}>{block}</React.Fragment>;
        return (
          <Selectable
            key={s.id}
            section={s}
            selection={selection}
            first={i === 0}
            last={i === shown.length - 1}
          >
            {block}
          </Selectable>
        );
      })}
    </>
  );
}

/**
 * The block's own width, spacing, background and type.
 *
 * Wrapping rather than threading the look through thirteen components: a
 * block should keep saying what it says, and this decides how it sits. The
 * outer layer is full-bleed so a background can reach the screen edges; the
 * inner one holds the width and the gutter, so the text never does.
 */
/**
 * A seller's text, drawn with whatever marks they put on part of it.
 *
 * Returns props to spread rather than wrapping in an element, so every call
 * site keeps the tag it already had — a headline stays an `h1` and not an
 * `h1` with a `span` inside it that the block stylesheet does not expect.
 *
 * Plain text takes the plain path and never touches innerHTML: the vast
 * majority of values are plain, and the safest branch should be the one
 * most of them travel down.
 */
function rich(value: string | null | undefined) {
  const v = value ?? '';
  return isRich(v)
    ? { dangerouslySetInnerHTML: { __html: sanitizeRich(v) } }
    : { children: v };
}

function Dressed({ section, children }: { section: LandingSection; children: React.ReactNode }) {
  const { outer, inner, overlay, vars } = lookStyles(section.look);

  // A block nobody has styled renders exactly as it did before any of this
  // existed — no extra wrapper, no changed spacing, nothing to regress.
  //
  // The test asks what the seller CHOSE, not whether an object is present:
  // the schema fills a default look into every block, so `!section.look`
  // was never once true and every block on every page had quietly gained a
  // wrapper it did not need.
  if (isPlainLook(section.look)) return <>{children}</>;

  const t = section.look?.text;
  return (
    <div
      style={{ ...outer, ...vars } as React.CSSProperties}
      /* Each flag turns on the rule that makes this block's own choice beat
         the block stylesheet. Absent when nothing was chosen, so a page
         nobody has styled renders exactly as it always did. */
      data-look-color={inner.color ? '' : undefined}
      /* An item title follows a chosen colour — the heading colour, or the text colour when only that was chosen. */
      data-look-it={inner.color || vars['--look-heading'] ? '' : undefined}
      data-look-wide={section.look?.width === 'wide' || section.look?.width === 'full' ? '' : undefined}
      data-look-size={t?.scale && t.scale !== 'm' ? '' : undefined}
      data-look-align={section.look?.align && section.look.align !== 'center' ? '' : undefined}
      data-look-font={t?.font ? '' : undefined}
      data-look-italic={t?.italic ? '' : undefined}
      data-look-weight={t?.weight ? '' : undefined}
      data-look-pad={vars['--look-section-pad'] !== undefined ? '' : undefined}
    >
      {overlay > 0 && (
        <div
          aria-hidden
          style={{ position: 'absolute', inset: 0, background: `rgba(0,0,0,${overlay})` }}
        />
      )}
      <div style={inner}>{children}</div>
    </div>
  );
}

function Block({ section: s, ctx, lead = false }: { section: LandingSection; ctx: BlockContext; lead?: boolean }) {
  switch (s.type) {
    case 'announcement':
      // In the builder an empty bar is a place to type, not nothing: with no box there was no outline, no panel and
      // no way to find the block on the page at all.
      if (!s.text) return ctx.building ? <SlotFrame label="شريط إعلان — اكتب جملة قصيرة" /> : null;
      // The bar's words follow a colour the seller CHOSE — not the automatic white a photo background sets, because
      // the bar itself is an opaque accent strip.
      return (
        <div className="lp-announce" data-edit="text" style={s.look?.text?.color ? { color: 'inherit' } : undefined} {...rich(s.text)} />
      );

    case 'hero':
      return <Hero section={s} ctx={ctx} />;

    case 'slider': {
      const images = s.images.filter(Boolean);
      if (!images.length) {
        if (!ctx.building) return null;
        return <Section title={s.title}><SlotFrame label="صور متحركة — ارفع صورة أو أكثر" /></Section>;
      }
      return (
        <Section title={s.title}>
          <Slider images={images} autoplay={s.autoplay} seconds={s.seconds} />
        </Section>
      );
    }

    case 'thankyou':
      // On the published page the form becomes this after an order; there is
      // nothing to draw in the page itself.
      if (!ctx.building) return null;
      return (
        <section className="lp-section">
          <div
            style={{
              border: '2px dashed var(--store-accent-border)',
              borderRadius: 'var(--store-radius)',
              padding: '22px 16px',
              textAlign: 'center',
              background: 'var(--store-accent-tint)',
            }}
          >
            <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--store-muted)' }}>
              صفحة الشكر — تظهر مكان النموذج بعد إرسال الطلب
            </p>
            <p style={{ fontSize: 16, fontWeight: 800, color: 'var(--store-text)', marginTop: 8 }}>
              {s.title || 'تم تسجيل طلبك بنجاح'}
            </p>
            <p style={{ fontSize: 12.5, color: 'var(--store-muted)', marginTop: 4, whiteSpace: 'pre-line' }}>
              {s.message || 'سنتواصل معك قريبًا لتأكيد الطلب.'}
            </p>
          </div>
        </section>
      );

    case 'benefits': {
      // The original index travels with the item: filtering first and
      // using the position in the FILTERED list would write a typed edit
      // onto a different benefit.
      const items = s.items.map((item, at) => ({ item, at })).filter(({ item }) => item.title || item.text);
      if (!items.length) return null;
      return (
        <Section title={s.title}>
          <ul className="lp-benefits">
            {items.map(({ item, at: i }) => (
              <li key={i}>
                <span className="lp-benefit-mark" aria-hidden>
                  <Check size={15} strokeWidth={3} />
                </span>
                <div>
                  <strong data-it="" data-edit={`items.${i}.title`} {...rich(item.title)} />
                  {item.text && <p data-edit={`items.${i}.text`} {...rich(item.text)} />}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      );
    }

    case 'gallery': {
      const images = s.images.filter(Boolean);
      if (!images.length) {
        if (!ctx.placeholders) return null;
        return (
          <Section title={s.title}>
            <div className="lp-gallery">
              {[0, 1, 2].map((i) => (
                <ImageFrame key={i} label="صورة" ratio={1} />
              ))}
            </div>
          </Section>
        );
      }
      return (
        <Section title={s.title}>
          <div className="lp-gallery" data-layout={s.layout}>
            {images.map((src, i) => (
              // The seller's own uploads; next/image would need every host
              // allow-listed, and a blocked hero is worse than an unoptimised one.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={i}
                src={src}
                alt=""
                loading={lead && i === 0 ? 'eager' : 'lazy'}
                fetchPriority={lead && i === 0 ? 'high' : undefined}
              />
            ))}
          </div>
        </Section>
      );
    }

    /**
     * THE SHOP, LAID OUT.
     *
     * The block carries the arrangement; `ctx.catalog` carries the things.
     * A store with four landing pages had no way to show them at all — its
     * address rendered one of them, or a plain grid of products, and the
     * pages the seller had actually built were reachable only by their own
     * links.
     *
     * Pages before products when both are asked for: a landing page is the
     * one the seller built on purpose, and it sells better than a card.
     */
    case 'catalog': {
      const cat = ctx.catalog;
      const all = cat?.items ?? [];
      const wanted = s.source === 'both' ? all : all.filter((i) => i.kind === (s.source === 'pages' ? 'page' : 'product'));
      const narrowed = cat?.activeCategory
        ? wanted.filter((i) => i.categoryId === cat.activeCategory)
        : wanted;
      const items = s.limit > 0 ? narrowed.slice(0, s.limit) : narrowed;

      if (items.length === 0) {
        // In the builder, an empty shop must still show the seller what
        // this block will look like — otherwise it reads as broken and
        // they delete it. On a customer's screen it draws nothing.
        if (!ctx.placeholders) return null;
        return (
          <Section title={s.title}>
            <div className={`lp-catalog lp-catalog-${s.cardSize}`} style={{ '--store-cat-cols': s.columns } as React.CSSProperties}>
              {[0, 1, 2].map((i) => (
                <span key={i} className="lp-catalog-card">
                  <span className="lp-catalog-media">
                    <span className="lp-catalog-noimg" data-letter="؟" aria-hidden />
                  </span>
                  <span className="lp-catalog-body">
                    <span className="lp-catalog-name">اسم المنتج أو الصفحة</span>
                    <span className="lp-catalog-price" dir="ltr">0 {ctx.currency}</span>
                  </span>
                </span>
              ))}
            </div>
          </Section>
        );
      }

      // Only when the shop's products actually carry categories. A row of
      // chips over a shop that has none is a control that filters nothing.
      const chips = s.showCategories && (cat?.categories.length ?? 0) > 0 ? cat!.categories : [];

      return (
        <Section title={s.title}>
          {chips.length > 0 && (
            <div className="lp-catalog-cats">
              {[{ id: '', name: 'الكل' }, ...chips].map((c) => {
                const on = (cat!.activeCategory ?? '') === c.id;
                const href = cat!.categoryHref ? cat!.categoryHref(c.id || null) : null;
                const cls = `lp-catalog-cat${on ? ' is-on' : ''}`;
                // A link, not a button: the page is rendered on the server,
                // and a shopper with no JavaScript still gets to browse.
                return href ? (
                  <a key={c.id} href={href} className={cls} aria-current={on ? 'true' : undefined} data-ink={on ? '' : undefined}>
                    {c.name}
                  </a>
                ) : (
                  <span key={c.id} className={cls} data-ink={on ? '' : undefined}>{c.name}</span>
                );
              })}
            </div>
          )}
          <div className={`lp-catalog lp-catalog-${s.cardSize}`} style={{ '--store-cat-cols': s.columns } as React.CSSProperties}>
            {items.map((it) => (
              <a key={`${it.kind}-${it.id}`} href={it.href} className="lp-catalog-card">
                <span className="lp-catalog-media">
                  {/* WHICH OF THE TWO KINDS. A landing page the seller
                      built is a different thing from a catalogue product,
                      and a shopper who cannot tell them apart cannot tell
                      why one of them carries an offer. */}
                  {it.kind === 'page' && <span className="lp-catalog-tag" data-ink="">عرض خاص</span>}
                  {it.image ? (
                    // The seller's own uploads; next/image would need every
                    // host allow-listed, and a blocked image is worse than an
                    // unoptimised one.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={it.image} alt="" loading="lazy" />
                  ) : (
                    // Not a grey rectangle: most of a new shop's products
                    // have no photograph yet, and twenty flat grey blocks
                    // was the whole page. The first letter in a wash of the
                    // shop's own colour reads as «the picture goes here».
                    <span className="lp-catalog-noimg" data-letter={(it.name ?? '').trim().charAt(0) || '—'} aria-hidden />
                  )}
                </span>
                <span className="lp-catalog-body">
                  <span className="lp-catalog-name">{it.name}</span>
                  {/* A PRICE OF ZERO IS NOT A PRICE. A landing page whose
                      product has no base price was showing «0 USD», which
                      reads as free. Nothing is the honest answer. */}
                  {s.showPrice && it.price !== null && it.price > 0 && (
                    <span className="lp-catalog-price" dir="ltr">
                      {it.price.toLocaleString('en-US', { maximumFractionDigits: 2 })} {ctx.currency}
                    </span>
                  )}
                </span>
              </a>
            ))}
          </div>
        </Section>
      );
    }

    case 'text': {
      /*
       * «لما امسح النص العنوان بيختفي… وما قدرت اعدّلو من شاشة المعاينة».
       * The block was drawn only when its BODY had words, so emptying the body
       * took the title with it — and left nothing on the preview to click.
       * Now a title stands alone, the body is typed on the page like the
       * title is, and in the preview an empty body is a line to type on
       * (`data-edit-empty`), which a visitor never sees.
       */
      const body = s.body.trim();
      const titled = !!s.title.replace(/<[^>]*>/g, '').trim();
      if (!body && !titled && !ctx.placeholders) return null;
      return (
        <Section title={s.title}>
          {body ? (
            // Keyed on the text: typing on the page reshapes these paragraphs
            // outside React, so a new body is a new element, never a diff.
            <div key={body} className="lp-prose" data-edit="body" data-edit-plain="">
              {body.split(/\n{2,}/).map((para, i) => (
                <p key={i}>{para}</p>
              ))}
            </div>
          ) : (
            ctx.placeholders && (
              <div key="empty" className="lp-prose" data-edit="body" data-edit-plain="" data-edit-empty="">
                <p style={{ opacity: 0.55 }}>اكتب النص هنا…</p>
              </div>
            )
          )}
        </Section>
      );
    }

    case 'offers':
      if (!ctx.offers.length) return null;
      return (
        <Section title={s.title}>
          <OfferCards offers={ctx.offers} currency={ctx.currency} />
        </Section>
      );

    case 'reviews': {
      /**
       * TWO SOURCES, ONE BLOCK, AND ONLY ONE OF THEM MAY WEAR THE BADGE.
       *
       * Owner decision D8. `ctx.reviews` is what the SERVER found: ratings
       * from delivered orders, published and consented to, carrying a first
       * name and a city and nothing else about the person. `s.items` is
       * what the SELLER typed.
       *
       * The verified ones come first, because they are the ones a shopper
       * can weigh, and each carries «مشتري مؤكَّد». A manual item never
       * can — there is no field in its schema that could hold an order, so
       * the badge is not a rule a renderer applies, it is a thing the data
       * cannot say.
       *
       * THE AVERAGE IS SHOWN ONLY ABOVE A FLOOR. `showAverage` is the
       * server's answer to «is this a measurement or is it two people» —
       * see `MIN_SHOWN_FOR_AVERAGE`. Below it the shopper gets the
       * sentences and no statistic.
       */
      const verified = ctx.reviews?.items ?? [];
      const items = s.items.map((r, at) => ({ r, at })).filter(({ r }) => r.text.trim());

      if (verified.length) {
        return (
          <Section title={s.title}>
            {ctx.reviews?.showAverage && ctx.reviews.average !== null && (
              <p className="lp-reviews-average">
                <strong>{ctx.reviews.average}</strong> من 5 — {ctx.reviews.count} تقييم من مشترين
              </p>
            )}
            <div className="lp-reviews">
              {verified.map((r) => (
                <figure key={r.id}>
                  <div className="lp-stars" aria-label={`${r.rating} من 5`}>
                    {Array.from({ length: 5 }, (_, n) => (
                      <Star key={n} size={13} fill={n < r.rating ? 'currentColor' : 'none'} strokeWidth={1.5} />
                    ))}
                  </div>
                  {/* AS TEXT. A child, never dangerouslySetInnerHTML and
                      never `rich()`: this is what a stranger typed, and the
                      only safe reading of it is "characters". */}
                  <blockquote>{r.text}</blockquote>
                  <figcaption>
                    {[r.firstName, r.city].filter(Boolean).join(' · ')}
                    <span className="lp-review-badge">مشتري مؤكَّد</span>
                  </figcaption>
                </figure>
              ))}
              {/* The seller's own items keep their place below, unbadged. */}
              {items.map(({ r, at: i }) => (
                <figure key={`m${i}`}>
                  <div className="lp-stars" aria-label={`${r.stars} من 5`}>
                    {Array.from({ length: 5 }, (_, n) => (
                      <Star key={n} size={13} fill={n < r.stars ? 'currentColor' : 'none'} strokeWidth={1.5} />
                    ))}
                  </div>
                  <blockquote data-edit={`items.${i}.text`} {...rich(r.text)} />
                  {r.name && <figcaption data-edit={`items.${i}.name`} {...rich(r.name)} />}
                </figure>
              ))}
            </div>
          </Section>
        );
      }

      if (!items.length) {
        if (!ctx.placeholders) return null;
        // A template ships no example testimonials, here or anywhere: a
        // page published without editing them would show a customer's
        // words that no customer said.
        return (
          <Section title={s.title}>
            <SlotFrame label="آراء العملاء — تضيف آراءً حقيقية من زبائنك" />
          </Section>
        );
      }
      return (
        <Section title={s.title}>
          <div className="lp-reviews">
            {items.map(({ r, at: i }) => (
              <figure key={i}>
                <div className="lp-stars" aria-label={`${r.stars} من 5`}>
                  {Array.from({ length: 5 }, (_, n) => (
                    <Star key={n} size={13} fill={n < r.stars ? 'currentColor' : 'none'} strokeWidth={1.5} />
                  ))}
                </div>
                <blockquote data-edit={`items.${i}.text`} {...rich(r.text)} />
                {r.name && <figcaption data-edit={`items.${i}.name`} {...rich(r.name)} />}
              </figure>
            ))}
          </div>
        </Section>
      );
    }

    case 'faq': {
      const items = s.items.filter((i) => i.q.trim());
      if (!items.length) {
        if (!ctx.placeholders) return null;
        return (
          <Section title={s.title}>
            <SlotFrame label="الأسئلة الشائعة — تكتب أسئلتك وأجوبتك" />
          </Section>
        );
      }
      return (
        <Section title={s.title}>
          <FaqList items={items} />
        </Section>
      );
    }

/**
     * «منتجنا / البدائل» — a table, and a table is the right shape: two
     * columns a person's eye runs across, not two paragraphs they have to
     * hold in their head at once.
     *
     * The other column is «البدائل» and there is nowhere to name a brand,
     * so a page built here cannot be refused by an ad platform for naming
     * one.
     */
    case 'comparison': {
      const rows = s.rows.filter((r) => r.aspect.trim());
      if (!rows.length) {
        if (!ctx.placeholders) return null;
        return <Section title={s.title}><SlotFrame label="جدول المقارنة — تكتب الفروق التي يقدر الزبون يتحقّق منها" /></Section>;
      }
      return (
        <Section title={s.title}>
          <table className="lp-compare">
            <thead>
              <tr>
                <th />
                <th className="lp-compare-ours">{s.oursLabel}</th>
                <th>{s.theirsLabel}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <th scope="row" data-it="">{r.aspect}</th>
                  <td className="lp-compare-ours">{r.ours}</td>
                  <td>{r.theirs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      );
    }

    /** «الأسبوع الأول · الثالث · الثامن» — and no photograph anywhere. */
    case 'timeline': {
      const points = s.points.filter((p) => p.when.trim() || p.what.trim());
      if (!points.length) {
        if (!ctx.placeholders) return null;
        return <Section title={s.title}><SlotFrame label="خط زمني — متى، وماذا يحدث" /></Section>;
      }
      return (
        <Section title={s.title}>
          <ol className="lp-timeline">
            {points.map((p, i) => (
              <li key={i}>
                <span className="lp-timeline-when" data-it="">{p.when}</span>
                <span className="lp-timeline-what">{p.what}</span>
              </li>
            ))}
          </ol>
        </Section>
      );
    }

    /**
     * Three questions, shown as questions. It does not run — a visitor
     * answering on the page would need state, and what this block owes the
     * structure is the STORY: «اسألني ثلاثة وأقول لك أيّها». The offers
     * block below still shows every tier, because the answer is a
     * suggestion and not a decision.
     */
    case 'quiz': {
      const questions = s.questions.filter((q) => q.ask.trim());
      if (!questions.length) {
        if (!ctx.placeholders) return null;
        return <Section title={s.title}><SlotFrame label="ثلاثة أسئلة — كل واحد بخيارين أو ثلاثة" /></Section>;
      }
      return (
        <Section title={s.title}>
          <ol className="lp-quiz">
            {questions.map((q, i) => (
              <li key={i}>
                <p className="lp-quiz-ask" data-it="">{q.ask}</p>
                <div className="lp-quiz-options">
                  {q.options.filter(Boolean).map((o, j) => (
                    <span key={j} className="lp-quiz-option">{o}</span>
                  ))}
                </div>
              </li>
            ))}
          </ol>
          {s.result.trim() && <p className="lp-quiz-result" {...rich(s.result)} />}
        </Section>
      );
    }

    /** The doubt said out loud before the visitor says it to themselves. */
    case 'objections': {
      const items = s.items.filter((i) => i.doubt.trim());
      if (!items.length) {
        if (!ctx.placeholders) return null;
        return <Section title={s.title}><SlotFrame label="الاعتراضات — ما يمنع الطلب، وجوابه" /></Section>;
      }
      return (
        <Section title={s.title}>
          <div className="lp-objections">
            {items.map((item, i) => (
              <div key={i} className="lp-objection">
                <p className="lp-objection-doubt" data-it="">{item.doubt}</p>
                <p className="lp-objection-answer">{item.answer}</p>
              </div>
            ))}
          </div>
          {s.guarantee.trim() && <p className="lp-guarantee" {...rich(s.guarantee)} />}
        </Section>
      );
    }

    /** The steps, then what each ingredient does. No percentages anywhere. */
    case 'mechanism': {
      const steps = s.steps.filter((x) => x.title.trim() || x.text.trim());
      const ingredients = s.ingredients.filter((x) => x.name.trim());
      if (!steps.length && !ingredients.length) {
        if (!ctx.placeholders) return null;
        return <Section title={s.title}><SlotFrame label="الخطوات والمكوّنات — وما يفعله كل واحد" /></Section>;
      }
      return (
        <Section title={s.title}>
          {steps.length > 0 && (
            <ol className="lp-mechanism">
              {steps.map((x, i) => (
                <li key={i}>
                  <span className="lp-mechanism-step" data-it="">{x.title}</span>
                  <span className="lp-mechanism-text">{x.text}</span>
                </li>
              ))}
            </ol>
          )}
          {ingredients.length > 0 && (
            <dl className="lp-ingredients">
              {ingredients.map((x, i) => (
                <div key={i}>
                  <dt data-it="">{x.name}</dt>
                  <dd>{x.does}</dd>
                </div>
              ))}
            </dl>
          )}
        </Section>
      );
    }

    case 'urgency':
      return <Urgency section={s} ctx={ctx} />;

    case 'form':
      return (
        <section className="lp-section lp-form-section">
          {s.title && <h2 className="lp-h2" data-edit="title" {...rich(s.title)} />}
          {s.subtitle && <p className="lp-sub" data-edit="subtitle" {...rich(s.subtitle)} />}
          {ctx.form}
        </section>
      );

    case 'trust':
      return <Trust section={s} ctx={ctx} />;

    case 'footer': {
      // Each column and each link keeps the index it has IN THE DATA, so a
      // seller typing into the second visible link writes to the second
      // link and not to whichever one the filter happened to leave there.
      const columns = s.columns
        .map((c, at) => ({
          col: c,
          at,
          links: c.links.map((l, li) => ({ link: l, li })).filter(({ link }) => link.label && link.url),
        }))
        .filter(({ col, links }) => col.title || links.length);
      // The store's identity; a value the block saved before it moved is
      // kept only while the store has none (see the footer schema).
      const logo = ctx.store?.logo || s.logo;
      const phone = ctx.store?.phone || s.phone;
      return (
        <footer className="lp-footer">
          {logo && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo} alt={ctx.store?.name ?? ''} className="lp-footer-logo" />
          )}

          {columns.length > 0 && (
            <nav className="lp-footer-cols">
              {columns.map(({ col, at, links }) => (
                <div key={at}>
                  {col.title && <h3 data-edit={`columns.${at}.title`} {...rich(col.title)} />}
                  <ul>
                    {links.map(({ link, li }) => (
                      <li key={li}>
                        {/* The seller's own links, but the page is public:
                            an external target never gets to reach back
                            through window.opener. */}
                        <a
                          href={link.url}
                          target="_blank"
                          rel="noopener noreferrer nofollow"
                          data-edit={`columns.${at}.links.${li}.label`}
                        >
                          {link.label}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </nav>
          )}

          {phone && (
            <a className="lp-footer-phone" href={`tel:${phone.replace(/[^\d+]/g, '')}`} dir="ltr">
              <Phone size={14} />
              <span>{phone}</span>
            </a>
          )}
          <p data-edit="text" {...rich(s.text || 'جميع الحقوق محفوظة')} />
        </footer>
      );
    }

    case 'sticky':
      // Fixed to the bottom of the screen, wherever it sits in the order. In the builder it also gets a strip WHERE
      // IT SITS, so selecting it gives an outline and a panel there — not around a button floating somewhere else.
      return (
        <>
        {ctx.building && <SlotFrame label="الزر العائم — بيطفو أسفل الشاشة للزائر" />}
        <StickyCta
          text={s.text}
          showPrice={s.showPrice}
          offers={ctx.offers}
          basePrice={ctx.price}
          currency={ctx.currency}
          whatsapp={ctx.whatsapp ?? null}
          motion={s.motion}
          motionSpeed={s.motionSpeed}
        />
        </>
      );
  }
}

function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="lp-section">
      {title && <h2 className="lp-h2" data-edit="title" {...rich(title)} />}
      {children}
    </section>
  );
}

/**
 * A block that is in the template and has nothing in it yet — in a preview
 * only. Six templates open a questions block and five a reviews block, and
 * with nothing written in them they rendered as nothing at all: the seller
 * chose a shape, got a shorter page, and never learned the section was
 * theirs to fill.
 */
function SlotFrame({ label }: { label: string }) {
  return (
    <div
      style={{
        padding: '18px 14px',
        textAlign: 'center',
        border: '2px dashed var(--store-accent-border)',
        borderRadius: 'var(--store-radius)',
        background: 'var(--store-accent-tint)',
        color: 'var(--store-accent)',
        fontSize: 12,
        fontWeight: 700,
      }}
    >
      {label}
    </div>
  );
}

/**
 * The shape of a photograph that is not there yet — in a preview only.
 *
 * It is drawn in the page's own accent, not grey: the point of a template
 * preview is the look of the whole page, and a neutral box in the middle of
 * a coloured one reads as a fault rather than as a space.
 */
function ImageFrame({ label, ratio }: { label: string; ratio: number }) {
  return (
    <div
      style={{
        aspectRatio: `1 / ${ratio}`,
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        border: '2px dashed var(--store-accent-border)',
        borderRadius: 'var(--store-radius)',
        background: 'var(--store-accent-tint)',
        color: 'var(--store-accent)',
        fontSize: 12,
        fontWeight: 700,
      }}
    >
      {label}
    </div>
  );
}

function Hero({ section: s, ctx }: { section: Extract<LandingSection, { type: 'hero' }>; ctx: BlockContext }) {
  const headline = s.headline || ctx.productName;
  /*
   * «السعر مع العرض» — THE FIRST OF THE FOUR, KEPT AT LAST.
   *
   * Every one of the ten structures declares `firstScreen.priceWithOffer:
   * true` and this header rendered `ctx.price`, which is the product's BASE
   * price. So a page selling «3 قطع بـ45» opened with «20» — the figure for
   * a quantity the form had not selected — and the visitor met the real
   * number for the first time at the button, which is where a COD order is
   * abandoned.
   *
   * The bundle shown is the one the form PRESELECTS (`isDefault`, else the
   * first), so the first screen and the submit button carry one number. The
   * struck-through figure follows the same rule the offer cards use: the
   * certain one (`listPrice`) wins over the claim about the past
   * (`compareAtPrice`), and two strikes on one price is a puzzle, not a
   * saving.
   */
  const selected = ctx.offers.find((o) => o.isDefault) ?? ctx.offers[0] ?? null;
  const shown = selected ? selected.price : ctx.price;
  const was = selected ? (selected.listPrice ?? selected.compareAtPrice ?? null) : null;
  return (
    <header className="lp-hero" data-hero={s.variant}>
      {s.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={s.image} alt={headline} className="lp-hero-img" />
      ) : (
        ctx.placeholders && <ImageFrame label="صورة المنتج" ratio={0.62} />
      )}
      <h1 className="lp-h1" data-edit="headline" {...rich(headline)} />
      {s.subheadline && <p className="lp-hero-sub" data-edit="subheadline" {...rich(s.subheadline)} />}
      {s.showPrice && shown > 0 && (
        /*
          THROUGH THE ONE DOOR. This wrote the price with a
          `toLocaleString` of its own — no minor unit, so a currency with
          three decimals was rendered with none, on the first screen of
          the page that sells it.
        */
        <p className="lp-price" dir="ltr">
          {was !== null && was > shown && <s>{moneyText(was, ctx.currency, ctx.minorUnit ?? 2)}</s>}
          {moneyText(shown, ctx.currency, ctx.minorUnit ?? 2)}
        </p>
      )}
      {/*
        «العروض جوّا أول شاشتين» — SAID IN SCREEN ONE, CHOSEN WHERE THEY LIVE.
        The bundle in the price above is the preselected one; this names the
        bundle and says how many others there are, and it is a link to the
        picker the seller already arranged — not a second copy of it. A page
        with three pickers on it is a page where choosing one does not
        visibly change the other two, and the arrangement of the blocks
        stays the seller's.
      */}
      {selected && ctx.offers.length > 0 && (
        // A filled shape (the pale tint, or the accent on trend): its words keep their own ink in every family — a
        // hero text colour (three templates set one) made the bundle name vanish on the pale pill.
        <OrderCta className="lp-hero-offers" data-ink="">
          <b>{selected.name}</b>
          {selected.freeQuantity > 0 && <em>+{selected.freeQuantity} مجاناً</em>}
          {ctx.offers.length > 1 && <span>{offersCountAr(ctx.offers.length)} — اختر عرضك</span>}
        </OrderCta>
      )}
      <OrderCta className="lp-cta" data-edit="ctaText">{s.ctaText || 'اطلب الآن'}</OrderCta>
      {/*
        THE THIRD PART OF THE LOCKED CORE.

        «النواة المقفولة: السعر مع العرض، وزر الطلب، وسطر الدفع عند الاستلام».
        Two of the three were on the first screen and this one was nowhere:
        every structure declares `firstScreen.codLine: true` and no renderer
        drew it, so the promise lived entirely in a schema. A visitor who came
        from an advert and does not own a card has one question before they
        read anything, and the answer was a thousand pixels down the page.

        It is not editable and not behind a flag — that is what «مقفولة»
        means. A seller cannot turn it off, and no skin can hide it: the rule
        is kept by there being no value that removes it.
      */}
      <p className="lp-hero-cod">{COD_LINE}</p>
    </header>
  );
}

/**
 * THE THREE REASSURANCES, AND THE ROW DRAWS WHAT IS TRUE.
 *
 * The seed used to fill this block with «طلب آمن · بياناتك محفوظة» and
 * «توصيل سريع · خلال أيام» — two sentences nobody measured, on the block
 * whose whole job is to be believed. A shopper cannot check «سريع», and a
 * shop that has never delivered anything said it anyway.
 *
 * So an untyped block is no longer an empty one: it renders the facts the
 * server resolved (`trustRow`) — cash on delivery always, the delivery
 * window only when this shop's own deliveries have cleared the sample
 * floor, the returns line only when the seller wrote a guarantee or
 * published a policy. A seller who types their own items still wins: those
 * are their words about their shop.
 */
function Trust({ section: s, ctx }: { section: Extract<LandingSection, { type: 'trust' }>; ctx: BlockContext }) {
  const typed = s.items.map((item, at) => ({ item, at })).filter(({ item }) => item.title);
  const icons = [Wallet, Truck, ShieldCheck];

  if (typed.length) {
    return (
      <div className="lp-trust">
        {typed.map(({ item, at: i }) => {
          const Icon = icons[i % icons.length];
          return (
            <div key={i}>
              <Icon size={18} style={{ color: 'var(--store-accent)' }} />
              <strong data-it="" data-edit={`items.${i}.title`} {...rich(item.title)} />
              {item.text && <span data-edit={`items.${i}.text`} {...rich(item.text)} />}
            </div>
          );
        })}
      </div>
    );
  }

  // `trustRow()` with nothing is the one-item row: COD is the only one of
  // the three that is true of every shop on this system before it has sold
  // anything. That is also what the builder and the gallery draw.
  const facts = ctx.trust ?? trustRow();
  return (
    <div className="lp-trust" data-facts="">
      {facts.map((f, i) => {
        const Icon = f.key === 'cod' ? Wallet : f.key === 'delivery' ? Truck : ShieldCheck;
        const body = (
          <>
            <Icon size={18} style={{ color: 'var(--store-accent)' }} />
            <strong data-it="">{f.title}</strong>
            <span>{f.text}</span>
          </>
        );
        // A policy the shop published is a page to open; the other two are
        // statements, and a link that goes nowhere is not an improvement.
        return f.href ? (
          <a key={i} href={f.href}>{body}</a>
        ) : (
          <div key={i}>{body}</div>
        );
      })}
    </div>
  );
}

function Urgency({ section: s, ctx }: { section: Extract<LandingSection, { type: 'urgency' }>; ctx: BlockContext }) {
  /*
   * Only a genuinely low count is worth showing. Inventing scarcity is the
   * one thing this block deliberately cannot do.
   *
   * The floor and the three silences (unknown · none · plenty) are
   * `lowStock` in `selling-blocks.ts` — the same twenty this line used to
   * carry inline. One place, because «how few is few enough to say out
   * loud» is a decision, and a decision written in two files is two
   * decisions the first time either is tuned.
   */
  const lowCount = s.showRealStock ? lowStock(ctx.stock) : null;

  /**
   * «تلقائي» READS THE OFFER'S OWN ENDING, AND THE PAGE SAYS SO BY STOPPING.
   *
   * `ctx.offerEndsAt` is filled by the server from `Offer.endsAt` — the
   * column the price itself stops at — so the clock and the price are one
   * fact. When there is none, the block renders NOTHING rather than falling
   * back to the per-visitor timer: a fallback is how a seller ends up
   * showing the dishonest clock they thought they had replaced. The save
   * door already refuses this configuration (`countdownRefusal`), so the
   * only way to be here is an offer that ended after the page was saved —
   * and a finished offer has no countdown to show.
   */
  const offerClock = s.countdown === 'offer';
  const until = offerClock ? (ctx.offerEndsAt ?? null) : null;
  const showsClock = offerClock ? Boolean(until) : s.minutes > 0;

  if (!s.text && !showsClock && lowCount === null) return null;

  return (
    <div className="lp-urgency">
      {s.text && <p>{s.text}</p>}
      {showsClock && (
        <Countdown
          minutes={s.minutes}
          id={s.id}
          persist={!ctx.building}
          until={until}
        />
      )}
      {lowCount !== null && (
        <p className="lp-stock">
          بقي <strong>{lowCount}</strong> فقط في المخزون
        </p>
      )}
    </div>
  );
}

/**
 * The outline, the name and the handles that appear around a block in the
 * builder — and only there.
 *
 * Hover shows what this is; clicking makes it the one being edited. The
 * handles are the three things wanted at the moment of pointing at
 * something: move it, hide it, remove it. Everything else stays in the
 * panel, because a toolbar with nine buttons on it is a toolbar nobody
 * reads.
 *
 * A hidden block still draws here, dimmed — it has to, or "show it again"
 * means finding a row for something invisible.
 */
function Selectable({
  section: s,
  selection,
  first,
  last,
  children,
}: {
  section: LandingSection;
  selection: BlockSelection;
  first: boolean;
  last: boolean;
  children: React.ReactNode;
}) {
  const active = selection.activeId === s.id;
  const off = !s.enabled;
  const copiedHere = selection.copiedFromId === s.id;

  return (
    <div
      role="button"
      tabIndex={0}
      data-block-id={s.id}
      onClick={(e) => {
        e.stopPropagation();
        selection.onSelect(s.id);
      }}
      onKeyDown={(e) => {
        // Only the block itself: Enter on a button, a select or a colour input INSIDE it is that control's own key —
        // swallowing it here left every control in the bar dead to the keyboard.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selection.onSelect(s.id);
        }
      }}
      className={`group relative cursor-pointer outline-none transition-[box-shadow] ${
        active ? 'z-10 shadow-[inset_0_0_0_2px_#b8256e]' : 'hover:shadow-[inset_0_0_0_2px_#f2c9dd]'
      }`}
    >
      {/* The name, on hover or while selected — placed inside the block so a
          tall one is still labelled where the cursor is. */}
      <span
        className={`pointer-events-none absolute start-2 top-2 z-20 rounded-md px-2 py-0.5 text-[10px] font-semibold text-white transition-opacity ${
          active ? 'bg-[#b8256e] opacity-100' : 'bg-[#121926]/70 opacity-0 group-hover:opacity-100'
        }`}
      >
        {selection.label(s)}
        {off && ' — مخفي'}
      </span>

      {/* A hidden block dims its CONTENT — the panel stays readable. */}
      <div style={off ? { opacity: 0.45 } : undefined}>{children}</div>

      {/*
        ONE bar, on the block — and now IN the page, after the block, not floating over the next one.

        It was absolute under the block: it covered the block below, was cut off on the last block, sat off-screen on
        a block taller than the window, and jumped sideways as its tabs opened. In the flow it makes room for itself;
        `sticky` to the bottom keeps it on screen while a tall block is scrolled; and it is drawn at its own size
        whatever the preview is zoomed to.
      */}
      {active && (
        <div
          data-block-bar
          className="z-30 mt-1 mb-2 flex flex-wrap items-center gap-1 rounded-lg bg-white p-1 shadow-lg ring-1 ring-[#e3e8ef]"
          style={{ position: 'sticky', bottom: 8, marginInline: 8, zoom: 1 / (selection.zoom || 1) }}
          onClick={(e) => e.stopPropagation()}
        >
          <Handle
            title="تعديل"
            onClick={() => selection.onEdit?.(s.id)}
            icon={<Pencil className="h-3.5 w-3.5" />}
          />
          {/* A block the page may only hold one of has nothing to copy TO. */}
          {selection.canDuplicate?.(s) !== false && (
            <Handle
              title="تكرار"
              onClick={() => selection.onDuplicate?.(s.id)}
              icon={<CopyPlus className="h-3.5 w-3.5" />}
            />
          )}
          {/* Matching two blocks by hand is eight controls set twice, and a third block that never quite matches.
              Copy and paste are a clipboard pair — not a palette and a brush beside the panel's own colour tabs. */}
          <Handle
            title={copiedHere ? 'نُسخ — الصقه على قسم ثاني' : 'نسخ الشكل'}
            onClick={() => selection.onCopyLook?.(s.id)}
            icon={copiedHere ? <Check className="h-3.5 w-3.5" /> : <ClipboardCopy className="h-3.5 w-3.5" />}
          />
          {selection.hasCopiedLook && !copiedHere && (
            <Handle
              title="لصق الشكل"
              onClick={() => selection.onPasteLook?.(s.id)}
              icon={<ClipboardPaste className="h-3.5 w-3.5" />}
            />
          )}
          <span className="mx-0.5 h-4 w-px bg-[#e3e8ef]" />
          <Handle
            title="لأعلى"
            disabled={first}
            onClick={() => selection.onMove?.(s.id, -1)}
            icon={<ChevronUp className="h-3.5 w-3.5" />}
          />
          <Handle
            title="لأسفل"
            disabled={last}
            onClick={() => selection.onMove?.(s.id, 1)}
            icon={<ChevronDown className="h-3.5 w-3.5" />}
          />
          {/*
            A BLOCK THE PAGE IS NEVER WITHOUT HAS NO HIDE AND NO DELETE.
            The form and the floating button are re-enabled on every public
            render (`ensureSellingCore`), so these two controls used to do
            nothing a visitor could see — the seller pressed «إخفاء», the
            badge said «مخفي», and the shopper got the block anyway. A
            control that lies about what it did is worse than no control.
          */}
          {!LOCKED_SECTIONS.includes(s.type) && (
            <>
              <Handle
                title={s.enabled ? 'إخفاء' : 'إظهار'}
                onClick={() => selection.onToggle?.(s.id)}
                icon={s.enabled ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              />
              <Handle
                title="حذف"
                danger
                onClick={() => selection.onRemove?.(s.id)}
                icon={<Trash2 className="h-3.5 w-3.5" />}
              />
            </>
          )}
          {selection.toolbar && (
            <>
              <span className="mx-0.5 h-4 w-px bg-[#e3e8ef]" />
              {selection.toolbar(s)}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Handle({
  title,
  icon,
  onClick,
  disabled,
  danger,
}: {
  title: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`cursor-pointer rounded p-1 disabled:cursor-default disabled:opacity-30 ${
        danger ? 'text-[#fb323f] hover:bg-[#feecee]' : 'text-[#364152] hover:bg-[#eef2f6]'
      }`}
    >
      {icon}
    </button>
  );
}
