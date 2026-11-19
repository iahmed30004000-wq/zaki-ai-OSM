/**
 * THIS ROUTE'S OWN COLOURS, AND NOTHING ELSE'S.
 *
 * `/verify/[id]` is reached with no session and no company context in the
 * browser, so it cannot sit under `(system)/layout.tsx` (its `system.css`
 * is the DASHBOARD's look — "its colours are --sys-*, and a store's are
 * --store-*, and neither family may appear in the other's files",
 * `theme-isolation.test.ts`). This page is neither: it is not a shop with a
 * seller's own colours, and it must not change because a logged-in staff
 * member picked a dark theme for their own dashboard.
 *
 * So it gets a fixed palette of its own. It reuses the `--sys-*` NAMES only
 * because the shared scanner (`src/components/scan/ScanButton.tsx`, used
 * across the warehouse screens) and `Modal` read those names — reusing the
 * component, not the dashboard's theme. The VALUES below are this page's
 * own, chosen once, and do not move when `system.css` does.
 *
 * Written as an inline `<style>` and not an imported stylesheet on purpose:
 * an imported `.css` becomes its own chunk under `.next/static` and is
 * counted by `quality-gates.test.ts`'s first-load stylesheet budget —
 * a global ceiling, not a per-route one — for every visitor of every page,
 * not only this one's. Sixteen custom properties cost nothing worth a
 * chunk; inlined here, they travel only with this page's own HTML.
 */
const VARS = `:root{
  --sys-background:#ffffff;--sys-card:#ffffff;--sys-surface:#f8fafc;
  --sys-border:#e2e8f0;--sys-border-input:#cbd5e1;--sys-destructive-border:#fecaca;
  --sys-foreground:#0f172a;--sys-heading:#0f172a;--sys-muted:#64748b;--sys-muted-foreground:#64748b;
  --sys-primary:#2563eb;--sys-primary-foreground:#ffffff;
  --sys-success:#16a34a;--sys-success-soft:#dcfce7;
  --sys-destructive:#dc2626;--sys-destructive-soft:#fee2e2;
}`;

export default function VerifyLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style>{VARS}</style>
      {children}
    </>
  );
}
