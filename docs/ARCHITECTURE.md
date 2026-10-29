# خريطة النظام — أين كل شي

نظام إدارة الطلبات (دفع عند الاستلام) على Next.js + Prisma + PostgreSQL.
هاد الملف خريطة، مش شرح. كل مسار فيه موجود فعلاً بالمستودع (تحقّقنا منه
٢٩/١٠)، ولا فيه أسرار. القواعد الثابتة وطريقة الشغل بـ`AGENTS.md`، والنشر
بـ`docs/ops/DEPLOY.md`.

## ١. الطبقات

| الطبقة | المكان | شو فيها |
|---|---|---|
| الصفحات | `src/app/(system)/(shell)/<قسم>/` | صفحات النظام الداخلي. كل صفحة رفيعة وبترسم شاشة |
| الشاشات | `src/components/screens/` | الشاشات الكبيرة (حوالي ١١٧ ملف). المكوّنات الصغيرة بمجلدات `src/components/<قسم>/` |
| المكوّنات المشتركة | `src/components/ui/` (زر، نافذة، مبلغ `Money`، صفحات `Pager`…) و`src/components/shell/` (الشريط والقائمة والبحث السريع) | |
| الأبواب (API) | `src/app/api/**/route.ts` | حوالي ٢٨٠ باب. كل باب بيسأل «مين أنت وشو بتقدر» قبل أي شي |
| المنطق | `src/lib/` | مجلد واحد مسطّح فيه الأغلب، ومجلدات فرعية للتكاملات (تحت) |
| الخطّافات | `src/hooks/` | `usePagedList` · `useLiveRefresh` · `useProducts`… |
| السياق | `src/context/AppContext.tsx` | الجلسة والمتجر والعملة للواجهة |
| قاعدة البيانات | `prisma/schema.prisma` + `prisma/migrations/` | الترحيلات تُكتب بالإيد وتضيف بس (نمط `20261027000000_sensitive_settings_own_key/`: `migration.sql` و`rollback.sql`) |
| الحارس العام | `src/proxy.ts` | يفصل العام (دخول، متجر، صفحات هبوط) عن الداخلي |

مفاتيح الشاشات كلها بسجل واحد: `src/lib/route-registry.ts` (القائمة والبحث
السريع والحارس بيقرؤوه). الصفحة اللي مش بالسجل = ٤٠٤ (`src/lib/page-guard.ts`).

## ٢. مجموعات `src/lib/` (بالاسم)

الملفات بدون تصنيف بمجلدات، فالمجموعة بتتعرّف من بداية الاسم:

| المجموعة | أمثلة |
|---|---|
| الطلب | `order-state.ts` (آلة الحالات) · `order-stages.ts` · `order-cancel.ts` · `order-closing.ts` · `order-seal.ts` · `order-parser.ts` · `order-tracking.ts` · `change-request-*.ts` (طلبات التعديل) · `confirmation-workflow.ts` · `shipping-workflow.ts` |
| المنتج والعروض | `product-*.ts` · `offers.ts` · `offer-*.ts` · `line-price.ts` · `post-order-offer.ts` · `reservation.ts` · `stock-*.ts` |
| صفحات الهبوط | `landing-*.ts` · `page-templates.ts` — **مسار المتجر والهبوط له وكيله، ما بنلمسه** |
| المتجر | `store-*.ts` · `storefront*.ts` · `system-themes.ts` — نفس القاعدة |
| الذكاء الاصطناعي | `ai.ts` · `ai-provider.ts` · `ai-endpoint.ts` · `ai-prompts.ts` · `ai-rate.ts` · `ai-scope.ts` · `ai-vision.ts` |
| شركات الشحن | `couriers/` (المحوّلات: `logestechs.ts` · `manual.ts` · `apply-event.ts` · `webhook-token.ts`) + `courier-*.ts` المفرودة فوقه (إرسال، نقل، إلغاء، مدن) |
| التتبّع | `tracking-*.ts` و`transit.ts` و`order-tracking.ts` = **تتبّع الطرود**. أما مجلد `tracking/` = **بكسلات الإعلانات** (اسم واحد بمعنيين) |
| الإعلانات | `ads/` (ميتا · تيك توك · سناب · يدوي) · `conversions/` (أحداث التحويل لميتا) · `campaign*.ts` |
| التكاملات | `telegram/` · `whatsapp/` · `v1/` (واجهة الأنظمة الخارجية) · `apps/` (الأحداث لنظام ٧) |
| المهام | `jobs/` |
| الأمان | `auth.ts` · `authorization.ts` · `secrets.ts` · `two-factor*.ts` · `passkey*.ts` · `csp.ts` |

## ٣. المال والمحافظ

كل حساب مال عنده بيت واحد. ما تحسبه بمكان تاني.

| الموضوع | الملف |
|---|---|
| حساب الطلب (السعر − الخصم + التوصيل) | `src/lib/money.ts` |
| سعر السطر | `src/lib/line-price.ts` |
| العملات وخاناتها | `src/lib/currencies.ts` · `src/lib/format.ts` · مكوّن `src/components/ui/Money.tsx` |
| الربح والكلفة | `src/lib/financial.ts` · `src/lib/unit-cost.ts` · `src/lib/profit-summary.ts` |
| العمولة | `src/lib/commission*.ts` (القواعد بيانات بتاريخ سريان) · مهمة `accrue-commission` |
| المحافظ (قيد عكسي، ما في حذف) | `src/lib/wallets.ts` · `src/lib/pay-from-wallet.ts` · أبواب `src/app/api/finance/wallets/` |
| كشف الشركة والمطابقة | `src/lib/settlement.ts` · `settlement-decisions.ts` · `settlement-difference.ts` · `match-integrity.ts` · `manual-statement.ts` · `hand-link.ts` · أبواب `src/app/api/finance/statements/` |
| فرق التحصيل والخصومات | `src/lib/shortfall.ts` · `penalties.ts` · `penalty-service.ts` · مهمة `propose-penalties` |
| المخزون | `src/lib/stock-ledger.ts` · `stock-consumption.ts` · `reservation.ts` |

إنشاء الطلب له أبواب معروفة: `src/app/api/orders/route.ts` (الداخلي) ·
`src/app/api/public/orders/` + `src/lib/public-order.ts` (المتجر والهبوط) ·
`src/lib/v1/order-intake.ts` (الأنظمة الخارجية) · `src/lib/telegram/order-creation.ts`
· `src/app/api/orders/ai-intake/` (الإدخال بالذكاء).

## ٤. المهام والعامل

- العامل عملية مستقلة عن الموقع: `scripts/worker.ts` (يبدأ من `docker-entrypoint.sh`،
  وبيوقف بـ`RUN_WORKER=false`).
- التعريفات: `src/lib/jobs/definitions.ts` (اسم كل مهمة وفترتها ثابتين). التشغيل: `runner.ts`،
  الموعد: `schedule.ts`، نبض العامل: `heartbeat.ts`، التنبيه لما تفشل: `alerts.ts`.
- المهام: `release-stale-claims` · `accrue-commission` · `accrue-period-commission` ·
  `sync-courier-status` · `surface-postponed` · `stale-returns` · `closing-reminder` ·
  `deliver-app-events` · `deliver-conversions` · `propose-penalties` ·
  `escalate-change-requests` · `pull-ad-spend` · `daily-backup` · `watchdog`.
- مهمة وحدة شغّالة بالمرة (قيد جزئي بقاعدة البيانات `job_runs_one_running`).
- الصحة: `src/app/api/health/route.ts` و`src/app/api/health/worker/route.ts`.

## ٥. الأحداث لنظام ٧

- الأحداث الستة (`order.created` · `confirmed` · `shipped` · `delivered` · `returned`
  · `cancelled`) معرّفة بـ`src/lib/apps/events.ts`، وتسجيل التطبيقات بـ`registry.ts`
  و`contract.ts`، والتسليم بمهمة `deliver-app-events` بتوقيع HMAC.
- العقد المنسوخ حرفياً: `contracts/oms-app-events.v1/` (ما بيتعدّل هون، شوف
  `contracts/README.md`). عقد الميديا باير: `contracts/oms-mediabuyer.v1/`.
- يثبّتها: `src/lib/apps/events.test.ts` و`src/lib/apps/events-sites.test.ts`.

## ٦. الصلاحيات

| الطبقة | الملف |
|---|---|
| المحرّك (مصدر الحقيقة) | `src/lib/authorization.ts` (`authorize` · `requirePermission` · `can`) و`src/lib/rbac.ts` |
| حساب الصلاحية الفعلية (الدور + استثناءات المستخدم) | `src/lib/permissions-core.ts` · `user-permissions.ts` |
| كتالوج المفاتيح والأسماء القديمة | `src/lib/permission-catalog.ts` · `permission-aliases.ts` |
| فحص الواجهة (للراحة فقط، السيرفر هو القرار) | `src/lib/can.ts` · `src/hooks/useMayOpen.ts` |
| نطاق الرؤية (طلبات، منتجات، شركات شحن) | `src/lib/order-filters.ts` · `product-scope.ts` · `courier-scope.ts` · `geo-access.ts` |
| الصفحات | `src/lib/page-guard.ts` + `route-registry.ts` |

## ٧. الذكاء الاصطناعي: محلّي فقط لبيانات الزبون

`aiChat({ localOnly: true })` بيرمي `AiNotLocal` قبل أي اتصال إذا المسار مش محلّي
(`src/lib/ai-provider.ts`). باب الإدخال بالذكاء (`/api/orders/ai-intake`) بيستعمله،
وإذا رفض يشتغل المحلّل العادي. التفاصيل بـ`AGENTS.md`.

## ٨. الحراس والاختبارات اللي بتثبّت البنية

حرس بيفشل إذا انكسرت القاعدة. شغّل المتعلّق بتغييرك قبل الدفع، والفحص الكامل بالـCI.

| القاعدة | الاختبار |
|---|---|
| كل باب بيسأل مين أنت | `src/lib/every-route-asks-who.test.ts` |
| مين مسموح يكتب مال الطلب | `every-money-writer-is-known.test.ts` · `money-written-once.test.ts` · `one-calculator.test.ts` · `money-decimals.test.ts` |
| التسوية والمخزون والحالة | `the-settlement-invariants.test.ts` · `the-inventory-invariants.test.ts` · `the-state-invariants.test.ts` |
| عقد الأحداث | `src/lib/apps/events.test.ts` · `events-sites.test.ts` |
| مهمة وحدة بالمرة | `src/lib/jobs/two-workers-one-job.test.ts` |
| الذكاء الاصطناعي | `ai-proposal-only.test.ts` · `ai-routing.test.ts` |
| لا سر بمستودع | `no-secret-reaches-a-commit.test.ts` · `npm run scan:secrets` |
| لا شي مبني وما حدا بيستعمله | `nothing-unused-ships.test.ts` (مكوّنات، صفحات، أبواب، حزم) |
| الواجهة | `the-frontend-invariants.test.ts` · `touch-targets.test.ts` · `western-digits.test.ts` · `arabic-refusals.test.ts` · `one-icon-family.test.ts` · `a-search-box-is-not-a-password.test.ts` |
| الجلب من الواجهة | `bare-fetch-ratchet.test.ts` (الدين بيتعدّ لكل ملف، ممنوع جديد) |
| جرد الأزرار والأسطر | `ui-inventory.test.ts` (مقابل `scripts/ui-inventory.json`) · `cleanup-inventory.test.ts` (مقابل `scripts/cleanup-inventory.json`، أرقام أسطر) |
| الميزانيات | `quality-gates.test.ts` (Tailwind) · `shop-budget.test.ts` · `public-first-load.test.ts` · `what-a-shopper-downloads.test.ts` |
| القوائم | `src/components/ui/the-list-kit.test.tsx` · `a-page-number-is-not-a-crash.test.ts` |

بعض الاختبارات بتقرأ نص ملف المصدر وبتطابقه حرفياً (مثلاً باب
`src/app/api/orders/[id]/route.ts` مذكور بأكتر من اختبار)، فنقل الشيفرة لازم
يخلّي هالنصوص مكانها.

## ٩. أين الباقي

| الشي | المكان |
|---|---|
| قواعد الشغل والمستودعات | `AGENTS.md` |
| النشر (يدوي) | `DEPLOY.md` · `docs/ops/DEPLOY.md` |
| المؤجَّلات والملاحظات (RV) | `BACKLOG_P2.md` · `DEFERRED.md` · `LAUNCH_LEDGER.md` |
| شركات الشحن | `src/lib/couriers/README.md` |
| تلجرام | `docs/telegram.md` |
| المتجر وصفحات الهبوط | `docs/storefront/` (لوكيل المتجر) |
| الانتقال من نظام قديم | `docs/migration/` |
