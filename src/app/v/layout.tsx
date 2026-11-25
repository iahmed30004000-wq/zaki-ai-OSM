/**
 * `/v/<slug>` — A PRODUCT'S OWN AUTHENTICITY PAGE («باركود المنتجات»), AND NOTHING ELSE'S LOOK.
 *
 * Like `/verify`, it is reached with no session, so it sits outside `(system)` and wears nothing of the dashboard.
 * Its rules travel with the view itself (`product-verify-style.ts`, all under `.vp`); this layout adds only the Cairo
 * face and the `--sys-*` NAMES the shared camera sheet (`ScanButton` → `Modal`) reads, so the sheet opens in the page's own
 * night palette here (25/11: the page went dark, like `/verify`). The values are this route's own and do not move when `system.css` does.
 *
 * An inline `<style>` and not an imported stylesheet, for the same reason as `/verify/layout.tsx`: an imported `.css`
 * is a chunk of its own counted by the first-load stylesheet budget for every visitor of every page.
 */
const STYLE = `
@font-face{font-family:'Cairo';font-style:normal;font-weight:400 900;font-display:swap;src:url(https://fonts.gstatic.com/s/cairo/v31/SLXVc1nY6HkvangtZmpQdkhzfH5lkSscQyyS4J0.woff2) format('woff2');unicode-range:U+0600-06FF,U+0750-077F,U+0870-08FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FEFC}
@font-face{font-family:'Cairo';font-style:normal;font-weight:400 900;font-display:swap;src:url(https://fonts.gstatic.com/s/cairo/v31/SLXVc1nY6HkvangtZmpQdkhzfH5lkSscRiyS.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2212,U+FEFF,U+FFFD}
:root{
  --sys-background:#060b16;--sys-card:#0d1727;--sys-surface:#0a1220;
  --sys-border:rgba(255,255,255,.12);--sys-border-input:rgba(255,255,255,.18);--sys-destructive-border:rgba(255,93,108,.4);
  --sys-foreground:#eef4ff;--sys-heading:#eef4ff;--sys-muted:#9fb0c8;--sys-muted-foreground:#9fb0c8;
  --sys-primary:#19e0cf;--sys-primary-foreground:#04101c;
  --sys-success:#19e0cf;--sys-success-soft:rgba(25,224,207,.15);
  --sys-destructive:#ff5d6c;--sys-destructive-soft:rgba(255,93,108,.15);
}
body{margin:0}
`;

export default function ProductVerifyLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style>{STYLE}</style>
      {children}
    </>
  );
}
