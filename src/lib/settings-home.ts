/**
 * THE CARDS BEHIND ONE MENU LINE.
 *
 * Twelve settings screens stood as twelve entries in the sidebar. They are
 * one line now (`NavGroup.hub: 'cards'`), and this is what that line opens:
 * eight cards, each saying in a sentence what it holds and linking to the
 * screens that belong to it. The sentences are the guide's own words, so the
 * door and the screen behind it cannot describe the same thing two ways.
 *
 * Nothing here decides who may open what. The page draws a link only for a
 * screen the person may open (the same `useMayOpen` the strip above every
 * screen asks), and a card left with no link is not drawn at all. The server
 * guards each screen on its own permission, exactly as before — this is a
 * list of doors, not a lock.
 *
 * Every path must be a screen of «الإدارة» in the registry (or «العمولات»,
 * whose address is under /settings although its line is «المال»), and every
 * screen of «الإدارة» must be on exactly one card: a screen left off this page
 * is one nobody can find, since the sidebar no longer lists it.
 * `the-menu-is-one-line-a-group.test.ts` holds both directions.
 *
 * TEN SINCE 18/11: «الإعدادات» «الرقابة» «الإدارة» became one line, «الإدارة»,
 * and this page is its door — the eight settings cards, then the staff and the
 * control screens (8 + 2 = 10). The door's own permissions are still the union
 * of the EIGHT settings cards; the last two are drawn for whoever may open a
 * screen on them, like every card.
 *
 * ELEVEN SINCE 19/11 (R15a): «قواعد الموظفين» joined, right before the staff
 * card — a settings screen on `settings.view`, a key the door already holds,
 * so the door's union is the same six keys (9 settings + 2 admin = 11).
 *
 * TWELVE SINCE 25/11: «الأصالة والباركود» — «رموز الأصالة» and «باركود المنتجات», two pages on `settings.view`,
 * right after «النظام» where the codes card used to be (10 settings + 2 admin = 12).
 */

export interface SettingsCard {
  key: string;
  title: string;
  /** One sentence: what is decided here. */
  why: string;
  /** Registry paths, in the order they read. */
  paths: readonly string[];
}

export const SETTINGS_CARDS: readonly SettingsCard[] = [
  {
    key: 'geo',
    title: 'البلدان والمتاجر',
    why: 'أين تبيع: العملة والدوام والمحافظات لكل بلد، والمتجر يرث منه.',
    paths: ['/settings/geo'],
  },
  {
    key: 'couriers',
    title: 'الشحن',
    why: 'من يشحن لك وكم يأخذ لكل محافظة، مع دخول كل شركة إلى نظامها.',
    paths: ['/settings/couriers'],
  },
  {
    key: 'commission',
    title: 'العمولات',
    why: 'قواعد العمولة بالشرائح، لكل دور أو لموظف بعينه.',
    paths: ['/settings/commission'],
  },
  {
    key: 'channels',
    title: 'القنوات والتتبّع',
    why: 'من أين تأتي الطلبات، وبكسل التتبّع والحملات، والحسابات الإعلانية.',
    paths: ['/settings/channels', '/settings/tracking'],
  },
  {
    key: 'chat',
    title: 'واتساب وتلجرام',
    why: 'حالة الربط وإعادة الاتصال. المحادثات نفسها في «الطلبات».',
    paths: ['/settings/links'],
  },
  {
    key: 'ai',
    title: 'الذكاء الاصطناعي',
    why: 'المزوّد والمفتاح، ونصوص كل مهمة، وقوالب رسائل الزبائن.',
    paths: ['/settings/ai'],
  },
  {
    key: 'apps',
    title: 'التطبيقات',
    why: 'ما يتكلّم معه النظام: تثبيته، وسجلّ ما أُرسل إليه.',
    paths: ['/apps/store', '/apps/installed'],
  },
  {
    key: 'system',
    title: 'النظام',
    // 19/11 (R15a): was «اسم الشركة، والمهام التي يشغّل النظام بها نفسه.» — «إعدادات النظام» keeps the name and the offer after the order now.
    why: 'اسم الشركة ومهلة العرض بعد الطلب، والمهام التي يشغّل النظام بها نفسه.',
    paths: ['/settings/system', '/admin/jobs'],
  },
  {
    // 25/11 (the owner): «رموز الأصالة» left «إعدادات النظام» for a page of its own, beside «باركود المنتجات».
    key: 'authenticity',
    title: 'الأصالة والباركود',
    why: 'رموز القطع اللي بتطلع «أصلي»، ولكل منتج باركود وصفحة تحقق بتصمّمها.',
    paths: ['/settings/authenticity', '/settings/product-barcodes'],
  },
  {
    // 19/11 (R15a): the score and the deductions, moved from «إعدادات النظام» to a page of their own beside the staff.
    key: 'staff-rules',
    title: 'قواعد الموظفين',
    why: 'بأي مقياس بينحكم على شغل الموظفين، وشو بينقترح خصم عليه.',
    paths: ['/admin/staff-rules'],
  },
  {
    key: 'staff',
    title: 'الموظفون والصلاحيات',
    why: 'من يشتغل معك، وما يفتحه كل دور وكل موظف.',
    paths: ['/admin/users', '/admin/permissions'],
  },
  {
    key: 'control',
    title: 'الرقابة',
    why: 'ما طُلب تعديله، وما أُعطي من خصم، وما خُصم من راتب، ومن فعل ماذا، ومن هو ممنوع.',
    paths: ['/control/change-requests', '/control/discount-alerts', '/control/penalties', '/control/audit', '/control/app-errors', '/control/blacklist'],
  },
];
