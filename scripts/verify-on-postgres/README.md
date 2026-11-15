# كيت الفحص على PostgreSQL حقيقية (مركز التأكيد v2 — الخطوة A+B)

## ليش هالكيت

كل فحوص A وB بتشتغل على قاعدة بيانات **وهمية** (دبل بالذاكرة بيطبّق الفلاتر) و jsdom. هاد بيخلّي استعلامات متل ترتيب الإعادات بالموعد (`pickMostOverdueRetry`، الـ`select` المتداخل) ما اتجرّبت ولا مرة على PostgreSQL، وما في ولا صورة شاشة للتطبيق شغّال. جواب المخطط (15/11، البند 11): **الفحص على قاعدة PostgreSQL تجريبية إجباري قبل الـdeploy — مش إنتاج — وبعدها صور شاشة لـA وB.**

الكيت بيعمل هالشي بدون ما يلمس شي عندك: حاوية Docker مرمية على جهازك، قاعدة اسمها `scratch_zaki`، وكل شي بيشتغل عليها بس.

## شو بيضمن

- **ما بيوصل لأي قاعدة غير القاعدة التجريبية.** كل سكربت بيبني عنوان القاعدة بنفسو (`lib.mjs`) وبيمرّو على بوّابة وحدة (`assertScratchUrl`): المضيف لازم يكون `localhost` أو `127.0.0.1` واسم القاعدة لازم يبدأ بـ`scratch_` — وإلا بيوقف قبل أي اتصال. عنوان ملف `.env` ولا متغيّرات الـshell عندك ما بتنقرا ولا بتنطبع.
- **متغيّر البيئة بيغلب ملف `.env`** — `migrate.mjs` بيثبّتها كل مرة (بمضيف وهمي `*.invalid`) قبل ما يطبّق أي migration.
- **كلمة سر القاعدة** بتتولّد وقت التشغيل، بتمرق للـdocker بالبيئة مش بسطر الأوامر، وما بتنكتب بأي ملف ولا بتنطبع. **كلمة سر الحسابات التجريبية** (`seed.mjs`) بتنطبع مرة وحدة بالكونسول (أو انت بتختارها بـ`KIT_PASSWORD`) وما بتنكتب بأي ملف.
- **ما بينزّل شي**: الصورة `postgres:16-alpine` لازم تكون موجودة، والمتصفح هو Edge أو Chrome المثبّت عندك.
- **ما بيغيّر كود المنتج** ولا `prisma/seed.ts` ولا أي فحص.

## المتطلبات

Docker شغّال (والصورة `postgres:16-alpine` موجودة) · Node 22 أو أحدث · Microsoft Edge أو Google Chrome مثبّت · الشجرة المدموجة (A+B) هي اللي بتشغّل منها، وفيها `node_modules`.

## الترتيب (PowerShell، من جذر المشروع)

```powershell
# 1 — القاعدة التجريبية (بتتكرّر بأمان: لو شغّالة بيقول هيك)
node scripts/verify-on-postgres/start-db.mjs

# 2 — الـmigrations (كل prisma/migrations، بـ migrate deploy فقط؛ بيثبّت أول شي إنو متغيّر البيئة بيغلب .env)
node scripts/verify-on-postgres/migrate.mjs

# 3 — بيانات السيناريو (بتمسح القاعدة التجريبية وبتكتب من جديد بمواعيد نسبية للحظة التشغيل)
node scripts/verify-on-postgres/seed.mjs
#     بيطبع كلمة السر مرة وحدة. خدها لهون:
$env:KIT_PASSWORD = "<الكلمة اللي انطبعت>"

# 4 — التطبيق على القاعدة التجريبية (نافذة PowerShell تانية؛ بيضل شغّال لحد Ctrl+C)
node scripts/verify-on-postgres/run-app.mjs
#     بيطبع KIT_APP_URL=http://127.0.0.1:3100 (أول port فاضي من 3100). لو غيره: $env:KIT_APP_URL = "..."

# 5 — فحص دخان: الدخول + GET /api/confirmation/mine للمكاتب الثلاثة
node scripts/verify-on-postgres/check-app.mjs

# 6 — ترتيب السحب من كود المنتج الحقيقي (ما بيأكّد شي: بيطبع، وانت بتقارن)
node scripts/verify-on-postgres/pull-order.mjs          # --sql لطباعة كل الـSQL، --no-real-pulls لتخطّي القسم 3

# 7 — صور الشاشة (مجلد الصور وسيط)
node scripts/verify-on-postgres/screenshots.mjs --out C:\kit-shots --pages mine,mine-off,settings,timeline
node scripts/verify-on-postgres/screenshots.mjs --out C:\kit-shots\full --pages mine --full

# 8 — قياس حمل (اختياري): N إعادة جاهزة وزمن استعلام الترتيب وهل طلع تحذير امتلاء الصفحة
node scripts/verify-on-postgres/scale-retries.mjs --count 2500
node scripts/verify-on-postgres/seed.mjs               # بعدو لازم seed جديد (القياس بيكتب)

# 9 — التنظيف: بيشيل الحاوية والـvolume وبس
node scripts/verify-on-postgres/stop-db.mjs
```

## شو بتطلع كل خطوة

| الخطوة | شو بتشوف | معناها |
|---|---|---|
| `migrate` | `الإثبات: بدون متغيّر → "decoy-host.invalid" … مع متغيّر → "127.0.0.1:54329"` ثم `152 migration`… `كلها خالصة` | الـmigrations طبّقت على PostgreSQL حقيقية، وما انرجع ولا واحد |
| `seed` | جدول بالطلبات (الاسم، شركة/بلد، pool أو بيد مين، الحالة، المتوقع) وقايمة الحسابات | السيناريو انكتب |
| `check-app` | `PASS` لكل مكتب، وحد 5 + `cadenceOn=true` بشركة ON، وحد 3 بلا `cadenceOn` بشركة OFF | الدخول و«طلباتي» شغّالين على قاعدة حقيقية |
| `pull-order` قسم 1 | الترتيب اللي `pickNextCandidate` بيسلّم فيه كل مكتب | **هاد اللي بتقارنو بجواب المخطط 13** |
| `pull-order` قسم 2 | الـSQL الكامل لاستعلام `pickMostOverdueRetry` والمدة | الـselect المتداخل نفّذ أو لأ، ومين رجّع |
| `pull-order` قسم 3 | `pullNextOrder` الحقيقية: 3a كما هي (بترفض «سجّل محاولة اتصال…» لأنو بإيد الموظفة طلب جديد ما انتصل فيه)، 3b بعد ما لمست اللي بإيدها وخلّصت كل سحبة | الباب الحقيقي بيسلّم نفس ترتيب القسم 1 |
| `screenshots` | `OK` لكل صورة (وفشل = صورة `FAILED` وكود خروج 1) | صور 1280×900 و390×844 |

## السيناريو

شركتان: **KIT ON** (المفتاح `callProofAndCadence` شغّال منذ 3 أيام) فيها بلدين — **سوريا** (`Asia/Damascus`، `weekendDays = []`، دوام 10:00–22:00) و**الأردن** (`Asia/Amman`، `[5,6]`، 09:00–17:00) — و**KIT OFF** (مطفي) فيها سوريا. المستخدمون (`@scratch.test`): `admin-on` (البلدين) · `agent1-on` (سوريا) · `agent2-on` (الأردن) · `admin-off` · `agent-off`. كلهم بكلمة سر وحدة (`KIT_PASSWORD`).

طلبات ON/سوريا (الأسماء بتقول الحالة، والملف `scenario.mjs` هو المصدر):

| الطلب | الحالة | لشو |
|---|---|---|
| `SY-NEW-1`, `SY-NEW-2` | جديدة (ما انتصل فيها) | الجديد أول |
| `SY-PROMISE-DUE` | وعد زبون وصل موعدو (مؤجّل، `postponedUntil` قبل 20 د) | وعد وصل وقتو |
| `SY-PROMISE-WAITING` | مؤجّل بعد 6 ساعات | ما بينسحب |
| `SY-RETRY-A` / `B` / `C` / `E` | إعادات جاهزة: الموعد -150 / -90 / -90 (**تعادل** بين B وC، B أقدم إنشاءً) / -60 (وE أقدمهم إنشاءً بأربعة أيام وبمحاولتين) | ترتيب الإعادات بالموعد مش بالعمر |
| `SY-RETRY-D` | إعادة بمحاولتين، الثانية قبل دقيقتين، وموعدها بعد ساعتين تقريباً | ما حان — ما بتنسحب (لساعتين من لحظة البذر) |
| `SY-LEGACY` | سطر «لا يرد» قبل لحظة تشغيل المفتاح (ما بيحمل موعد) | «الباقي بالأقدم» |
| `SY-HELD-NEW` / `RETRY` / `PROMISE` | بإيد `agent1-on` | مكتب طلباتي |
| `SY-CLOSED-TODAY` | أُغلق اليوم بالمحاولة الخامسة (خمس محاولات محسوبة بمواعيد الجدول الحقيقية) | بطاقة «أُغلقت اليوم» |

وللأردن: `JO-NEW-1`، `JO-RETRY-READY`، `JO-RETRY-WAIT`، `JO-HELD-NEW`. ولشركة OFF: `OFF-NEW-1`، `OFF-NO-ANSWER`، `OFF-HELD-NEW`، `OFF-CLOSED-TODAY` (قاعدة الثلاثة).

**كل المواعيد نسبية للحظة `seed.mjs`.** بعد ساعات «الجاهز» ممكن يصير «لسا» والعكس — شغّل `seed.mjs` قبل أي فحص. عمود «المتوقع» بـ`scenario.mjs` وصف لقواعد المخطط وقت الكتابة (ما في ولا assertion بالكيت)؛ لو انغيّر ترتيب السحب أو الكلمات بكود جديد، عدّل الوصف هناك.

## ملاحظات

- **أول فتحة لكل صفحة بـ`next dev` بطيئة** (بيبنيها وقت الطلب). `screenshots.mjs` بيستنى لحد دقيقتين لكل صفحة (`--timeout`).
- **من worktree بلا `node_modules` حقيقي**: Turbopack ما بيبني عبر junction، فـ`run-app.mjs` بيحط `NEXT_TURBOPACK_ROOT` لأقرب مجلد فوق فيه `node_modules` حقيقي، والبناء بـ`.next-verify` (متجاهَل بـgit). من الشجرة الرئيسية ما بيحتاج شي.
- **الدخول بالكيت لا يطلب رمز التحقّق الثنائي** (المفتاح `AUTH_TWO_FACTOR_REQUIRED` مطفي افتراضياً)؛ لو شغّلتو بنفسك بالبيئة، الكيت ما بيدير الخطوة التانية.
- **ما اتفحص بالكيت**: المتصفح الحقيقي (الصور بـEdge headless لحدّ صفحة وحدة)، بناء الإنتاج `next build` (الكيت على `next dev`)، وحجم الدفعة الأولى لـ`/confirmation/mine` — هاد بيبقى `REQUIRE_BUILD=1 npx vitest run src/lib/staff-confirmation-first-load.test.ts` بعد `next build` عند المالك.
