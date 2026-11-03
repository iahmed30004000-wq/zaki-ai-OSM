import React from 'react';
import { ShoppingCart } from 'lucide-react';
import { COD_LINE, type LandingSection } from '@/lib/landing-sections';
import { lowStock, offersCountAr, trustRow } from '@/lib/selling-blocks';
import { sanitizeRich, isRich } from '@/lib/rich-text';
import { moneyText } from '@/lib/money';
import type { DecoNode, DesignRole, DesignSection, DesignSkin, DesignStyle, DesignWidget } from '@/lib/landing-designs/skin';
import { OrderCta } from '../blocks/OrderCta';
import { heroPrice } from '../blocks/hero-price';
import type { BlockContext } from '../blocks/PageBlocks';

/**
 * OUR BLOCKS, WEARING ONE OF THE SIXTY-FOUR DESIGNS.
 *
 * «اسحب حتى القوالب كل اشي بشكل حرفي» — and our parts stay ours. A design is
 * a set of section TEMPLATES (`DesignSkin.sections`): the exact elements,
 * classes and inline styles their builder wrote, with no words in them. Each
 * of our blocks is drawn into the template whose job matches it, and the
 * words are the block's:
 *
 *   | ours                     | theirs                                   |
 *   |--------------------------|------------------------------------------|
 *   | announcement             | the strip above the hero (or the banner) |
 *   | hero                     | the hero (badge, name, line, price, CTA) |
 *   | trust                    | the trust row                            |
 *   | benefits                 | «ليش رح تحبه» (or the photo rows)        |
 *   | text                     | the statement / «ليش تختار…» checklist   |
 *   | timeline · mechanism     | «كيف تطلب» numbered steps                |
 *   | faq · objections         | the accordion                            |
 *   | urgency                  | the final banner                         |
 *   | form                     | the banner, then OUR form in their order section |
 *   | footer                   | their footer band, our footer inside     |
 *   | everything else          | their section frame and heading, our block inside |
 *
 * The order form, the offers, the upsell, the pixels and every guard are not
 * here at all: the form block draws `ctx.form`, which is the same element the
 * page has without a design.
 *
 * A server component, and it adds no script: the accordion is `<details>`,
 * the buttons are `OrderCta` (already on every page).
 */

/** Which of their sections each of our blocks is drawn in, decided once per design. */
export interface DesignPlan {
  skin: DesignSkin;
  first: Partial<Record<DesignRole, DesignSection>>;
  zig: DesignSection[];
  /** Their frame for a block of ours that has no section of its own there. */
  frame: DesignSection | null;
  /** The page's own product picture, for the sections of theirs that repeat it (the photo rows). */
  heroImage?: string;
  /** The kit sections an animated design carries, by kind (`cascade`, `road`, `facts`…). */
  kits: Record<string, DesignSection>;
  /**
   * The words the animated designs' marquee runs: the page's own benefit
   * titles, or — with none — the trust row's facts. Never theirs.
   */
  marquee: string[];
}

export function planDesign(
  skin: DesignSkin,
  sections: readonly LandingSection[] = [],
  trust: { title: string }[] = trustRow()
): DesignPlan {
  const first: DesignPlan['first'] = {};
  for (const s of skin.sections) if (!first[s.role]) first[s.role] = s;
  const zig = skin.sections.filter((s) => s.role === 'zig');
  const kits: DesignPlan['kits'] = {};
  for (const s of skin.sections) {
    if (s.role !== 'kit') continue;
    const kind = kitOf(s)?.kind;
    if (kind && !kits[kind]) kits[kind] = s;
  }
  const frame = first.features ?? first.why ?? first.steps ?? first.faq ?? first.statement ?? null;
  const hero = sections.find((s) => s.type === 'hero');
  const heroImage = hero && hero.type === 'hero' && hero.image ? hero.image : undefined;
  const benefitTitles = sections
    .filter((s) => s.type === 'benefits' && s.enabled)
    .flatMap((s) => (s.type === 'benefits' ? s.items.map((i) => plainWords(i.title)) : []))
    .filter(Boolean);
  const marquee = benefitTitles.length ? benefitTitles : trust.map((f) => f.title).filter(Boolean);
  return { skin, first, zig, frame, heroImage, kits, marquee };
}

/** The kit a section carries, if it is one. */
function kitOf(s: DesignSection) {
  for (const r of s.rows)
    for (const c of r.cols)
      for (const w of c.widgets) {
        if (w.k !== 'html') continue;
        const k = w.parts.find((p) => p.m === 'kit');
        if (k && k.m === 'kit') return k;
      }
  return null;
}

/** A seller's title as plain words — a marquee is one running line, not markup. */
function plainWords(v: string): string {
  return isRich(v) ? sanitizeRich(v).replace(/<[^>]*>/g, '').trim() : v.trim();
}

type Words = string;

/** What one block hands its template. Every field optional: a widget with nothing to say is not drawn. */
interface Bag {
  kicker?: Words;
  headline?: Words;
  title?: Words;
  price?: React.ReactNode;
  text?: Words;
  /** Drawn after the text, inside the same widget — the offer line, a guarantee, a countdown. */
  extra?: React.ReactNode;
  image?: string;
  imageAlt?: string;
  lines?: Words[];
  items?: { icon?: string; title: Words; text?: Words; href?: string }[];
  faq?: { q: string; a: string }[];
  cta?: string;
  banner?: { title?: Words; text?: Words; body?: React.ReactNode; cta?: string };
  /** The animated designs' running line. */
  marquee?: string[];
  /** Their top bar: the product's name and our order button. */
  topbar?: { brand: string };
  /** One kit section of theirs, filled with one block's words. */
  kit?: { kind: string; title?: Words; text?: Words; items?: { title: Words; text?: Words }[]; lines?: Words[]; rings?: { icon: string; label: string }[] };
  /** `data-edit` paths, so the builder's typing-on-the-page reaches the right field. */
  edit?: Partial<Record<'headline' | 'title' | 'text' | 'cta' | 'kicker', string>>;
  placeholders?: boolean;
}

function rich(value: string | null | undefined) {
  const v = value ?? '';
  return isRich(v) ? { dangerouslySetInnerHTML: { __html: sanitizeRich(v) } } : { children: v };
}

const css = (s: DesignStyle | undefined) => s as React.CSSProperties | undefined;

function Deco({ node }: { node: DecoNode }) {
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node.a ?? {})) props[k] = v;
  return React.createElement(node.t, props, ...(node.c ?? []).map((c, i) => <Deco key={i} node={c} />));
}

function widget(w: DesignWidget, bag: Bag, used: Set<string>, key: number): React.ReactNode {
  const wrap = (children: React.ReactNode) => (
    <div key={key} className={w.cls} style={css(w.style)}>
      {children}
    </div>
  );
  switch (w.k) {
    case 'heading': {
      if (used.has(w.slot)) return null;
      const Tag = w.tag;
      if (w.slot === 'price') {
        if (!bag.price) return null;
        used.add('price');
        return wrap(<Tag className={w.hcls} style={css(w.hstyle)}>{bag.price}</Tag>);
      }
      // A section whose only heading is its h1 still takes the block's title there.
      const words = w.slot === 'headline' ? (bag.headline ?? bag.title) : bag[w.slot];
      if (!words) return null;
      used.add(w.slot);
      const edit = bag.edit?.[w.slot === 'headline' && !bag.headline ? 'title' : w.slot];
      return wrap(<Tag className={w.hcls} style={css(w.hstyle)} data-edit={edit} {...rich(words)} />);
    }
    case 'text': {
      if (used.has('text') || (!bag.text && !bag.extra)) return null;
      used.add('text');
      const t = bag.text ?? '';
      return wrap(
        <div className={w.tcls} style={css(w.tstyle)}>
          {t && (isRich(t) ? <div data-edit={bag.edit?.text} {...rich(t)} /> : <p data-edit={bag.edit?.text} style={{ whiteSpace: 'pre-line' }}>{t}</p>)}
          {bag.extra}
        </div>
      );
    }
    case 'button': {
      if (used.has('cta') || !bag.cta) return null;
      used.add('cta');
      return wrap(
        <div className={w.bcls}>
          <OrderCta className={w.acls} style={css(w.astyle)} data-edit={bag.edit?.cta}>
            {bag.cta}
          </OrderCta>
        </div>
      );
    }
    case 'image': {
      if (used.has('image')) return null;
      if (!bag.image) {
        if (!bag.placeholders) return null;
        used.add('image');
        return wrap(<div className="zd-frame">صورة المنتج</div>);
      }
      used.add('image');
      // The seller's own upload, as the plain block renderer draws it.
      // eslint-disable-next-line @next/next/no-img-element
      return wrap(<img src={bag.image} alt={bag.imageAlt ?? ''} style={css(w.istyle)} />);
    }
    case 'checklist': {
      if (used.has('lines') || !bag.lines?.length) return null;
      used.add('lines');
      return wrap(
        <ul style={css(w.ulStyle)}>
          {bag.lines.map((line, i) => (
            <li key={i} style={css(w.liStyle)}>
              <span style={css(w.markStyle)} aria-hidden>
                {w.mark}
              </span>
              <span {...rich(line)} />
            </li>
          ))}
        </ul>
      );
    }
    case 'features': {
      if (used.has('items') || !bag.items?.length) return null;
      used.add('items');
      return wrap(
        <div className={w.gcls} style={css(w.gstyle)}>
          {bag.items.map((it, i) => {
            const body = (
              <>
                <strong style={css(w.strong)} {...rich(it.title)} />
                {it.text && <span style={css(w.span)} {...rich(it.text)} />}
              </>
            );
            return (
              <div key={i} style={css(w.item)}>
                <div style={css(w.icon)} aria-hidden>
                  {w.numbered ? <span className="zd-step-n">{i + 1}</span> : (it.icon ?? '✓')}
                </div>
                <div>{it.href ? <a href={it.href} style={{ color: 'inherit' }}>{body}</a> : body}</div>
              </div>
            );
          })}
        </div>
      );
    }
    case 'faq': {
      if (used.has('faq') || !bag.faq?.length) return null;
      used.add('faq');
      return wrap(
        <div className="accordion">
          {bag.faq.map((f, i) => (
            <details key={i} className="zd-faq" style={css(w.item)}>
              <summary style={css(w.button)}>
                {f.q}
                <span className="zd-plus" style={css(w.plus)} aria-hidden>
                  {w.plusText}
                </span>
              </summary>
              <div style={{ ...css(w.answer), whiteSpace: 'pre-line' }}>{f.a}</div>
            </details>
          ))}
        </div>
      );
    }
    case 'cta': {
      const b = bag.banner;
      if (used.has('banner') || !b || (!b.title && !b.text && !b.body)) return null;
      used.add('banner');
      const H = (w.htag || 'h2') as 'h2';
      // Our product's picture where theirs was. Quotes, backslashes and line breaks out: it sits inside a CSS string.
      const photo = w.photo && bag.image ? { backgroundImage: `url("${bag.image.replace(/["\\\n\r]/g, '')}")` } : null;
      return wrap(
        <div className={w.boxCls} style={photo ? { ...css(w.box), ...photo } : css(w.box)}>
          <span aria-hidden style={css(w.overlay)} />
          <div style={css(w.inner)}>
            {b.title && <H style={css(w.h)} data-edit={bag.edit?.title} {...rich(b.title)} />}
            {b.text && <p style={css(w.p)} {...rich(b.text)} />}
            {b.body && <div style={css(w.p)}>{b.body}</div>}
            {b.cta && (
              <OrderCta className="zd-cta-a" style={css(w.a)}>
                {b.cta}
              </OrderCta>
            )}
          </div>
        </div>
      );
    }
    case 'html': {
      // Their decoration (effect layers, canvases, the motion kit's own hooks — no words: the generator kept no
      // text), and the parts of theirs that our words fill: the running line, the top bar, a kit section.
      const nodes = w.parts.map((p, i) => {
        if (p.m === 'deco') return <Deco key={i} node={p.node} />;
        if (p.m === 'marquee') {
          if (used.has('marquee') || !bag.marquee?.length) return null;
          used.add('marquee');
          const row = (hidden: boolean) => (
            <div className="mx-marquee-row" aria-hidden={hidden || undefined}>
              {bag.marquee!.map((t, n) => (
                <React.Fragment key={n}>
                  <span>{t}</span>
                  <i aria-hidden="true">{p.sep}</i>
                </React.Fragment>
              ))}
            </div>
          );
          return (
            <div key={i} className={p.cls} style={css(p.style)}>
              <div className="mx-marquee-track">
                {row(false)}
                {row(true)}
              </div>
            </div>
          );
        }
        if (p.m === 'topbar') {
          if (used.has('topbar') || !bag.topbar) return null;
          used.add('topbar');
          return (
            <nav key={i} className={p.cls} style={css(p.style)}>
              <span className="mx-topbar-brand">{bag.topbar.brand}</span>
              <OrderCta className="mx-topbar-cta">اطلب الآن</OrderCta>
            </nav>
          );
        }
        if (p.m === 'kit') {
          if (used.has('kit') || !bag.kit || bag.kit.kind !== p.kind) return null;
          const drawn = kit(p, bag.kit, bag.image);
          if (drawn) used.add('kit');
          return drawn ? <React.Fragment key={i}>{drawn}</React.Fragment> : null;
        }
        return null;
      });
      // Decoration alone is still drawn: the hero's effect layer sits beside words of ours in the same section, and
      // `Filled` drops a section whose only content is decoration.
      if (!nodes.some(Boolean)) return null;
      return wrap(nodes);
    }
  }
}

/**
 * THREE OF THEIR KIT SECTIONS, REDRAWN FROM THE KIT'S OWN CLASSES.
 *
 * The shape lives in the kit stylesheet (`IMX_KIT_CSS`) and the colours in the
 * root's variables, both theirs; the words are one block's. The ring labels are
 * the trust row's facts — never their «مفحوص قبل الشحن».
 */
function kit(p: { kind: string; cls: string; style: DesignStyle }, k: NonNullable<Bag['kit']>, image?: string): React.ReactNode {
  if (p.kind === 'cascade') {
    const items = k.items ?? [];
    if (!items.length) return null;
    return (
      <div className={p.cls} style={{ ...css(p.style), '--n': String(items.length) } as React.CSSProperties}>
        {k.title && (
          <div className="mx-rowhead">
            <h2 data-edit="title" {...rich(k.title)} />
          </div>
        )}
        <div className="mx-cascade-row">
          {items.map((it, i) => (
            <article
              key={i}
              className="mx-cascade-card mx-glow"
              style={{ '--i': String(i), '--d': String(i - (items.length - 1) / 2) } as React.CSSProperties}
            >
              <div className="mx-cascade-media">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {image && <img src={image} alt="" loading="lazy" />}
              </div>
              <span className="mx-cascade-icon" aria-hidden="true">
                ✓
              </span>
              <h3 {...rich(it.title)} />
              {it.text && <p {...rich(it.text)} />}
            </article>
          ))}
        </div>
      </div>
    );
  }
  if (p.kind === 'road') {
    const items = k.items ?? [];
    if (!items.length) return null;
    return (
      <div className={p.cls} style={css(p.style)}>
        {k.title && <h2 className="mx-road-title" data-edit="title" {...rich(k.title)} />}
        <ol className="mx-road-list">
          <i className="mx-road-line" aria-hidden="true">
            <b />
          </i>
          {items.map((it, i) => (
            <li key={i} className="mx-road-step">
              <span className="mx-road-node">{i + 1}</span>
              <div className="mx-road-card mx-glow">
                <h3 {...rich(it.title)} />
                {it.text && <p {...rich(it.text)} />}
              </div>
            </li>
          ))}
        </ol>
      </div>
    );
  }
  if (p.kind === 'facts') {
    if (!k.title && !k.text && !k.lines?.length) return null;
    return (
      <div className={p.cls} style={css(p.style)}>
        <div className="mx-facts-copy">
          {k.title && <h2 data-edit="title" {...rich(k.title)} />}
          {k.text && (isRich(k.text) ? <div data-edit="body" {...rich(k.text)} /> : <p data-edit="body" style={{ whiteSpace: 'pre-line' }}>{k.text}</p>)}
          {!!k.lines?.length && (
            <ul className="mx-checks">
              {k.lines.map((l, i) => (
                <li key={i} {...rich(l)} />
              ))}
            </ul>
          )}
        </div>
        {!!k.rings?.length && (
          <div className="mx-rings">
            {k.rings.map((r, i) => (
              <div key={i} className="mx-ring">
                <svg viewBox="0 0 100 100" aria-hidden="true">
                  <circle cx="50" cy="50" r="44" pathLength={1} />
                  <circle className="mx-ring-fill" cx="50" cy="50" r="44" pathLength={1} />
                </svg>
                <span className="mx-ring-icon" aria-hidden="true">
                  {r.icon}
                </span>
                <span className="mx-ring-label">{r.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
  // story, stack, coverflow, devices, tunnel, zoom, words… — no block of ours fills them yet (RV1004).
  return null;
}

function hasWidget(tpl: DesignSection, pred: (w: DesignWidget) => boolean): boolean {
  return tpl.rows.some((r) => r.cols.some((c) => c.widgets.some(pred)));
}

/** One of their sections, filled with one block's words. Null when nothing in it had anything to say. */
function Filled({ tpl, bag, id }: { tpl: DesignSection; bag: Bag; id?: string }) {
  const used = new Set<string>();
  const rows = tpl.rows
    .map((row, ri) => {
      const cols = row.cols
        .map((col) => ({ col, nodes: col.widgets.map((w, wi) => widget(w, bag, used, wi)).filter(Boolean) }))
        .filter((c) => c.nodes.length > 0);
      if (!cols.length) return null;
      // A row that lost its picture keeps its words at full width, not in half of it.
      const alone = cols.length === 1 && row.cols.length > 1;
      return (
        <div key={ri} className={row.cls}>
          {cols.map(({ col, nodes }, ci) => (
            <div key={ci} className={col.cls} style={alone ? ({ '--bpr-w': '100' } as React.CSSProperties) : undefined}>
              {nodes}
            </div>
          ))}
        </div>
      );
    })
    .filter(Boolean);
  // Only their decoration left: nothing of ours to show, so no section.
  if (!rows.length || !['headline', 'title', 'text', 'items', 'lines', 'faq', 'banner', 'cta', 'image', 'price', 'kicker', 'marquee', 'topbar', 'kit'].some((k) => used.has(k))) {
    return null;
  }
  return (
    <section className={tpl.cls} data-zd-role={tpl.role} id={id}>
      {tpl.container ? (
        <div className="container" style={css(tpl.container)}>
          {rows}
        </div>
      ) : (
        rows
      )}
    </section>
  );
}

/** Their frame and heading around a block of ours that has no section of its own in this design. */
function Framed({ plan, title, edit, children }: { plan: DesignPlan; title?: string; edit?: string; children: React.ReactNode }) {
  // Nothing of ours to frame: no section, not an empty band of their colour.
  if (children === null || children === undefined || children === false) return null;
  const tpl = plan.frame;
  const heading = tpl?.rows.flatMap((r) => r.cols.flatMap((c) => c.widgets)).find((w) => w.k === 'heading' && w.slot === 'title');
  const row = tpl?.rows[0];
  const col = row?.cols[0];
  const inner = (
    <div className={row?.cls ?? 'bpr-row'}>
      <div className={col?.cls ?? 'bpr-col'} style={{ '--bpr-w': '100' } as React.CSSProperties}>
        {title && heading && heading.k === 'heading' && (
          <div className={heading.cls} style={css(heading.style)}>
            <heading.tag className={heading.hcls} style={css(heading.hstyle)} data-edit={edit} {...rich(title)} />
          </div>
        )}
        <div className="bpr-widget zd-generic">{children}</div>
      </div>
    </div>
  );
  return (
    <section className={tpl?.cls ?? 'bpr-section'} data-zd-role="frame">
      <div className="container" style={css(tpl?.container ?? undefined)}>
        {inner}
      </div>
    </section>
  );
}

/** The price line of the first screen, from the one rule every hero uses. */
function heroBits(ctx: BlockContext) {
  const { selected, shown, was } = heroPrice(ctx.offers, ctx.price);
  const unit = ctx.minorUnit ?? 2;
  const price =
    shown > 0 ? (
      <span dir="ltr">
        {was !== null && was > shown && <s className="zd-was">{moneyText(was, ctx.currency, unit)}</s>}
        {moneyText(shown, ctx.currency, unit)}
      </span>
    ) : null;
  const offerLine =
    selected && ctx.offers.length > 0 ? (
      <OrderCta className="zd-offer-line">
        <b>{selected.name}</b>
        {selected.freeQuantity > 0 && <> +{selected.freeQuantity} مجاناً</>}
        {ctx.offers.length > 1 && <> · {offersCountAr(ctx.offers.length)} — اختر عرضك</>}
      </OrderCta>
    ) : null;
  return { price, offerLine };
}

const TRUST_ICON: Record<string, string> = { cod: '💵', delivery: '🚚', returns: '🛡️' };
const TYPED_ICONS = ['💵', '🚚', '🛡️'];

/** The facts the server resolved, or the seller's own words when they typed some — the plain trust row's rule. */
function trustItems(s: Extract<LandingSection, { type: 'trust' }>, ctx: BlockContext): NonNullable<Bag['items']> {
  const typed = s.items.filter((i) => i.title);
  if (typed.length) return typed.map((i, n) => ({ icon: TYPED_ICONS[n % TYPED_ICONS.length], title: i.title, text: i.text || undefined }));
  return (ctx.trust ?? trustRow()).map((f) => ({ icon: TRUST_ICON[f.key], title: f.title, text: f.text, href: f.href }));
}

/**
 * ONE BLOCK OF OURS, DRAWN IN THE DESIGN.
 *
 * `plain` is the block as the page draws it without a design — used for the
 * parts that have no section of theirs, inside `Framed`, and for the ones that
 * must stay exactly ours (the floating button, the builder's thank-you card).
 */
export function DesignedBlock({
  section: s,
  ctx,
  plan,
  plain,
}: {
  section: LandingSection;
  ctx: BlockContext;
  plan: DesignPlan;
  plain: (section: LandingSection) => React.ReactNode;
}) {
  const { first } = plan;
  const ph = ctx.placeholders;
  const framed = (title?: string) => (
    <Framed plan={plan} title={title} edit="title">
      {plain({ ...s, title: '' } as LandingSection)}
    </Framed>
  );

  switch (s.type) {
    case 'announcement': {
      if (!s.text) return <>{plain(s)}</>;
      if (first.announce) return <Filled tpl={first.announce} bag={{ text: s.text, edit: { text: 'text' } }} />;
      if (first.topbanner) return <Filled tpl={first.topbanner} bag={{ banner: { title: s.text }, image: plan.heroImage }} />;
      return <>{plain(s)}</>;
    }

    case 'hero': {
      const tpl = first.hero;
      if (!tpl) return <>{plain(s)}</>;
      const { price, offerLine } = heroBits(ctx);
      const headline = s.headline || ctx.productName;
      // «النواة المقفولة»: the price with the offer, the order button and the
      // COD line. The COD line takes their badge's place; a hero with no badge
      // carries it as the first of its checks, or under its line.
      const hasKicker = hasWidget(tpl, (w) => w.k === 'heading' && w.slot === 'kicker');
      const hasChecks = hasWidget(tpl, (w) => w.k === 'checklist');
      const facts = (ctx.trust ?? trustRow()).filter((f) => f.key !== 'cod').map((f) => f.title);
      const lines = hasKicker ? facts : [COD_LINE, ...facts];
      const codUnder = !hasKicker && !hasChecks;
      const image = s.image || undefined;
      const heroHasImage = hasWidget(tpl, (w) => w.k === 'image');
      const bag: Bag = {
        kicker: hasKicker ? COD_LINE : undefined,
        headline,
        text: s.subheadline || undefined,
        extra:
          offerLine || codUnder ? (
            <>
              {offerLine}
              {codUnder && <p className="zd-cod">{COD_LINE}</p>}
            </>
          ) : undefined,
        price: s.showPrice ? price : null,
        cta: s.ctaText || 'اطلب الآن',
        image,
        imageAlt: headline,
        lines,
        placeholders: ph,
        edit: { headline: 'headline', text: 'subheadline', cta: 'ctaText' },
      };
      const after = !heroHasImage && first.image && (image || ph) ? (
        <Filled tpl={first.image} bag={{ image, imageAlt: headline, placeholders: ph }} />
      ) : null;
      // The animated designs' running line comes right after the first screen, as on their page, with our words.
      const marquee = first.marquee ? <Filled tpl={first.marquee} bag={{ marquee: plan.marquee }} /> : null;
      return (
        <>
          <Filled tpl={tpl} bag={bag} />
          {after}
          {marquee}
        </>
      );
    }

    case 'trust': {
      const items = trustItems(s, ctx);
      const tpl = first.trust ?? first.features;
      return tpl ? <Filled tpl={tpl} bag={{ items }} /> : <>{plain(s)}</>;
    }

    case 'benefits': {
      const items = s.items.filter((i) => i.title || i.text).map((i) => ({ title: i.title, text: i.text || undefined }));
      if (!items.length) return <>{plain(s)}</>;
      if (first.features) return <Filled tpl={first.features} bag={{ title: s.title || undefined, items, edit: { title: 'title' } }} />;
      if (plan.kits.cascade) {
        return <Filled tpl={plan.kits.cascade} bag={{ kit: { kind: 'cascade', title: s.title || undefined, items }, image: plan.heroImage }} />;
      }
      if (plan.zig.length) {
        // Their photo rows: one benefit per row, the product's own picture beside it.
        const image = plan.heroImage;
        return (
          <>
            {items.map((it, i) => (
              <Filled key={i} tpl={plan.zig[i % plan.zig.length]} bag={{ title: it.title, text: it.text, image, placeholders: ph }} />
            ))}
          </>
        );
      }
      const tpl = first.why;
      if (tpl) return <Filled tpl={tpl} bag={{ title: s.title || undefined, lines: items.map((i) => i.title || i.text || '') }} />;
      return framed(s.title);
    }

    case 'text': {
      const tpl = first.statement ?? first.why;
      if (tpl && s.body) return <Filled tpl={tpl} bag={{ title: s.title || undefined, text: s.body, edit: { title: 'title', text: 'body' } }} />;
      if (plan.kits.facts && s.body) {
        // Their rings carry the trust row's facts — what the server measured, never their «مفحوص».
        const rings = (ctx.trust ?? trustRow()).map((f) => ({ icon: TRUST_ICON[f.key], label: f.title }));
        return <Filled tpl={plan.kits.facts} bag={{ kit: { kind: 'facts', title: s.title || undefined, text: s.body, rings } }} />;
      }
      return framed(s.title);
    }

    case 'timeline':
    case 'mechanism': {
      const items =
        s.type === 'timeline'
          ? s.points.filter((p) => p.when.trim() || p.what.trim()).map((p) => ({ title: p.when, text: p.what || undefined }))
          : s.steps.filter((x) => x.title.trim() || x.text.trim()).map((x) => ({ title: x.title, text: x.text || undefined }));
      // The ingredients list stays ours: their steps have no place for it.
      if (!items.length || (s.type === 'mechanism' && s.ingredients.some((x) => x.name.trim()))) return framed(s.title);
      if (first.steps) return <Filled tpl={first.steps} bag={{ title: s.title || undefined, items, edit: { title: 'title' } }} />;
      if (plan.kits.road) return <Filled tpl={plan.kits.road} bag={{ kit: { kind: 'road', title: s.title || undefined, items } }} />;
      if (first.features) return <Filled tpl={first.features} bag={{ title: s.title || undefined, items, edit: { title: 'title' } }} />;
      return framed(s.title);
    }

    case 'faq':
    case 'objections': {
      const faq =
        s.type === 'faq'
          ? s.items.filter((i) => i.q.trim()).map((i) => ({ q: i.q, a: i.a }))
          : s.items.filter((i) => i.doubt.trim()).map((i) => ({ q: i.doubt, a: i.answer }));
      const tpl = first.faq;
      if (!tpl || !faq.length) return framed(s.title);
      const guarantee = s.type === 'objections' && s.guarantee.trim() ? s.guarantee : null;
      return (
        <>
          <Filled tpl={tpl} bag={{ title: s.title || undefined, faq, edit: { title: 'title' } }} />
          {guarantee && (
            <Framed plan={plan}>
              <p className="lp-guarantee" {...rich(guarantee)} />
            </Framed>
          )}
        </>
      );
    }

    case 'urgency': {
      const tpl = first.cta;
      if (!tpl) return <>{plain(s)}</>;
      // The plain block's own rule for «nothing to say», so a banner never stands empty: no sentence, no clock, and no
      // stock low enough to mention (`lowStock`) is no block at all.
      const clock = s.countdown === 'offer' ? Boolean(ctx.offerEndsAt) : s.minutes > 0;
      const low = s.showRealStock ? lowStock(ctx.stock) : null;
      if (!s.text && !clock && low === null) return null;
      // The banner carries the block's own sentence; the clock and the stock line are the plain block's, unchanged.
      const inner = clock || low !== null ? plain({ ...s, text: '' }) : null;
      return <Filled tpl={tpl} bag={{ banner: { title: s.text || undefined, body: inner, cta: 'اطلب الآن' } }} />;
    }

    case 'form': {
      // THE FORM IS OURS. Their banner says the block's words above it, and
      // their order section is only the backdrop: `ctx.form` is the very
      // element a page with no design draws, offers, upsell and guards inside.
      const tpl = first.cta;
      const banner =
        tpl && (s.title || s.subtitle) ? <Filled tpl={tpl} bag={{ banner: { title: s.title || undefined, text: s.subtitle || undefined } }} /> : null;
      return (
        <>
          {banner}
          <section
            className="zd-order-section"
            style={plan.skin.orderBg ? { background: plan.skin.orderBg } : undefined}
          >
            <div className="container">
              {!banner && s.title && <h2 className="lp-h2" data-edit="title" {...rich(s.title)} />}
              {!banner && s.subtitle && <p className="lp-sub" data-edit="subtitle" {...rich(s.subtitle)} />}
              {ctx.form}
            </div>
          </section>
        </>
      );
    }

    case 'footer':
      return (
        <footer className="zd-footer">
          <div className="container">{plain(s)}</div>
        </footer>
      );

    case 'sticky':
    case 'thankyou':
      return <>{plain(s)}</>;

    default:
      return framed('title' in s ? (s.title as string) : undefined);
  }
}

/**
 * THEIR TOP BAR: the product's name and the order button.
 *
 * Drawn only on a page that is its own advert — a shop's front already has
 * the shop's header, and two bars is the duplication the shop chrome exists
 * to avoid.
 */
export function DesignNavbar({ productName, skin }: { productName: string; skin?: DesignSkin | null }) {
  const bar = skin?.sections.find((s) => s.role === 'topbar');
  if (bar) return <Filled tpl={bar} bag={{ topbar: { brand: productName } }} />;
  return (
    <nav className="zd-navbar">
      <div className="container">
        <span className="zd-brand-name">{productName}</span>
        <OrderCta className="zd-btn-brand">
          <ShoppingCart size={15} aria-hidden style={{ marginInlineEnd: 6, verticalAlign: '-2px' }} />
          اطلب الآن
        </OrderCta>
      </div>
    </nav>
  );
}

