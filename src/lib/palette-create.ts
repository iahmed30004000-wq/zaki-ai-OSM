import type { SessionUser } from '@/types/auth';
import { CREATE_PARAM, type CreateKey, type CreateRow } from './create-intent';
import { canAccessRoute, findRoute, routeLabel, type PermissionCheck } from './route-registry';

/**
 * «+ أنشئ» — WHAT THE BOX IS TOLD IT MAY OFFER, ONE ROW PER FORM THAT ALREADY EXISTS.
 *
 * Ctrl+K could find a screen and run a few commands, and could create nothing: «طلب جديد» meant closing the box, finding the orders
 * screen, finding its button. Seven forms already exist and each has a button; this is the list of them, and nothing else is built.
 * No form is new, no door is new, no rule is new — the row goes to the screen the form lives on and the screen opens it
 * (`useCreateIntent`), so what the form does when it is saved is, byte for byte, what it did when the button opened it.
 *
 * IT LIVES HERE AND NOT IN THE BOX, for the box's own reason (see its header): a palette that carries the list and hides the rows an
 * account lacks has shipped the list to every account. `GET /api/palette` calls `creatablesFor` with the signed-in user and sends the
 * rows that survive; the box draws what arrives.
 *
 * A ROW SURVIVES IF AND ONLY IF BOTH ARE TRUE:
 *   1. the account may OPEN the screen the form lives on — the registry's own question, `canAccessRoute`, the one the menu and the
 *      page guard ask — because a row that ends in «لا تملك صلاحية لهذه الشاشة» is a promise the box broke;
 *   2. the account holds the permission the form's own BUTTON is behind. Where a screen shows its button to everyone who may open it
 *      (products, customers, campaigns) the key is the one the form's DOOR demands, so the box never offers what the door would
 *      refuse. `needs` is the button's gate and not a second rule: the server still decides, on save, exactly as before.
 *
 * An action here is a FORM, not a screen under a verb: its address is the host screen's own, with `?new=`, and the test beside this
 * file refuses any label that is a menu label.
 */
interface Creatable {
  key: CreateKey;
  label: string;
  /** Appended to the host screen's name. */
  note?: string;
  icon: string;
  /** Registry path of the screen the form lives on. */
  route: string;
  /** The permission the form's button — or, where the button is bare, its door — is behind. */
  needs: string;
  /** A second permission the same button is behind (RV98: the import dialog sends each row through the order door). */
  alsoNeeds?: string;
  /** What else somebody might type for it. The generic ones («أنشئ», «جديد») are added to every row below. */
  words: string[];
}

/** Typed on their own they list everything the account can create — «what can I make?» is the question behind them. */
const GENERIC_WORDS = ['أنشئ', 'انشئ', 'إنشاء', 'انشاء', 'جديد', 'جديدة', 'إضافة', 'اضافة', 'أضف', 'اضف'];

export const CREATABLES: readonly Creatable[] = [
  // The three on the orders screen are the three buttons in its header, under their own names.
  { key: 'order', label: 'إدخال طلب سريع', icon: 'ShoppingCart', route: '/orders', needs: 'orders.create', words: ['طلب', 'اوردر', 'أوردر'] },
  {
    key: 'ai-order',
    label: 'إدخال بالذكاء الاصطناعي',
    note: 'الصق رسالة الزبون',
    icon: 'Bot',
    route: '/orders',
    needs: 'orders.create',
    words: ['طلب', 'ذكاء', 'الذكاء الاصطناعي', 'لصق', 'رسالة', 'واتساب'],
  },
  {
    key: 'import-orders',
    label: 'استيراد طلبات',
    note: 'من ملف',
    icon: 'FileSpreadsheet',
    route: '/orders',
    needs: 'orders.import',
    alsoNeeds: 'orders.create',
    words: ['طلب', 'استورد', 'ملف', 'اكسل', 'إكسل', 'excel', 'csv', 'رفع'],
  },
  { key: 'product', label: 'إضافة منتج', icon: 'PackagePlus', route: '/products', needs: 'products.create', words: ['منتج', 'صنف', 'بضاعة', 'سلعة'] },
  { key: 'customer', label: 'إضافة عميل', icon: 'Users', route: '/customers', needs: 'customers.create', words: ['عميل', 'زبون', 'عملاء'] },
  { key: 'user', label: 'موظف جديد', icon: 'UserCog', route: '/admin/users', needs: 'users.create', words: ['موظف', 'مستخدم', 'حساب', 'فريق'] },
  { key: 'campaign', label: 'حملة جديدة', icon: 'Megaphone', route: '/growth/campaigns', needs: 'campaigns.manage', words: ['حملة', 'حملات', 'اعلان', 'إعلان', 'إعلانات'] },
];

/** The rows this account is told about. `can` is the server's permission check; the registry takes it as a parameter for this. */
export function creatablesFor(user: SessionUser, can: PermissionCheck): CreateRow[] {
  return CREATABLES.filter((c) => {
    const route = findRoute(c.route);
    return !!route && canAccessRoute(user, route, can) && can(user, c.needs) && (!c.alsoNeeds || can(user, c.alsoNeeds));
  }).map((c) => ({
    key: c.key,
    label: c.label,
    hint: c.note ? `${routeLabel(c.route)} — ${c.note}` : routeLabel(c.route),
    icon: c.icon,
    words: [...c.words, ...GENERIC_WORDS],
    href: `${c.route}?${CREATE_PARAM}=${c.key}`,
  }));
}
