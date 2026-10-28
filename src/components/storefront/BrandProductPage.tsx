import { SIZES_HERO, srcSetFor } from '@/lib/responsive-image';
import { PreloadHero } from './PreloadHero';
import { ProductCard } from './ProductCard';
import { OfferCards } from '@/components/landing/blocks/OfferCards';
import { LandingFormBridge } from '@/components/landing/LandingFormBridge';
import OrderForm from '@/components/landing/OrderForm';
import { moneyText } from '@/lib/money';
import { whatsappHref } from '@/lib/store-contact';
import { worldVars } from '@/lib/store-world';
import { brandSections, type BrandContent } from '@/lib/store-brand-template';
import { BRAND_PAGE_SHEET } from './styles';
import type { StorefrontProduct } from '@/lib/storefront';
import type { OfferView } from '@/lib/offers';
import type { PageCheckout } from '@/lib/store-theme';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE «علامة» PRODUCT PAGE — DRAWN FROM THE PRODUCT'S FIELDS, FULL STOP.
 *
 * The owner's rule 0 (`S1-FAMILY-4-ALAMA.md`): «علامة قالب، مش صفحات
 * بتنعمل بالإيد. أي منتج جديد بيطلع بنفس الشكل من حقوله، بلا مصمّم ولا
 * شغل يدوي» — and «أي حقل فاضي، قسمه بيختفي لحاله والصفحة بتضلّ كاملة».
 *
 * ── HOW THAT RULE IS ENFORCED RATHER THAN OBSERVED ──
 *
 * This component does not decide what to draw. `brandSections(content)`
 * does, in `store-brand-template.ts`, and it answers from the fields
 * alone. Here it is a `Set` that each section is checked against, so a
 * section whose field is empty is not «drawn empty» — it is not reachable.
 * A heading over nothing, a frame round a missing picture, an empty circle
 * of promises: none of them has a code path. §١٠ of the owner's note is
 * the test, in `store-brand-template.test.ts`, with the sixth product
 * that has a name and a photograph and nothing else.
 *
 * ── WHAT THIS DOES NOT TOUCH ──
 *
 * The order. The form is the one every other page uses, with the same
 * fields, the same endpoint and the same bridge — «الحقول زي ما هي». The
 * prices are the engine's offers, drawn by the engine's own card, which
 * already carries the only struck-through figure this product allows
 * (`price-honesty.ts`). Nothing here computes what anybody is charged.
 *
 * ── AND NO INVENTED PROOF ──
 *
 * «انطلب ٤٦ مرة» appears only when `store-facts.ts` counted it from
 * DELIVERED orders above its floor; below the floor the line is absent
 * rather than small. The owner's note allows a demo number carrying a
 * «مثال» badge; this family needs no such badge because it prints no
 * number it has not counted. The two sections of his note that have no
 * field behind them — the shape switcher and the WhatsApp bubbles — are
 * not drawn at all, and `docs/storefront/FAMILIES.md` says why.
 * ═══════════════════════════════════════════════════════════════════════
 */

/**
 * WHERE THE THREE NUMBERS SIT ON THE RING — twelve o'clock, then the two
 * lower corners. Written as data because they ARE data: the stylesheet
 * reads them through two custom properties and has one rule instead of
 * three. A fourth promise cannot reach this list — `brandContent` caps
 * them at three, and the circle is why.
 */
const RING_SEAT = [
  { '--sy': '0', '--sx': 'calc(50% - 17px)' },
  { '--sy': '72%', '--sx': '0' },
  { '--sy': '72%', '--sx': 'calc(100% - 34px)' },
] as unknown as React.CSSProperties[];

export interface BrandPageShop {
  slug: string;
  /**
   * The shop's currency, never null — the order form takes a `string`,
   * because a form that could not name the currency would be a form that
   * could take an order in no money at all.
   */
  currency: string;
  minorUnit: number;
  dir: 'rtl' | 'ltr';
  supportPhone: string | null;
}

export function BrandProductPage({
  shop,
  product,
  content,
  offers,
  /**
   * The figure to strike through beside the price, or null.
   *
   * Handed in already decided — the route reads it off the single-unit
   * offer's own proved «was» price. Never computed here: a page that did
   * its own price arithmetic would be a second place a price can be
   * wrong, which is the whole argument of `price-honesty.ts`.
   */
  compareAt,
  regions,
  phonePlaceholder,
  endpoint,
  /** The rest of the series, already read off the shelf. */
  series,
  /** «يوصل عادةً خلال…» — counted, above its floor, or null. */
  deliveryDays,
  /** The shop's own returns page, when it has one. */
  returns,
  /**
   * The shop's «الدفع» for the order form — the fields it shows and their order, its marks, its button. Worked out
   * by the route from the store's LIVE theme and handed in, like the endpoint: the page decides none of it.
   */
  checkout,
}: {
  shop: BrandPageShop;
  product: StorefrontProduct & { gallery: string[] };
  content: BrandContent;
  /**
   * The engine's own offers, in the engine's own shape — `OfferView`, the
   * one `activeOffersFor` returns and the order form takes. A local shape
   * here would be a second place a price could be described.
   */
  offers: OfferView[];
  compareAt: number | null;
  regions: string[];
  phonePlaceholder?: string;
  endpoint: string;
  series: (StorefrontProduct & { gallery?: string[] })[];
  deliveryDays: number | null;
  returns: { href: string; label: string } | null;
  checkout?: PageCheckout;
}) {
  const show = new Set(brandSections(content));
  const money = (n: number) => moneyText(n, shop.currency, shop.minorUnit);
  const wa = whatsappHref(shop.supportPhone);

  return (
    /*
     * THE WORLD IS WRITTEN HERE, ONCE, AS THE SHOP'S OWN VARIABLES.
     * Every rule below and every rule in the base stylesheet then paints
     * itself in this product's colours — see store-world.ts on why that
     * is the shape of it and what it saved.
     */
    <article className="sf-product sf-bp" style={worldVars(content.world) as React.CSSProperties}>
      {/*
        THIS PAGE'S OWN RULES, CARRIED BY THIS PAGE.

        Two and a half kilobytes that only «علامة»'s product page matches
        — the ring of promises, the dark panels, the sticky bar. The shop
        shell carries the family's shop-wide half, the home carries the
        hero's, and this carries its own: measured, that is what keeps a
        «علامة» shop inside the brief's 50 KB of stylesheet while three
        other branches are adding rules to the shared block library.
      */}
      <style dangerouslySetInnerHTML={{ __html: BRAND_PAGE_SHEET }} />
      <section className="sf-bp-hero">
        <span className="sf-bw-art sf-bp-art">
          {/* The faint Latin word, INSIDE the picture's box — never behind
              a price or a figure (the owner's ruling of 15/10). */}
          {show.has('ghost') && content.latin ? (
            <span className="sf-bw-ghost" aria-hidden>
              {content.latin}
            </span>
          ) : null}
          {product.image ? (
            <>
              {/* The LCP of this page, preloaded through ReactDOM.preload
                  and never lazy — see PreloadHero and the note on the
                  other product page. */}
              <PreloadHero image={product.image} />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={product.image}
                srcSet={srcSetFor(product.image) ?? undefined}
                sizes={srcSetFor(product.image) ? SIZES_HERO : undefined}
                alt={product.name}
                className="sf-gallery-main"
                fetchPriority="high"
                decoding="async"
              />
            </>
          ) : (
            <span className="sf-card-none" data-letter={product.name.trim().charAt(0)} aria-hidden />
          )}
        </span>

        <div className="sf-bw-say sf-bp-say">
          {show.has('badges') && (
            // The specification line, in the pill the block library
            // already ships: «lp-quiz-options» is the row and
            // «lp-quiz-option» is the pill — border, radius, padding and
            // the muted ink, all of it already in every shop's sheet.
            // Writing them again for this family cost 220 bytes.
            <p className="lp-quiz-options sf-bp-badges">
              {content.badges.map((b) => (
                <span className="lp-quiz-option" key={b}>{b}</span>
              ))}
            </p>
          )}
          <h1>{content.title}</h1>
          {content.line ? <p className="sf-bp-line">{content.line}</p> : null}

          <p className="sf-bp-price" dir="ltr">
            <strong>{money(product.fromPrice)}</strong>
            {compareAt !== null && <s>{money(compareAt)}</s>}
            {/* «وفّر» from two figures the engine already proved, and only
                when the difference is real. No new money rule: both
                numbers are the ones printed above. */}
            {compareAt !== null && compareAt > product.fromPrice && (
              <em>وفّر {money(compareAt - product.fromPrice)}</em>
            )}
          </p>

          <p className="sf-bp-cta">
            <a className="lp-cta" href="#sf-order">
              اطلب الآن — الدفع عند الاستلام
            </a>
            {wa && (
              <a className="lp-cta sf-bw-all" href={wa} rel="noopener noreferrer" target="_blank">
                أو اطلب عالواتساب
              </a>
            )}
          </p>

          {show.has('proof') && (
            <p className="sf-bp-line">انطلب {content.orderedCount} مرة — من طلبات وصلت فعلاً</p>
          )}
        </div>
      </section>

      {show.has('promises') && (
        <section className="lp-section sf-bp-vows-wrap">
          <h2 className="lp-h2">مكتوبة عالعلبة</h2>
          <p className="lp-sub">تلات وعود، ولا وعد زيادة</p>
          {product.image && (
            <div className="sf-bp-ring">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={product.image} alt="" loading="lazy" decoding="async" />
              {/*
                EACH NUMBER CARRIES ITS OWN PLACE AROUND THE CIRCLE.

                Three positions were three rules in the stylesheet; they
                are three pairs of numbers, which is data. The rule that
                reads them is one, and the shopper's stylesheet is 250
                bytes lighter — on the family that has the least of them.
              */}
              {content.promises.map((_, i) => (
                <span
                  key={i}
                  className="sf-bp-num"
                  aria-hidden
                  style={RING_SEAT[i] as React.CSSProperties}
                >
                  {i + 1}
                </span>
              ))}
            </div>
          )}
          {/*
            NUMBERED, IN THE BLOCK LIBRARY'S OWN LIST.

            «lp-timeline» is already a list with a first column and a
            hairline between rows, and it is already in every shop's
            stylesheet. Writing a second numbered list for this family
            cost 342 bytes of a budget «علامة» does not have — the
            number goes in the column the list already has, and nothing
            new is styled. Western digits, as everywhere in this product.
          */}
          <ol className="lp-timeline sf-bp-vows">
            {content.promises.map((p, i) => (
              <li key={p}>
                <span className="lp-timeline-when">{i + 1}</span>
                <span className="lp-timeline-what">{p}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {show.has('closeup') && (
        <section className="lp-section sf-bp-close">
          {content.closeup && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={content.closeup}
              srcSet={srcSetFor(content.closeup) ?? undefined}
              alt=""
              loading="lazy"
              decoding="async"
            />
          )}
          <div>
            <h2 className="lp-h2">المكوّن</h2>
            {content.ingredient ? <p className="sf-bp-line">{content.ingredient}</p> : null}
          </div>
        </section>
      )}

      {show.has('video') && content.video && (
        <section className="lp-section sf-bp-video">
          <h2 className="lp-h2">شوفه بالاستعمال</h2>
          <p className="lp-sub">فيديو قصير · بدون صوت</p>
          {/*
            LAZY, WITH A POSTER, AND NO AUTOPLAY.
            «ما بيتحمّل إلا لما يوصله السكرول، وقبله بتطلع صورة» — so the
            element carries `preload="none"` (the browser fetches nothing
            until somebody presses play), the product's own photograph as
            the poster, and `controls` so pressing play is a decision. A
            video that started itself would spend the shopper's data on a
            page they were still reading.
          */}
          <video
            controls
            preload="none"
            playsInline
            poster={product.image ?? undefined}
            src={content.video}
          />
        </section>
      )}

      {show.has('howto') && (
        <section className="lp-section">
          <h2 className="lp-h2">كيف بتستعمله</h2>
          <ol className="lp-timeline sf-bp-vows">
            {content.steps.map((s, i) => (
              <li key={s}>
                <span className="lp-timeline-when">{i + 1}</span>
                <span className="lp-timeline-what">{s}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="lp-section lp-form-section" id="sf-order">
        <h2 className="lp-h2">اطلب هلّق، وبتدفع لما يوصلك</h2>
        {offers.length > 0 && <OfferCards offers={offers} currency={shop.currency} />}
        {/*
          THE ORDER PATH, UNCHANGED.
          The same bridge, the same form, the same fields and the same
          endpoint as every other door — `src/lib/public-order.ts` is
          untouchable and this is how a new look stays a look.
        */}
        <LandingFormBridge
          offers={offers.map((o) => ({ id: o.id, price: o.price }))}
          currency={shop.currency}
          product={{ id: product.id, name: product.name }}
        >
          <OrderForm
            slug={`${shop.slug}/${product.sku}`}
            productName={product.name}
            basePrice={product.basePrice}
            currency={shop.currency}
            offers={offers}
            recommendations={[]}
            regions={regions}
            phonePlaceholder={phonePlaceholder}
            showOfferPicker={offers.length === 0}
            dir={shop.dir}
            whatsapp={shop.supportPhone}
            endpoint={endpoint}
            checkout={checkout}
          />
        </LandingFormBridge>
        <p className="lp-sub">رح نتصل فيك نأكّد الطلب قبل ما نشحنه</p>
      </section>

      {/*
        THE THREE QUESTIONS, ANSWERED ONLY WHERE THE SHOP CAN ANSWER THEM.
        Payment is a fact of this system — every order is cash at the door.
        The delivery line appears only when `delivery-time.ts` counted
        enough real deliveries to say so. The returns question appears only
        when the shop has a returns page, and then it points at it: a
        template must not promise a return policy on a seller's behalf.
      */}
      <section className="lp-section sf-bp-faq">
        <h2 className="lp-h2">أسئلة</h2>
        {deliveryDays !== null && (
          <details className="lp-faq-item">
            <summary>قديش بياخد التوصيل؟</summary>
            <p>بيوصل عادةً خلال {deliveryDays} أيام — محسوبة من طلبات وصلت فعلاً.</p>
          </details>
        )}
        <details className="lp-faq-item">
          <summary>كيف بدفع؟</summary>
          <p>الدفع عند الاستلام — ما في حاجة لبطاقة، وبتدفع لما يوصلك.</p>
        </details>
        {returns && (
          <details className="lp-faq-item">
            <summary>في استبدال أو إرجاع؟</summary>
            <p>
              آه — اقرا <a href={returns.href}>{returns.label}</a>.
            </p>
          </details>
        )}
      </section>

      {show.has('series') && series.length > 0 && (
        <section className="sf-row">
          <h2>كمان من السلسلة</h2>
          <div className="sf-grid">
            {series.map((other) => (
              <ProductCard
                key={other.id}
                slug={shop.slug}
                product={other}
                currency={shop.currency}
                minorUnit={shop.minorUnit}
                /* Every card in its own product's world — the one place a
                   card's variant is not the shop's choice but the
                   family's, because the series IS the family. */
                variant="world"
              />
            ))}
          </div>
        </section>
      )}

      {/*
        THE BAR THAT FOLLOWS THE PRICE UP THE PAGE — sticky, not fixed.
        A fixed bar escapes a preview box, which is the bug the owner
        photographed on the templates screen; a sticky one cannot leave
        the article it belongs to.
      */}
      <div className="sf-bp-sticky">
        <strong dir="ltr">{money(product.fromPrice)}</strong>
        <a className="lp-cta" href="#sf-order">
          اطلب الآن — الدفع عند الاستلام
        </a>
      </div>
    </article>
  );
}
