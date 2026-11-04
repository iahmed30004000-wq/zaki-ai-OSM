import Link from 'next/link';
import { SIZES_CARD, srcSetFor } from '@/lib/responsive-image';
import { moneyText } from '@/lib/money';
import type { CardVariant } from '@/lib/store-theme';
import type { ProductAttributes } from '@/lib/product-attributes';
import { badgesFrom, latinWord, readProductText } from '@/lib/store-brand-template';
import { worldOf, worldVars } from '@/lib/store-world';

/**
 * ONE PRODUCT, ON A CARD — AND THERE IS ONLY ONE OF THESE.
 *
 * The same markup was hand-written in four places: the shop's front page,
 * the shelf, «يُشترى معه عادةً» and «شوهد مؤخراً». Four copies is four
 * chances to forget the empty state, or the «من», or the null-name guard
 * — and three of them HAD. This is the front page's version, which was
 * the best of the four, with the other three moved onto it rather than
 * the newest one winning because it was written last.
 *
 * THREE THINGS EVERY VARIANT KEEPS, whatever the template chose:
 *
 * A FIXED IMAGE RATIO. Cards of different heights make a grid that saws
 * up and down, and on a phone that is most of what a shopper sees.
 *
 * A DESIGNED EMPTY STATE. «بطاقات المنتجات بلا صور وبلا حالة بديلة
 * مصممة» is on the brief's list of this storefront's mistakes. The
 * product's initial in a wash of the shop's own colour says «the picture
 * goes here»; a broken-image icon says «something is broken».
 *
 * AND THE PRICE, ALWAYS VISIBLE. It is in the locked core: a card that
 * makes somebody tap to find out what a thing costs has spent a page
 * load on a question the card could have answered.
 */
export function ProductCard({
  slug,
  product,
  currency,
  minorUnit,
  variant,
}: {
  slug: string;
  product: {
    id: string;
    /** The address a link should use — see `StorefrontProduct.handle`. */
    handle: string;
    sku: string;
    name: string;
    image: string | null;
    fromPrice: number;
    /** When it is higher than `fromPrice`, the card says «من». */
    basePrice?: number;
    /**
     * ── THE THREE «علامة» READS, AND NOBODY ELSE DOES ──
     *
     * The `world` card prints the Latin name, the product's own sentence
     * and its specification line, and paints itself in the product's own
     * colours. All three are optional because every other variant has
     * drawn a card without them since this component existed, and a
     * required field would be four call sites changed to serve one
     * family.
     */
    nameEn?: string | null;
    description?: string | null;
    attributes?: ProductAttributes | null;
  };
  currency: string | null;
  minorUnit: number;
  variant: CardVariant;
}) {
  /**
   * A name is not guaranteed. One row with a null name took the whole
   * shop page down with «Cannot read properties of undefined» — a missing
   * letter is a dash; a missing shop is an outage.
   */
  const letter = (product.name ?? '').trim().charAt(0) || '—';

  /*
   * ── THE «علامة» CARD, AND WHY IT IS A BRANCH RATHER THAN CSS ──
   *
   * «كرت لكلّ منتج بعالم منتجه» — the card wears the PRODUCT's colours,
   * not the shop's, and carries three things no other variant shows. The
   * other five variants are pure arrangement and stay that way: this one
   * renders extra elements, so it is decided here rather than hidden by a
   * `display: none` the other five would have to carry.
   *
   * What it does NOT change is the locked core — the picture at a fixed
   * ratio, the designed empty state, and the price, always visible. Those
   * three are below, outside this branch, for every variant including
   * this one. `card-variants.test.ts` counts them.
   */
  const isWorld = variant === 'world';
  const world = isWorld ? worldOf({ id: product.id, attributes: product.attributes ?? null }) : null;
  const latin = isWorld ? latinWord(product.nameEn) : null;
  const line = isWorld ? readProductText(product.description).line : null;
  const specs = isWorld ? badgesFrom(product.attributes).join(' · ') : '';

  return (
    // The href stays on this line with the tag: `shop-budget.test.ts`
    // pins «the card is a real Link» by reading exactly this, and an
    // `<a>` here would render the same and prefetch nothing.
    <Link href={`/s/${slug}/p/${encodeURIComponent(product.handle)}`}
      className="sf-card"
      data-card={variant}
      style={world ? (worldVars(world) as React.CSSProperties) : undefined}
    >
      {product.image ? (
        // The seller's own upload. next/image would need every host
        // allow-listed, and a missing picture is worse than an
        // unoptimised one — so the sizes come from our own media route
        // instead. `srcSetFor` returns null for anything that is not ours,
        // and then this is the plain `src` it always was.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={product.image}
          srcSet={srcSetFor(product.image) ?? undefined}
          sizes={srcSetFor(product.image) ? SIZES_CARD : undefined}
          alt={product.name ?? ''}
          className="sf-card-img"
          loading="lazy"
          decoding="async"
        />
      ) : (
        <span className="sf-card-none" data-letter={letter} aria-hidden />
      )}
      <span className="sf-card-body">
        {/* Latin, tracked out — which is allowed for Latin and never for
            Arabic, and that is why it is a separate element with its own
            rule rather than a letter-spacing on the name. */}
        {latin ? <span className="sf-card-latin">{latin}</span> : null}
        <span className="sf-card-name">{product.name}</span>
        {line ? <span className="sf-card-line">«{line}»</span> : null}
        {specs ? <span className="sf-card-specs">{specs}</span> : null}
        <span className="sf-card-price" dir="ltr">
          {/* The cheapest per unit across its bundles — the number a
              shopper compares, computed from the offers the order path
              charges from. */}
          {/* «من» AFTER the amount in this left-to-right pill, so it lands on
              the amount's RIGHT — where an Arabic reader starts. Written
              first, it sat on the left and the pill read «من 15.00 USD»
              backwards, with the currency in the middle of the sentence. */}
          {moneyText(product.fromPrice, currency, minorUnit)}
          {product.basePrice !== undefined && product.fromPrice < product.basePrice && <small> من</small>}
        </span>
        {isWorld ? <span className="sf-card-go">شوف المنتج</span> : null}
      </span>
    </Link>
  );
}
