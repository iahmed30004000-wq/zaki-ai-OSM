/**
 * The brief you hand to an AI to get HTML this system will actually serve.
 *
 * Writing the page is the easy half; the half people lose a day to is finding
 * out, one silent failure at a time, which things the sanitizer strips, which
 * markers wire a button to the real order form, and that a decoration hidden
 * at `left:-9999px` turns an Arabic page into something that slides sideways
 * on every phone. All of that is written down here once.
 *
 * It is kept as data, not prose in a component, so the same text feeds the
 * copy button, the downloaded file, and anything later that needs it.
 */

export const LANDING_HTML_PROMPT = `# صفحة هبوط لنظام Zaki — المواصفات الكاملة

أنت تكتب صفحة هبوط لمنتج واحد، تُرفَع كملف HTML إلى نظام Zaki.
اقرأ كل القيود قبل أن تكتب سطراً واحداً: النظام يعقّم الملف عند الحفظ،
وأي شيء مخالف يُحذف بصمت ولن تعرف أنه اختفى إلا بعد النشر.

---

## 1. كيف تُعرَض صفحتك

- تُحمَّل داخل إطار معزول (iframe) بمصدر مجهول — لا وصول إلى كوكيز
  الموقع ولا إلى الصفحة الأم.
- **نموذج الطلب الحقيقي يُرسَم خارج ملفك، أسفله، بواسطة النظام نفسه.**
  لا تكتب نموذج طلب خاصاً بك: لن يُنشئ طلباً، وسيبدو للزائر نموذجين.
- الحجم الأقصى للملف: **2 ميغابايت**. أقصى CSS: **512 كيلوبايت**.

## 2. ما يُحذف عند الحفظ — لا تستخدمه إطلاقاً

- \`<script>\` بكل أشكاله، وأي جافاسكربت مضمّن.
- معالجات الأحداث داخل الوسوم: \`onclick\`, \`onload\`, \`onerror\`… كلها تُحذف.
- الروابط من نوع \`javascript:\`, \`vbscript:\`, \`data:text/html\`.
- \`<iframe>\`, \`<object>\`, \`<embed>\`, \`<base>\`, \`<meta http-equiv="refresh">\`.
- \`action\` على أي \`<form>\` (النموذج مسموح، لكن وجهته تُحذف).
- في الـCSS: \`expression()\`, \`behavior\`, \`@import\`, وأي \`javascript:\`.

**النتيجة العملية:** صفحتك ثابتة. كل التفاعل يأتي من واجهة \`data-zaki-*\` أدناه،
وهي تعمل بدون أن تكتب سطر جافاسكربت واحداً.

## 3. الأزرار التي تُوصِل إلى الطلب

\`\`\`html
<button data-zaki-action="order">اطلب الآن</button>
<button data-zaki-action="scroll-order">انزل إلى الطلب</button>
<button data-zaki-action="offer" data-zaki-offer="OFFER_ID">اختر هذا العرض</button>
\`\`\`

- \`order\` و \`scroll-order\` ينقلان الزائر إلى نموذج الطلب.
- \`offer\` يختار عرضاً محدداً. **رقم العرض يتحقق منه السيرفر** مقابل عروض
  هذا المنتج؛ رقم غريب أو معدَّل يُتجاهَل بصمت. أرقام العروض تجدها في
  صفحة المنتج.
- إن لم تضع أي زر من هذه، لن يظهر نموذج الطلب أصلاً على الصفحات التي
  تستخدم واجهة \`data-zaki-*\`.

### زر ثابت يلاحق الزائر

\`\`\`html
<button data-zaki-action="order" data-zaki-position="fixed-bottom">اطلب الآن</button>
\`\`\`

القيم: \`fixed-bottom\` | \`fixed-top\` | \`floating\`.

### تنسيق الزر (اختياري)

\`data-zaki-bg\`, \`data-zaki-color\`, \`data-zaki-font-size\`,
\`data-zaki-font-weight\`, \`data-zaki-radius\`, \`data-zaki-width\`,
\`data-zaki-padding\`, \`data-zaki-shadow\`, \`data-zaki-bottom\`,
\`data-zaki-z-index\`.
القيم غير الآمنة تُتجاهَل تلقائياً.

## 4. بيانات حقيقية بدل أرقام مكتوبة بيدك

**لا تكتب السعر أو اسم المنتج نصاً.** إن تغيّر السعر في النظام ستظل صفحتك
تبيع بالسعر القديم. استخدم هذه بدلاً منها:

\`\`\`html
<div data-zaki-product></div>          <!-- بطاقة المنتج كاملة -->
<div data-zaki-offers></div>           <!-- عروض الكميات -->
<div data-zaki-recommendations></div>  <!-- المنتجات المقترحة -->
<div data-zaki-order-form></div>       <!-- مكان النموذج -->
\`\`\`

وللنص المضمّن:
\`{{product.name}}\` · \`{{product.image}}\` · \`{{product.description}}\` · \`{{product.price}}\`

كل القيم تُقرأ من قاعدة البيانات وتُهرَّب قبل الإدراج.

## 5. قواعد لا يذكّرك بها شيء إن خالفتها

1. **الاتجاه عربي:** \`<html dir="rtl" lang="ar">\` وابدأ كل تخطيط من اليمين.
2. **لا تُخفِ شيئاً بـ \`left: -9999px\`.** في صفحة RTL هذا ليس إخفاءً —
   إنه تسعة آلاف بكسل من التمرير الأفقي، والصفحة تنزلق يميناً ويساراً على
   كل هاتف. أخفِ بـ \`display:none\` أو بحجم صفر و \`overflow:hidden\`.
3. **الهاتف أولاً.** أغلب الزوار على هاتف. لا عرض ثابت بالبكسل على حاوية،
   ولا \`white-space: nowrap\` على نص عربي طويل، ولا تمرير أفقي إطلاقاً.
4. **الخطوط:** استخدم خطوط النظام أو Google Fonts عبر \`<link>\`. لا تضمّن
   ملفات خطوط بصيغة base64 — ستأكل حد الحجم.
5. **الصور:** ارفعها من المحرر واستخدم الروابط التي يعطيك إياها. الصور
   الخارجية قد تتوقف عن العمل في أي لحظة.
6. **لا تدّعِ ما ليس صحيحاً:** لا «بقي 3 قطع» وأنت لا تعرف المخزون، ولا
   عدّاد ينتهي ثم يعود من جديد عند التحديث. الزائر يلاحظ، ويتوقف عن تصديق
   كل شيء آخر على الصفحة.

## 6. ما أريده الآن

اكتب لي صفحة هبوط كاملة بملف HTML واحد لمنتج: **[اكتب اسم المنتج ووصفه هنا]**

تتضمن:
- شريط علوي بعرض مختصر
- واجهة: صورة كبيرة، عنوان قوي، سعر، وزر \`data-zaki-action="order"\`
- 3–5 مميزات بأيقونات بسيطة (SVG مضمّن أو رموز نصية)
- عروض الكميات عبر \`<div data-zaki-offers></div>\`
- آراء مشترين (3–4)
- أسئلة شائعة (4–5)
- ضمانات: دفع عند الاستلام، توصيل سريع، إرجاع
- \`<div data-zaki-order-form></div>\` في المكان المناسب
- زر ثابت \`data-zaki-position="fixed-bottom"\`
- تذييل

**التنسيق:** كل الـCSS داخل \`<style>\` واحد في \`<head>\`. لوحة ألوان متناغمة
مبنية على لون أساسي واحد. مسافات مريحة. بلا جافاسكربت إطلاقاً.

أعطني الملف كاملاً جاهزاً للنسخ، بلا شرح قبله أو بعده.
`;

/**
 * The same brief as a Word-openable document.
 *
 * Word reads HTML with its own MIME type and keeps the headings and spacing,
 * which is all this needs — and it avoids pulling a .docx writer into the
 * bundle to produce one file that is ninety-five percent prose.
 */
export function promptAsWordDocument(text: string = LANDING_HTML_PROMPT): string {
  const body = text
    .split('\n')
    .map((line) => {
      if (line.startsWith('# ')) return `<h1>${escapeHtml(line.slice(2))}</h1>`;
      if (line.startsWith('## ')) return `<h2>${escapeHtml(line.slice(3))}</h2>`;
      if (line.startsWith('### ')) return `<h3>${escapeHtml(line.slice(4))}</h3>`;
      if (line.trim() === '---') return '<hr/>';
      if (line.trim() === '') return '<p>&nbsp;</p>';
      if (line.startsWith('- ') || /^\d+\. /.test(line)) {
        return `<p style="margin-inline-start:18px">${inline(line)}</p>`;
      }
      return `<p>${inline(line)}</p>`;
    })
    .join('\n')
    // Fenced code becomes a monospace block Word will not try to reflow.
    .replace(/<p>```html<\/p>/g, '<div style="font-family:Consolas,monospace;background:#f4f4f6;padding:10px;border:1px solid #ddd;direction:ltr;text-align:left">')
    .replace(/<p>```<\/p>/g, '</div>');

  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40" lang="ar">
<head>
<meta charset="utf-8"/>
<title>برومبت صفحة الهبوط — Zaki</title>
<style>
  body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; direction: rtl; font-size: 12pt; line-height: 1.7; }
  h1 { font-size: 20pt; color: #b8256e; }
  h2 { font-size: 15pt; color: #121926; border-bottom: 1.5pt solid #b8256e; padding-bottom: 4pt; }
  h3 { font-size: 13pt; color: #364152; }
  code { font-family: Consolas, monospace; background: #f4f4f6; direction: ltr; }
  hr { border: 0; border-top: 1pt solid #ccc; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escapes, then turns `backticked` spans into code. */
function inline(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** What a design prompt needs to know about one catalogue design. */
export interface PromptDesign {
  name: string;
  description: string;
  mood: 'light' | 'dark';
  animated: boolean;
  swatches: readonly string[];
  font: string;
}

/**
 * «انسخ البرومبت» FOR ONE DESIGN — the look in a few lines, then the
 * whole brief above unchanged.
 *
 * The library's design view hands this to a seller who wants the design
 * built somewhere else, or sent to a designer. The look is described from
 * the catalogue's own fields and nothing else; the rules that make a page
 * this system will serve follow it word for word, because a design brief
 * that dropped them would produce a page the sanitizer strips.
 */
export function designPrompt(d: PromptDesign): string {
  return [
    `# التصميم المطلوب: «${d.name}»`,
    '',
    `- الفكرة: ${d.description}`,
    `- الخلفية: ${d.mood === 'dark' ? 'غامقة' : 'فاتحة'}`,
    `- الألوان بالترتيب (الأساسي، الثاني، الخلفية، السطح): ${d.swatches.join('، ')}`,
    `- الخط: ${d.font}`,
    d.animated
      ? '- فيه حركة مع الماوس والسكرول — خلّيها خفيفة، وما تخبّي نص ولا زر الطلب ورا الحركة.'
      : '- بدون حركة — ثابت ونظيف.',
    '',
    '---',
    '',
    LANDING_HTML_PROMPT,
  ].join('\n');
}
