import React from 'react';
import Link from 'next/link';
import type { HeroVariant } from '@/lib/layout-slots';
import { moneyText } from '@/lib/money';
import { SIZES_CARD, SIZES_HERO, srcSetFor } from '@/lib/responsive-image';
import type { ProductAttributes } from '@/lib/product-attributes';
import { latinWord } from '@/lib/store-brand-template';
import { worldVars, worldOf } from '@/lib/store-world';
import { WORLD_STAGES } from './styles';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE SHOP'S FIRST SCREEN — THE ONE THE TEMPLATE ACTUALLY PICKED.
 *
 * `LAYOUT_SLOTS.hero` has named five of these since it was written. The
 * gallery drew all five in its miniature, so a seller opened «القوالب»,
 * saw five visibly different first screens, picked one, and saved it. The
 * shop then drew a sixth thing nobody had chosen: the tagline in a box —
 * or, when the tagline was empty, nothing at all, and the page opened on
 * a bare grid. `layoutOf(theme, 'hero')` was called nowhere in the
 * storefront. See `docs/storefront/AUDIT-2a-delta.md` §2.
 *
 * ── ONE COMPONENT, TWO SIZES ──
 *
 * The gallery's miniature used to be a second, inline-styled drawing of
 * the same five ideas, and that is why the two could disagree without
 * anybody noticing: nothing connected them except a word. Now there is
 * one component. `mini` renders the same markup and the same variant
 * branch at preview scale — no fonts, no links, placeholder content —
 * so a hero that does not exist here cannot be promised there.
 *
 * ── WHAT A HERO MAY NOT BE ──
 *
 * The rule from `layout-slots.ts` holds: there is no variant here that
 * means «the shop's name, alone». Every one of the five leads with
 * something to buy, something on offer, or a way in. A header already
 * carries the name; a first screen that repeats it sells nothing.
 *
 * ── NO MONEY IS COMPUTED HERE ──
 *
 * Prices arrive already resolved — `fromPrice` off the shelf, the same
 * number the card and the checkout use — and are only formatted, through
 * the one formatter. A hero that did its own arithmetic would be a fourth
 * place a price could be wrong.
 * ═══════════════════════════════════════════════════════════════════════
 */

export interface HeroProduct {
  id: string;
  name: string;
  handle: string;
  image: string | null;
  fromPrice: number;
  /**
   * The Latin name, set huge and faint behind the photograph by
   * «علامة» and by nothing else. Optional: every other variant has
   * never needed it, and a required field here would make the gallery's
   * placeholder products lie about what a hero needs.
   */
  nameEn?: string | null;
  /**
   * This product's answers to its category's questions — read only for
   * the one of them that may name a colour, which is how a product gets
   * its own world. See `store-world.ts`.
   */
  attributes?: ProductAttributes | null;
}

export interface HeroCategory {
  id: string;
  name: string;
}

export interface StoreHeroProps {
  variant: HeroVariant;
  /** The shop's own words. Either may be empty — no variant depends on them. */
  tagline?: string | null;
  about?: string | null;
  slug: string;
  currency: string | null;
  minorUnit: number;
  /** Already on the shelf, already priced. Newest first, as the grid has them. */
  products: HeroProduct[];
  categories: HeroCategory[];
  /** Preview scale: same markup, no links, no fonts, placeholder-safe. */
  mini?: boolean;
}

/** A product's picture, or its initial — the shop-wide answer to «no photo yet». */
/**
 * THE FIRST PICTURE OF THE FIRST SCREEN IS ASKED FOR FIRST.
 *
 * Every thumb was `loading="lazy"` with the full 1200px file and no
 * `srcSet`. Measured on «صحة بلس» (4/11) at 375px: the first screen opened
 * on an empty white frame the width of the phone, and the picture arrived
 * last — a lazy image is fetched after layout, the full file after that.
 * The lead picture is now eager and high-priority, and every thumb asks
 * our media route for the width it is drawn at, as the grid's cards do.
 * The dashboard's miniature stays lazy: it draws eleven of these on one
 * screen, and none of them is anybody's first paint.
 */
function Thumb({ product, lead = false }: { product: HeroProduct; lead?: boolean }) {
  const set = srcSetFor(product.image);
  return (
    <span className="sf-hx-img" data-letter={(product.name ?? '').trim().charAt(0)}>
      {product.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={product.image}
          srcSet={set ?? undefined}
          sizes={set ? (lead ? SIZES_HERO : SIZES_CARD) : undefined}
          alt=""
          loading={lead ? 'eager' : 'lazy'}
          fetchPriority={lead ? 'high' : undefined}
          decoding="async"
        />
      ) : null}
    </span>
  );
}

export function StoreHero({
  variant,
  tagline,
  about,
  slug,
  currency,
  minorUnit,
  products,
  categories,
  mini = false,
}: StoreHeroProps) {
  /*
   * A LINK IN THE SHOP, A PLAIN BOX IN THE MINIATURE.
   *
   * The preview lives inside the dashboard, where a storefront link would
   * navigate the seller out of the screen they are choosing a template on.
   */
  const Wrap = ({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) =>
    mini ? <span className={className}>{children}</span> : <Link href={href} className={className}>{children}</Link>;

  const price = (p: HeroProduct) => moneyText(p.fromPrice, currency, minorUnit);

  const body = (() => {
    switch (variant) {
      /*
       * THE GOODS THEMSELVES, BIG, BEFORE ANYTHING ELSE.
       * The brief's «أول شاشة ما فيها منتج ولا عرض ولا فئة» answered most
       * directly: three products, large, above the grid they repeat from.
       * It is the default because a shop that has set nothing still opens
       * on something a shopper can tap.
       */
      case 'productFirst':
        return products.slice(0, 3).map((p, i) => (
          <Wrap key={p.id} href={`/s/${slug}/p/${encodeURIComponent(p.handle)}`} className="sf-hx-feature">
            <Thumb product={p} lead={i === 0 && !mini} />
            <span className="sf-hx-name">{p.name}</span>
            <span className="sf-hx-price">{price(p)}</span>
          </Wrap>
        ));

      /*
       * THE CHEAPEST THINGS FIRST, AS A STRIP.
       * «من» prices off the shelf, ascending — the shop leading with its
       * reason to buy today rather than with its name.
       */
      case 'offerStrip': {
        const cheap = [...products].sort((a, b) => a.fromPrice - b.fromPrice).slice(0, 4);
        return cheap.map((p) => (
          <Wrap key={p.id} href={`/s/${slug}/p/${encodeURIComponent(p.handle)}`} className="sf-hx-offer">
            <span className="sf-hx-name">{p.name}</span>
            <span className="sf-hx-price">{price(p)}</span>
          </Wrap>
        ));
      }

      /*
       * THE WAYS IN, AS TILES.
       * For a shop whose shopper arrives knowing the KIND of thing they
       * want and not the product. Falls back to products when the shop has
       * no categories — a first screen of empty tiles is the «nothing to
       * buy» failure wearing a different shape.
       */
      case 'categoryTiles': {
        if (categories.length === 0) {
          return products.slice(0, 3).map((p) => (
            <Wrap key={p.id} href={`/s/${slug}/p/${encodeURIComponent(p.handle)}`} className="sf-hx-feature">
              <Thumb product={p} />
              <span className="sf-hx-name">{p.name}</span>
            </Wrap>
          ));
        }
        return categories.slice(0, 6).map((c) => (
          <Wrap key={c.id} href={`/s/${slug}/shop?cat=${encodeURIComponent(c.id)}`} className="sf-hx-tile">
            <span className="sf-hx-name">{c.name}</span>
          </Wrap>
        ));
      }

      /*
       * THE SHOP'S OWN SENTENCE, SET LIKE A SENTENCE.
       * The only variant that leads with words — for a shop whose promise
       * is the reason to trust it («نوصّل لكل المحافظات، والدفع عند
       * الاستلام»). It still ends in a way forward, and it still shows a
       * product beside it, so it is never a page of prose.
       */
      case 'editorial':
        return (
          <>
            <span className="sf-hx-say">
              <strong>{tagline || 'كل المنتجات'}</strong>
              {about ? <em>{about}</em> : null}
              <Wrap href={`/s/${slug}/shop`} className="sf-hx-go">تسوّق الآن</Wrap>
            </span>
            {products[0] ? (
              <Wrap href={`/s/${slug}/p/${encodeURIComponent(products[0].handle)}`} className="sf-hx-feature">
                <Thumb product={products[0]} />
                <span className="sf-hx-name">{products[0].name}</span>
                <span className="sf-hx-price">{price(products[0])}</span>
              </Wrap>
            ) : null}
          </>
        );

      /*
       * THREE, SIDE BY SIDE, SCROLLED BY HAND.
       * «بثلاث شرائح كحد أقصى» and nothing that moves on its own — the
       * motion rule the contract already enforces. A CSS scroll-snap row,
       * so it costs no JavaScript and works with the keyboard.
       */
      case 'slider':
        return products.slice(0, 3).map((p) => (
          <Wrap key={p.id} href={`/s/${slug}/p/${encodeURIComponent(p.handle)}`} className="sf-hx-slide">
            <Thumb product={p} />
            <span className="sf-hx-name">{p.name}</span>
            <span className="sf-hx-price">{price(p)}</span>
          </Wrap>
        ));

      /*
       * «عيادة»'S FIRST SCREEN — THE CLAIM BESIDE THE ONLY PROOF THERE IS.
       *
       * Two columns: what the shop says about itself, and beside it a card
       * carrying the facts a wary shopper is actually deciding on, with
       * something priced underneath.
       *
       * AND THE FACTS ARE THE SHOP'S TERMS, never a number about other
       * people. «اشتراه ٢٤٠ شخص» would be the one claim a shopper cannot
       * check, and this system refuses to print one it has not counted —
       * `store-facts.ts` is where a counted one comes from, with a floor,
       * and it is not here because a hero renders before any of that is
       * known. Cash at the door and «توصيل لكل المحافظات» are things this
       * shop DOES, which is a different kind of sentence.
       */
      case 'splitProof':
        return (
          <>
            <span className="sf-hx-say">
              <strong>{tagline || products[0]?.name || 'كل المنتجات'}</strong>
              {about ? <em>{about}</em> : null}
              <Wrap href={`/s/${slug}/shop`} className="sf-hx-go">تسوّق الآن</Wrap>
            </span>
            <span className="sf-hx-proof">
              <span className="sf-hx-fact">الدفع عند الاستلام</span>
              <span className="sf-hx-fact">توصيل لكل المحافظات</span>
              <span className="sf-hx-fact">تتصل فينا قبل ما تطلب</span>
              {products[0] ? (
                <Wrap
                  href={`/s/${slug}/p/${encodeURIComponent(products[0].handle)}`}
                  className="sf-hx-feature"
                >
                  <Thumb product={products[0]} />
                  <span className="sf-hx-name">{products[0].name}</span>
                  <span className="sf-hx-price">{price(products[0])}</span>
                </Wrap>
              ) : null}
            </span>
          </>
        );

      /*
       * ═════════════════════════════════════════════════════════════════
       * «علامة»'S FIRST SCREEN — ONE PRODUCT, ITS OWN WORLD, AND A ROW
       * OF CIRCLES THAT MOVES THE WHOLE SCREEN TO ANOTHER ONE.
       *
       * The owner's §٣: a dark background in the product's own colour,
       * its Latin name huge and faint BEHIND the photograph, the
       * specification line, the Arabic title, and two buttons. Then
       * «اختار عالمك» under it, and pressing a circle changes the page's
       * colours smoothly.
       *
       * ── WITHOUT ONE BYTE OF JAVASCRIPT ──
       *
       * The D7 budget says «no client JS for blocks that don't need
       * this», and a colour switch does not need it: the stages are
       * stacked, a hidden radio per stage says which one is showing, and
       * `:has(#…:checked)` picks it. So it works on a phone with a dead
       * script, it is keyboard-operable because a radio and a label
       * already are, and it costs nothing to parse.
       *
       * ── THREE WORLDS, NOT FIVE ──
       *
       * Every stage that exists holds a photograph, and a hidden element
       * is still «in view» as far as a browser's lazy loading is
       * concerned — five stages is five images on the first screen of a
       * shop measured at Fast 3G. Three is what `productFirst` already
       * fetches there, and the rest of the series is the grid below.
       *
       * ── AND NO GHOST BEHIND A PRICE ──
       *
       * The owner's ruling of 15/10: decoration may sit at the door, on
       * an empty state, on a section heading or a welcome card — never
       * behind a figure, a price or an amount. The faint word is INSIDE
       * the picture frame (`.sf-bw-stage > .sf-bw-art`) and the price
       * lives in `.sf-bw-say`, a different box, so there is no
       * arrangement of this markup in which one is behind the other.
       * `store-family-arrangement.test.ts` holds that down.
       * ═════════════════════════════════════════════════════════════════
       */
      case 'worldFirst': {
        // The same number the stylesheet writes rules for — one list, so a
        // fourth stage cannot appear with no rule to show it.
        const worlds = products.slice(0, WORLD_STAGES.length);
        if (worlds.length === 0) return null;
        return (
          <>
            {/*
              EACH RADIO IMMEDIATELY BEFORE THE STAGE IT SHOWS.

              Not all three first. The order is what lets the stylesheet
              say it ONCE — «.sf-bw-radio:checked + .sf-bw-stage» — instead
              of a rule per world: measured, three pairs of «:has()»
              selectors were 620 bytes of a family that has about a quarter
              of a kilobyte of budget left. A sibling combinator is also
              the oldest, widest-supported thing in this file.

              The miniature renders no radios at all — the gallery draws
              eleven previews on one screen and eleven groups with the same
              ids would fight each other — so it falls through to the rule
              that shows the first stage.
            */}
            {worlds.map((p, i) => {
              const world = worldOf({ id: p.id, attributes: p.attributes ?? null });
              const latin = latinWord(p.nameEn);
              return (
                <React.Fragment key={p.id}>
                {!mini && (
                  <input
                    type="radio"
                    name="sf-world"
                    id={`sf-w${i}`}
                    defaultChecked={i === 0}
                    className="sf-bw-radio"
                    aria-label={p.name}
                  />
                )}
                <span
                  className="sf-bw-stage"
                  data-w={i}
                  style={worldVars(world) as React.CSSProperties}
                >
                  <span className="sf-bw-art">
                    {/* The faint word belongs to the picture, never to the
                        price — see the ruling above. */}
                    {latin ? (
                      <span className="sf-bw-ghost" aria-hidden>
                        {latin}
                      </span>
                    ) : null}
                    <Thumb product={p} />
                  </span>
                  <span className="sf-bw-say">
                    <strong className="sf-bw-title">{p.name}</strong>
                    {tagline ? <em className="sf-bw-line">{tagline}</em> : null}
                    <span className="sf-hx-price">{price(p)}</span>
                    <Wrap
                      href={`/s/${slug}/p/${encodeURIComponent(p.handle)}`}
                      className="sf-bw-go"
                    >
                      اكتشف {p.name}
                    </Wrap>
                    <Wrap href={`/s/${slug}/shop`} className="lp-cta sf-bw-all">
                      شوف السلسلة كاملة
                    </Wrap>
                  </span>
                </span>
                </React.Fragment>
              );
            })}

            <span className="sf-bw-pick" role="group" aria-label="اختار عالمك">
              <em className="sf-bw-pick-say">اختار عالمك</em>
              {worlds.map((p, i) => {
                const world = worldOf({ id: p.id, attributes: p.attributes ?? null });
                return mini ? (
                  <span key={`d${p.id}`} className="sf-bw-dot" data-w={i} style={worldVars(world) as React.CSSProperties}>
                    <Thumb product={p} />
                  </span>
                ) : (
                  <label
                    key={`d${p.id}`}
                    className="sf-bw-dot"
                    data-w={i}
                    htmlFor={`sf-w${i}`}
                    style={worldVars(world) as React.CSSProperties}
                  >
                    <Thumb product={p} />
                    <span className="sf-hx-name">{p.name}</span>
                  </label>
                );
              })}
            </span>
          </>
        );
      }
    }
  })();

  /*
   * NOTHING TO SHOW IS NOTHING DRAWN.
   *
   * Four of the five are made of the shelf, and a shop with an empty
   * shelf would otherwise render an empty box above the «لا منتجات
   * معروضة» line. `editorial` always has something, because its content
   * is the shop's own words with a fallback.
   */
  if (!body || (Array.isArray(body) && body.length === 0)) return null;

  return (
    <section className="sf-hx" data-hero-slot={variant} data-mini={mini ? '1' : undefined}>
      {body}
    </section>
  );
}
