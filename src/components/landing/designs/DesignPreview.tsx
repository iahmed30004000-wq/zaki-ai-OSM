import React from 'react';
import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { activeOffersFor } from '@/lib/offers';
import { buildTemplate } from '@/lib/page-templates';
import { ensureSellingCore } from '@/lib/landing-sections';
import { trustRow } from '@/lib/selling-blocks';
import { paletteFor } from '@/lib/landing-theme';
import { designFontHref, designRootVars, loadDesign } from '@/lib/landing-designs/load';
import { PageBlocks } from '@/components/landing/blocks/PageBlocks';
import { FormPlaceholder } from '@/components/landing/blocks/FormPlaceholder';
import { BLOCK_CSS_WITH_DEV_FONTS } from '@/components/landing/blocks/styles';
import { designCss } from './design-css';
import { DesignNavbar } from './DesignedBlocks';
import { DesignMotion } from './DesignMotion';

/**
 * ONE DESIGN, OVER THE SELLER'S OWN PRODUCT, WITH OUR DEFAULT BLOCKS.
 *
 * The page a new seller would get from «الصفحة الكاملة» (`buildTemplate
 * ('classic')`), its hero filled with the product's name and picture, drawn
 * in the design — so what the library shows is what «استخدم هالتصميم» gives.
 *
 * Who may look: the same people who may preview a landing page in the editor
 * (`landing_pages.view`, inside their company and store). Anybody else gets
 * «not found», not «forbidden»: the address says nothing to a stranger.
 */
export async function DesignPreview({ design, productId }: { design: string; productId: string | null }) {
  let ctx: Awaited<ReturnType<typeof requireContext>>;
  try {
    ctx = await requireContext();
    await requirePermission('landing_pages.view');
  } catch {
    notFound();
  }
  const skin = await loadDesign(design);
  if (!skin) notFound();

  const { companyId, storeId, country } = ctx;
  const product = productId
    ? await db.product.findFirst({
        where: { id: productId, companyId },
        select: { id: true, name: true, basePrice: true, image: true },
      })
    : null;
  // A product that is not this company's is no product at all — never a peek at somebody else's.
  if (productId && !product) notFound();
  const minorUnit = country.minorUnit ?? 2;
  const offers = product ? await activeOffersFor(db, companyId, product.id, minorUnit).catch(() => []) : [];
  const store = await db.store.findFirst({
    where: { id: storeId, companyId },
    select: { name: true, logo: true, supportPhone: true },
  });

  const { sections: seed } = buildTemplate('classic');
  const sections = ensureSellingCore(
    seed.map((s) => (s.type === 'hero' ? { ...s, headline: product?.name ?? '', image: product?.image ?? '' } : s))
  );
  const productName = product?.name || 'اسم المنتج';
  const fontHref = designFontHref(skin);

  return (
    <div className="lp-root" dir="rtl" lang="ar">
      {fontHref && <link rel="stylesheet" href={fontHref} />}
      <style dangerouslySetInnerHTML={{ __html: BLOCK_CSS_WITH_DEV_FONTS }} />
      <style dangerouslySetInnerHTML={{ __html: designCss(skin) }} />
      <div data-design={skin.id} dir="rtl" style={designRootVars(skin) as React.CSSProperties}>
        <DesignNavbar productName={productName} skin={skin} />
        <PageBlocks
          sections={sections}
          ctx={{
            palette: paletteFor({ accent: skin.vars.primary }),
            productName,
            price: product?.basePrice ?? 0,
            currency: country.currencyCode,
            minorUnit,
            stock: null,
            offers,
            // A preview never takes an order.
            form: <FormPlaceholder />,
            trust: trustRow(),
            placeholders: true,
            store: store ? { name: store.name, logo: store.logo, phone: store.supportPhone } : null,
            design: skin,
          }}
        />
        <DesignMotion reveal={skin.reveal} animated={skin.animated} />
      </div>
    </div>
  );
}
