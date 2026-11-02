/**
 * THE BUILT-IN APPS.
 *
 * These are the integrations this system already knows how to speak to. They
 * live in code, not in a table, because what the code supports IS the code —
 * a catalogue row saying "LogesTechs is available" could be wrong the moment
 * the adapter is renamed, and nobody would notice until a parcel failed.
 *
 * Installing one of these does not create a second settings screen. Each
 * already has one, built and tested; the store records that it is installed,
 * says whether it is configured, and sends you to the screen that configures
 * it. Copying those four forms into an "app settings" pane would be four
 * more places for a credential to be entered into the wrong field.
 *
 * `configured` is deliberately a live check rather than a stored flag: a
 * courier whose credentials were cleared is not configured any more, and a
 * flag would keep saying it was.
 */

import type { PrismaClient } from '@prisma/client';

export type AppCategory = 'SHIPPING' | 'MARKETING' | 'MESSAGING' | 'ANALYTICS';

export interface BuiltInApp {
  code: string;
  name: string;
  summary: string;
  /** What it actually does here, in the seller's words. */
  description: string;
  category: AppCategory;
  /** The screen that configures it. */
  settingsPath: string;
  /** Permission a user needs to install or configure it. */
  permission: string;
  /** Is it set up on this company right now? */
  configured: (ctx: { companyId: string }) => Promise<boolean>;
}

export const APP_CATEGORY_AR: Record<AppCategory, string> = {
  SHIPPING: 'الشحن',
  MARKETING: 'التسويق',
  MESSAGING: 'المراسلة',
  ANALYTICS: 'التحليلات',
};

/**
 * The catalogue.
 *
 * `configured` runs a query, so it takes the db it is given rather than
 * importing one — that keeps this file testable without a database and
 * keeps the registry free of a connection it does not own.
 */
export type RegistryDb = Pick<
  PrismaClient,
  'deliveryProvider' | 'trackingPixel' | 'whatsAppConnection' | 'telegramSource'
>;

export function builtInApps(db: RegistryDb): BuiltInApp[] {
  return [
    {
      code: 'LOGESTECHS',
      name: 'LogesTechs',
      summary: 'شحن آلي وتتبّع حالات',
      description:
        'يُنشئ الشحنة عند شركة الشحن ويجلب حالتها تلقائياً، فلا تُدخل بوليصة بيدك ولا تسأل عن طلب. يحتاج حساب الشركة لديهم.',
      category: 'SHIPPING',
      settingsPath: '/settings/couriers',
      permission: 'settings.manage',
      configured: async ({ companyId }) =>
        (await db.deliveryProvider.count({
          where: { companyId, apiEnabled: true, apiCredentials: { not: null } },
        })) > 0,
    },
    {
      code: 'META_PIXEL',
      name: 'Meta Pixel',
      summary: 'تتبّع تحويلات فيسبوك وإنستغرام',
      description:
        'يرسل أحداث المشاهدة وبدء الطلب والشراء إلى فيسبوك بالقيم التي يؤكّدها الخادم — لا بالقيم التي يقولها المتصفّح.',
      category: 'MARKETING',
      settingsPath: '/settings/tracking',
      permission: 'settings.manage',
      configured: async ({ companyId }) =>
        (await db.trackingPixel.count({ where: { companyId, platform: 'META', enabled: true } })) > 0,
    },
    {
      code: 'TIKTOK_PIXEL',
      name: 'TikTok Pixel',
      summary: 'تتبّع تحويلات تيك توك',
      description: 'نفس أحداث فيسبوك، إلى تيك توك، من نفس المصدر الموثوق.',
      category: 'MARKETING',
      settingsPath: '/settings/tracking',
      permission: 'settings.manage',
      configured: async ({ companyId }) =>
        (await db.trackingPixel.count({ where: { companyId, platform: 'TIKTOK', enabled: true } })) > 0,
    },
    {
      code: 'SNAPCHAT_PIXEL',
      name: 'Snapchat Pixel',
      summary: 'تتبّع تحويلات سناب شات',
      description: 'نفس الأحداث، إلى سناب شات.',
      category: 'MARKETING',
      settingsPath: '/settings/tracking',
      permission: 'settings.manage',
      configured: async ({ companyId }) =>
        (await db.trackingPixel.count({ where: { companyId, platform: 'SNAPCHAT', enabled: true } })) > 0,
    },
    {
      code: 'GOOGLE_TAG',
      name: 'Google Tag',
      summary: 'Google Analytics و Google Ads',
      description: 'نفس الأحداث — المشاهدة وبدء الطلب والشراء — إلى Google Analytics أو إعلانات Google.',
      category: 'MARKETING',
      settingsPath: '/settings/tracking',
      permission: 'settings.manage',
      configured: async ({ companyId }) =>
        (await db.trackingPixel.count({ where: { companyId, platform: 'GOOGLE', enabled: true } })) > 0,
    },
    {
      code: 'WHATSAPP',
      name: 'واتساب للأعمال',
      summary: 'صندوق وارد مشترك عبر Meta Cloud API',
      description:
        'رقم واحد للشركة يتشاركه الموظفون، عبر واجهة ميتا الرسمية وحدها — لا جسور غير رسمية تُغلق حسابك.',
      category: 'MESSAGING',
      settingsPath: '/settings/links',
      permission: 'whatsapp.manage',
      configured: async ({ companyId }) =>
        (await db.whatsAppConnection.count({ where: { companyId } })) > 0,
    },
    {
      code: 'TELEGRAM',
      name: 'تلجرام',
      summary: 'استقبال الطلبات من مجموعات تلجرام',
      description: 'يقرأ الرسائل من المصادر التي تحدّدها ويحوّلها إلى طلبات في نفس نظام الطلبات.',
      category: 'MESSAGING',
      settingsPath: '/settings/links',
      permission: 'telegram.connect',
      configured: async ({ companyId }) =>
        (await db.telegramSource.count({ where: { companyId, isActive: true } })) > 0,
    },
  ];
}
