import type { Metadata, Viewport } from 'next';
import { SystemFrame } from './SystemFrame';
import { getCurrentUser } from '@/lib/auth';
import { AuthBackendDown } from '@/lib/auth-errors';
import { openingTheme, themeByKey } from '@/lib/system-themes';
import { cookies } from 'next/headers';
import { RAIL_COOKIE } from '@/lib/sidebar-rail';
import { DECOR_COOKIE } from '@/lib/theme-decoration';
import { AppProvider } from '@/context/AppContext';
import { GlobalTrackingProvider } from '@/components/tracking/GlobalTrackingProvider';
import { PreviewBanner } from '@/components/shell/PreviewAs';

export const metadata: Metadata = {
  title: 'Zaki AI OMS — نظام المبيعات والطلبات والأرباح الذكي',
  description:
    'Zaki AI OMS — منصة متكاملة لإدارة المنتجات والطلبات والمودريتورات والأرباح الحقيقية مع مستشار أعمال بالذكاء الاصطناعي.',
  icons: {
    // The FLAT mark, because a favicon is 16px and the low-poly one is
    // mud at that size — the brief's own reason for making it.
    icon: '/brand/mark-flat.svg',
    apple: '/icons/icon-192.png',
  },
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'Zaki AI OMS' },
};

/**
 * `viewport-fit=cover` is what lets a notched phone hand us its safe-area
 * insets. Without it the bottom bar sits under the home indicator and its
 * tabs close the app instead of opening a screen.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

/**
 * THE SYSTEM — the dashboard, the entry picker and the sign-in screens.
 *
 * Its look (system.css, its fonts, its title and icon) lives here and only
 * here, so none of it reaches a public page.
 */
export default async function SystemLayout({ children }: { children: React.ReactNode }) {
  /*
   * A DATABASE THAT DID NOT ANSWER (the owner's ruling 4/11): drawn as nobody HERE, for the frame and its theme only.
   * The page's own guard (page-guard.ts) meets the same error a moment later and throws it to `(system)/error.tsx`,
   * whose retry is the answer — that boundary cannot catch this layout, so this layout must not be what throws.
   */
  const user = await getCurrentUser().catch((error: unknown) => {
    if (error instanceof AuthBackendDown) return null;
    throw error;
  });
  /**
   * Was the sidebar left folded? A cookie, read here, so the attribute is
   * in the HTML the browser parses — no script, no flash, and no «Scripts
   * inside React components are never executed» in the console on every
   * page load. See src/lib/sidebar-rail.ts.
   */
  const jar = await cookies();
  const railed = jar.get(RAIL_COOKIE)?.value === '1';
  /*
   * How much of the theme's own mood this browser wants — off, light or
   * full. A cookie and not a column: it belongs to a screen rather than
   * to an account (the same person on a phone in the sun and on a desk at
   * night does not want the same answer), and it costs no migration.
   */
  const decor = jar.get(DECOR_COOKIE)?.value;

  return (
    <SystemFrame theme={openingTheme(user?.systemTheme, user?.roleTheme)} railed={railed} decor={decor}>
      {/* The status bar takes the colour of the theme this person chose, so
          an installed app does not wear the default's colour above a dark
          screen. */}
      <meta name="theme-color" content={themeByKey(openingTheme(user?.systemTheme, user?.roleTheme)).vars.sidebar} />

      <AppProvider initialUser={user}>
        {/* The engine starts empty. Pixels are registered by the selling
            page that renders — a landing page or a storefront page — with
            the pixels of the company that owns THAT page. The dashboard
            registers none. */}
        <GlobalTrackingProvider pixels={[]}>{children}</GlobalTrackingProvider>
        {/* «عاين كـ» (src/lib/preview-mode.ts): on every page while the owner previews somebody — who, read-only, and
            the way back. Drawn from the session, so it cannot be on without the server having said so. */}
        {user?.preview && <PreviewBanner name={user.name} roleName={user.preview.roleName} />}
        {user?.previewEnded && <PreviewBanner name={user.name} roleName="" ended />}
      </AppProvider>
    </SystemFrame>
  );
}
