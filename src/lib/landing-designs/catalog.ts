/**
 * THE DESIGN CATALOGUE — sixty-four looks, metadata only.
 *
 * The owner, 3/11: keep our builder, upsell, offers, pixels and guards, and
 * take the step flow and the design library of his other platform. This
 * file is that library's index, copied literally from the harvest of
 * 3/11 (the library page's cards and each design's own page): the id, the
 * Arabic name and one-line description, the category, light or dark, the
 * animated badge (the twenty-eight whose id starts «imx-»), the four colour
 * dots the card shows, and the typeface the design declares.
 *
 * WHAT IS NOT HERE: how a design looks. The looks over our blocks are a
 * second builder's work and read this file; the wizard, the library and
 * the page's own record only need to NAME a design, and a name that is
 * checked against this list is the whole contract between the two.
 *
 * A page stores the chosen id as `design` in its theme. An id that is not
 * in this list is refused at creation; a reader that meets one it does not
 * know draws the page as if no design were named.
 */

export type DesignCategory =
  | 'general'
  | 'shopify'
  | 'fashion'
  | 'beauty'
  | 'electronics'
  | 'home'
  | 'kids'
  | 'luxury'
  | 'health'
  | 'food'
  | 'gifts'
  | 'immersive';

export type DesignMood = 'light' | 'dark';

export interface LandingDesign {
  id: string;
  name: string;
  description: string;
  category: DesignCategory;
  mood: DesignMood;
  /** Moves with the mouse and the scroll. True for every «imx-» id and no other. */
  animated: boolean;
  /** The four dots the card shows, as the library printed them. */
  swatches: readonly string[];
  /** The typeface the design's own page declares. */
  font: string;
}

/** Their category set, in their order. «الكل» is a filter, not a category. */
export const DESIGN_CATEGORIES: readonly { id: DesignCategory; label: string }[] = [
  { id: 'general', label: 'كل المنتجات' },
  { id: 'shopify', label: 'ستايل شوبيفاي' },
  { id: 'fashion', label: 'أزياء' },
  { id: 'beauty', label: 'جمال وعناية' },
  { id: 'electronics', label: 'إلكترونيات' },
  { id: 'home', label: 'البيت والمطبخ' },
  { id: 'kids', label: 'أطفال' },
  { id: 'luxury', label: 'عطور وفخامة' },
  { id: 'health', label: 'رياضة وصحة' },
  { id: 'food', label: 'أكل' },
  { id: 'gifts', label: 'هدايا وإكسسوارات' },
  { id: 'immersive', label: 'تفاعلي (متحرك)' },
];

export const MOOD_LABEL: Record<DesignMood, string> = { light: 'فاتح', dark: 'غامق' };

export const DESIGNS: readonly LandingDesign[] = [
  { id: 'imx-dusk-field', name: 'حقل الغروب', description: 'أعمدة ضوء وقت الغروب بتعلى مع حركة الماوس. للأجهزة والتقنية.', category: 'immersive', mood: 'dark', animated: true, swatches: ['#ffb38a', '#ff7ab6', '#140c2c', '#1e1440'], font: 'Readex Pro' },
  { id: 'imx-golden-hour', name: 'الساعة الذهبية', description: 'إضاءة دافية من ورا المنتج وبذور طايرة مع الهوا. للمنتجات الطبيعية والمنزلية والهدايا.', category: 'immersive', mood: 'light', animated: true, swatches: ['#b4561c', '#e9a23b', '#fdf6ea', '#f7ead3'], font: 'Almarai' },
  { id: 'imx-nebula', name: 'كرة السديم', description: 'كرة ضوء نعناعي وبنفسجي بتتنفس ورا المنتج. للتجميل والتقنية والمنتجات الفاخرة.', category: 'immersive', mood: 'dark', animated: true, swatches: ['#6effd6', '#a76eff', '#07060d', '#14112a'], font: 'IBM Plex Sans Arabic' },
  { id: 'imx-blue-filament', name: 'الخيط الأزرق', description: 'أزرق غامق مع خط ضوء نابض. هادي ودقيق، للإلكترونيات والأدوات.', category: 'immersive', mood: 'dark', animated: true, swatches: ['#7fd3ff', '#3fb6ff', '#041447', '#0a1f5e'], font: 'IBM Plex Sans Arabic' },
  { id: 'imx-chrome-night', name: 'ليلة الكروم', description: 'نجمة كروم بتلف وضوء بنفسجي مع جزيئات طايرة. للساعات والأجهزة.', category: 'immersive', mood: 'dark', animated: true, swatches: ['#d9ccff', '#8b5cf6', '#0d0526', '#1a0f3d'], font: 'Readex Pro' },
  { id: 'imx-lava', name: 'توهج الحمم', description: 'أشكال حمرا بتتحرك زي مصباح الحمم مع حبيبات فيلم. للعطور والأزياء.', category: 'immersive', mood: 'dark', animated: true, swatches: ['#ff3b1f', '#ff9a4a', '#0d0304', '#1c0708'], font: 'Noto Kufi Arabic' },
  { id: 'imx-helix', name: 'لولب العيادة', description: 'خيوط لولبية خضرا وأثر حبر بيلحق الماوس. لمنتجات الصحة والعناية.', category: 'immersive', mood: 'dark', animated: true, swatches: ['#4ade80', '#2dd4bf', '#04170f', '#0a2a1d'], font: 'IBM Plex Sans Arabic' },
  { id: 'imx-hologram', name: 'هولوغرام', description: 'المنتج كهولوغرام فوق حقل رموز مضيء. للتقنية والأجهزة الذكية.', category: 'immersive', mood: 'dark', animated: true, swatches: ['#22d3ee', '#a78bfa', '#020610', '#071a2b'], font: 'IBM Plex Sans Arabic' },
  { id: 'imx-deep-space', name: 'الفضاء العميق', description: 'جزيئات برتقالية وزرقا بتكبر لمجرة حلزونية حوالين المنتج.', category: 'immersive', mood: 'dark', animated: true, swatches: ['#ff9a3c', '#4cc3ff', '#020208', '#0f0e22'], font: 'Readex Pro' },
  { id: 'imx-paper-crimson', name: 'ورق وقرمزي', description: 'ورق وضباب وختم شمع قرمزي. أنيق، للعطور والعناية بالبشرة والهدايا.', category: 'immersive', mood: 'light', animated: true, swatches: ['#8f1324', '#c08a4a', '#f6f1e8', '#efe6d8'], font: 'Noto Naskh Arabic' },
  { id: 'imx-steel-vault', name: 'خزنة الفولاذ', description: 'فولاذ مصقول ورش بخاخ وأسلاك شائكة؛ المنتج ككرت نادر للمقتنيات.', category: 'immersive', mood: 'dark', animated: true, swatches: ['#c6ff3d', '#ff3ea5', '#1b1d22', '#26292f'], font: 'Noto Kufi Arabic' },
  { id: 'imx-autumn-sky', name: 'سماء الخريف', description: 'سماء خريفية مرسومة مع غيوم بتمشي وورق شجر بيوقع. دافية، للبيت والأطفال.', category: 'immersive', mood: 'light', animated: true, swatches: ['#a8432a', '#e8875a', '#fff6ea', '#fbe7d2'], font: 'Tajawal' },
  { id: 'imx-fizz-pop', name: 'فوّار', description: 'ألوان قوية وفقاعات طالعة ومنتج بيلحق الماوس وثلاث ثيمات ألوان بكبسة. للمشروبات والسناكات والمنتجات المرحة.', category: 'immersive', mood: 'dark', animated: true, swatches: ['#ffffff', '#ffd43b', '#8a0f33', '#a3123d'], font: 'Readex Pro' },
  { id: 'imx-cinematic', name: 'سكرول سينمائي', description: 'سكرول زي الفيلم: بداية بنجمة كروم، قصة بصورة ثابتة، معرض بيتحرك بالعرض، وكروت فوق بعض. للأجهزة الفاخرة والهدايا.', category: 'immersive', mood: 'dark', animated: true, swatches: ['#d9ccff', '#a78bfa', '#0b0420', '#170d36'], font: 'Readex Pro' },
  { id: 'imx-clinic-flow', name: 'تدفق العيادة', description: 'بداية بخيوط لولبية، شريط خدمات بيمشي، وبلوكات بتتراكم مع السكرول. للصحة والعناية.', category: 'immersive', mood: 'dark', animated: true, swatches: ['#4ade80', '#2dd4bf', '#04170f', '#0b2a1d'], font: 'IBM Plex Sans Arabic' },
  { id: 'imx-studio-reel', name: 'شريط الاستوديو', description: 'لقطة دافية طويلة: سماء مرسومة، شريط صور بيتحرك بالعرض، وقصة بصورة ثابتة. للبيت والأطفال والمنتجات اليدوية.', category: 'immersive', mood: 'light', animated: true, swatches: ['#a8432a', '#e8875a', '#fff6ea', '#fbe7d2'], font: 'Tajawal' },
  { id: 'imx-atelier', name: 'أتيليه', description: 'هادي وأنيق: ورق وقرمزي، قصة بطيئة بصورة ثابتة، شريط نص مفرّغ ومعرض بالعرض. للعطور والعناية بالبشرة.', category: 'immersive', mood: 'light', animated: true, swatches: ['#8f1324', '#c08a4a', '#f6f1e8', '#efe6d8'], font: 'Noto Naskh Arabic' },
  { id: 'imx-orbit', name: 'مدار', description: 'بداية بمجرة فضائية، كروت فوق بعض، ومعرض بيتحرك مع السكرول. للتقنية والإطلاقات الجريئة.', category: 'immersive', mood: 'dark', animated: true, swatches: ['#ff9a3c', '#4cc3ff', '#03030b', '#101026'], font: 'Readex Pro' },
  { id: 'imx-showcase', name: 'معرض غامق', description: 'موقع بأسلوب المكتبات على خلفية شبه سودا: تدرّج ألوان حي، كروت صور، خطوات الطلب مرقّمة، حلقات الوعود، ومعرض بالعرض.', category: 'immersive', mood: 'dark', animated: true, swatches: ['#ffffff', '#a78bfa', '#060606', '#111113'], font: 'IBM Plex Sans Arabic' },
  { id: 'imx-showcase-light', name: 'معرض فاتح', description: 'نفس الموقع على خلفية فاتحة بتدرّج ألوان باستيل. نظيف وأنيق.', category: 'immersive', mood: 'light', animated: true, swatches: ['#111111', '#7c3aed', '#f7f6f3', '#ffffff'], font: 'IBM Plex Sans Arabic' },
  { id: 'imx-orb-studio', name: 'الكرة القزحية', description: 'كرة سائلة بألوان قزحية وحلقة زجاج ورا المنتج، كاروسيل ثلاثي الأبعاد، كروت بتنفرد، خط طلب بيضوي، ومؤشر ماوس مخصص.', category: 'immersive', mood: 'dark', animated: true, swatches: ['#ffffff', '#ff7ad9', '#07040f', '#120c22'], font: 'IBM Plex Sans Arabic' },
  { id: 'imx-aurum', name: 'القمة الذهبية', description: 'أسود وذهبي: تضاريس من خطوط ذهبية متموجة بتعلى تحت الماوس، كاروسيل ثلاثي الأبعاد، كروت متتالية وخط طلب ذهبي.', category: 'immersive', mood: 'dark', animated: true, swatches: ['#e9b949', '#f5c451', '#050403', '#14100a'], font: 'Readex Pro' },
  { id: 'imx-particles', name: 'أشكال الجزيئات', description: 'كرة من ألف جزيء مضيء بتلف وبتتحول لحلقة وبتتبعثر من الماوس، مع كاروسيل ثلاثي الأبعاد وخط طلب.', category: 'immersive', mood: 'dark', animated: true, swatches: ['#5ad2ff', '#a078ff', '#040a1a', '#0b1630'], font: 'IBM Plex Sans Arabic' },
  { id: 'imx-glass-blinds', name: 'ستائر الزجاج', description: 'ضوء أخضر ليموني وزمردي من ورا ستائر زجاج مغبّش بتتمايل، مع كاروسيل ثلاثي الأبعاد وكروت متتالية وخط طلب مضيء.', category: 'immersive', mood: 'dark', animated: true, swatches: ['#b6ff3b', '#34d399', '#03140c', '#082116'], font: 'Readex Pro' },
  { id: 'imx-warp', name: 'سرعة الضوء', description: 'نجوم بتتمدد لخطوط ضوء لما تنزل بالصفحة، نافذة صورة بتكبر لملء الشاشة، كلمات بتضوي، أعمدة صور بتتحرك، ونفق صور طاير عليك.', category: 'immersive', mood: 'dark', animated: true, swatches: ['#9cc8ff', '#7aa7ff', '#000000', '#0b0f1a'], font: 'IBM Plex Sans Arabic' },
  { id: 'imx-dither', name: 'ديذر بوب', description: 'موجة بكسلات ريترو بالزهري بتكبر تحت الماوس، مع كلمات بتضوي مع السكرول، نافذة صورة بتكبر، أعمدة صور، وحلقة صور ثلاثية الأبعاد بتلف مع السكرول.', category: 'immersive', mood: 'dark', animated: true, swatches: ['#ff4fa3', '#ff4fa3', '#000000', '#120a0e'], font: 'IBM Plex Sans Arabic' },
  { id: 'imx-dunes', name: 'غروب الصحراء', description: 'كثبان مضيئة، الشمس بتغيب والنجوم بتطلع لما تنزل، طبقات كثبان بتتحرك بسرعات مختلفة، نافذة صورة بتكبر، ونفق صور.', category: 'immersive', mood: 'dark', animated: true, swatches: ['#ffb86b', '#ff7a59', '#1a0a1f', '#28122c'], font: 'Readex Pro' },
  { id: 'imx-nebula-film', name: 'فيلم السديم', description: 'كرة سديم بتتنفس ورا المنتج، وبعدها فيلم كامل مع السكرول: كلمات بتضوي، نافذة صورة بتنفتح، أعمدة بتتحرك، وحلقة صور ثلاثية الأبعاد.', category: 'immersive', mood: 'dark', animated: true, swatches: ['#b69cff', '#6effd6', '#07060d', '#120f22'], font: 'IBM Plex Sans Arabic' },
  { id: 'cod-bold', name: 'عرض قوي', description: 'ألوان قوية، السعر بالواجهة، شريط ثقة وخطوات طلب سريعة. معمول لإعلانات الدفع عند الاستلام.', category: 'general', mood: 'light', animated: false, swatches: ['#e11d48', '#f59e0b', '#ffffff', '#fff1f2'], font: 'Cairo' },
  { id: 'quick-order', name: 'طلب سريع', description: 'صفحة قصيرة: صورة وسعر وزر والأساسيات بس. للمنتجات اللي بتنشرى بسرعة وبسعر قليل.', category: 'general', mood: 'light', animated: false, swatches: ['#dc2626', '#facc15', '#ffffff', '#fef2f2'], font: 'Cairo' },
  { id: 'orange-energy', name: 'طاقة برتقالية', description: 'برتقالي دافي، الصورة عاليسار وأزرار كبيرة. بتلفت النظر بإعلانات السوشال ميديا.', category: 'general', mood: 'light', animated: false, swatches: ['#ea580c', '#0ea5e9', '#ffffff', '#fff7ed'], font: 'Cairo' },
  { id: 'clean-minimal', name: 'نظيف وبسيط', description: 'مساحات بيضاء وصور كبيرة ونص قصير، بيخلي المنتج يحكي عن حاله.', category: 'general', mood: 'light', animated: false, swatches: ['#111827', '#2563eb', '#ffffff', '#f8fafc'], font: 'Tajawal' },
  { id: 'problem-solution', name: 'مشكلة ← حل', description: 'بيحكي قصة: المشكلة، وكيف المنتج بيحلها، وكيف تستخدمه.', category: 'general', mood: 'light', animated: false, swatches: ['#7c3aed', '#22c55e', '#ffffff', '#f5f3ff'], font: 'Tajawal' },
  { id: 'fashion-lookbook', name: 'لوك بوك أزياء', description: 'الصور أولاً، زوايا حادة وخط أسود، متل مجلة الموضة.', category: 'fashion', mood: 'light', animated: false, swatches: ['#111111', '#a16207', '#ffffff', '#f5f5f4'], font: 'Tajawal' },
  { id: 'street-style', name: 'ستريت ستايل', description: 'أبيض وأسود بزوايا حادة وقصة متعرجة. للأحذية الرياضية والشنط والملابس الكاجوال.', category: 'fashion', mood: 'light', animated: false, swatches: ['#18181b', '#65a30d', '#ffffff', '#f4f4f5'], font: 'Cairo' },
  { id: 'soft-beauty', name: 'ناعم وأنيق', description: 'ألوان باستيل وأشكال ناعمة، للتجميل والأزياء والأطفال.', category: 'beauty', mood: 'light', animated: false, swatches: ['#db2777', '#f9a8d4', '#fffafc', '#fde8f1'], font: 'Almarai' },
  { id: 'rose-gold', name: 'روز غولد', description: 'زهري هادي وذهبي ناعم مع صور مقوّسة. للعناية بالبشرة والمكياج والإكسسوارات.', category: 'beauty', mood: 'light', animated: false, swatches: ['#b76e79', '#c9a227', '#fffaf8', '#f9ece9'], font: 'Almarai' },
  { id: 'natural-care', name: 'عناية طبيعية', description: 'أخضر مريمية وكريمي هادي. للمنتجات الطبيعية والعشبية والعضوية.', category: 'beauty', mood: 'light', animated: false, swatches: ['#4d7c0f', '#ca8a04', '#fbfaf5', '#eef3e2'], font: 'Tajawal' },
  { id: 'tech-specs', name: 'تقني ومواصفات', description: 'واجهة كحلية وشبكة مميزات وقائمة مواصفات واضحة، للأجهزة والأدوات.', category: 'electronics', mood: 'light', animated: false, swatches: ['#2563eb', '#06b6d4', '#ffffff', '#eff6ff'], font: 'Cairo' },
  { id: 'neon-gadget', name: 'أجهزة نيون', description: 'خلفية غامقة مع توهج سماوي. للسماعات والألعاب والأجهزة الذكية.', category: 'electronics', mood: 'dark', animated: false, swatches: ['#22d3ee', '#a78bfa', '#05070d', '#0f1522'], font: 'Cairo' },
  { id: 'smart-home', name: 'بيت ذكي', description: 'أخضر مزرق منعش وقائمة مميزات واضحة. لأجهزة البيت والأدوات الكهربائية.', category: 'electronics', mood: 'light', animated: false, swatches: ['#0d9488', '#5eead4', '#ffffff', '#f0fdfa'], font: 'Tajawal' },
  { id: 'home-cozy', name: 'بيت دافي', description: 'تيراكوتا وكريمي مع صور كبيرة. للأثاث والديكور والمفارش.', category: 'home', mood: 'light', animated: false, swatches: ['#c2410c', '#65a30d', '#fffbf5', '#fbefe2'], font: 'Almarai' },
  { id: 'kitchen-fresh', name: 'مطبخ منعش', description: 'أخضر نظيف، المنتج عاليسار وخطوات سريعة. لأدوات المطبخ والتنظيف.', category: 'home', mood: 'light', animated: false, swatches: ['#059669', '#f59e0b', '#ffffff', '#ecfdf5'], font: 'Cairo' },
  { id: 'kids-fun', name: 'مرح الأطفال', description: 'برتقالي وأزرق سماوي مرح مع أشكال دائرية. للألعاب ومنتجات الأطفال.', category: 'kids', mood: 'light', animated: false, swatches: ['#f97316', '#38bdf8', '#fffdf7', '#fff1e0'], font: 'Cairo' },
  { id: 'baby-soft', name: 'ناعم للأطفال', description: 'أزرق فاتح وزوايا ناعمة والصور أولاً. لمنتجات العناية بالرضّع وغرف الأطفال.', category: 'kids', mood: 'light', animated: false, swatches: ['#0284c7', '#f472b6', '#fbfdff', '#e8f4fd'], font: 'Almarai' },
  { id: 'dark-premium', name: 'فاخر داكن', description: 'أسود وذهبي، للساعات والعطور والإلكترونيات والهدايا.', category: 'luxury', mood: 'dark', animated: false, swatches: ['#d4af37', '#d4af37', '#0b0b0f', '#16161d'], font: 'Almarai' },
  { id: 'oud-luxury', name: 'عود وعنبر', description: 'بني غامق وذهبي دافي. للعود والعطور والهدايا الشرقية.', category: 'luxury', mood: 'dark', animated: false, swatches: ['#c9a86a', '#e3c58d', '#1a120b', '#261a10'], font: 'Almarai' },
  { id: 'royal-purple', name: 'بنفسجي ملكي', description: 'بنفسجي ليلي وليلكي بأسلوب قصة. للهدايا الفاخرة ومستحضرات التجميل.', category: 'luxury', mood: 'dark', animated: false, swatches: ['#c4b5fd', '#f0abfc', '#120d1f', '#1d1530'], font: 'Tajawal' },
  { id: 'sport-power', name: 'قوة رياضية', description: 'أسود وأحمر، قصيرة وقوية. للمعدات الرياضية وأدوات اللياقة.', category: 'health', mood: 'light', animated: false, swatches: ['#dc2626', '#f59e0b', '#ffffff', '#f4f4f5'], font: 'Cairo' },
  { id: 'wellness-calm', name: 'عافية وهدوء', description: 'سماوي هادي وقصة واضحة مشكلة ← حل. لمنتجات الصحة والعناية.', category: 'health', mood: 'light', animated: false, swatches: ['#0891b2', '#10b981', '#ffffff', '#ecfeff'], font: 'Tajawal' },
  { id: 'food-tasty', name: 'شهي', description: 'عنبري دافي وصور وفوائد بالتناوب. للأكل والقهوة والعسل والحلويات.', category: 'food', mood: 'light', animated: false, swatches: ['#b45309', '#16a34a', '#fffdf7', '#fef3c7'], font: 'Cairo' },
  { id: 'gift-joy', name: 'فرحة الهدية', description: 'أحمر وذهبي احتفالي والصور أولاً. للهدايا والمناسبات وبوكسات الهدايا.', category: 'gifts', mood: 'light', animated: false, swatches: ['#be123c', '#d97706', '#ffffff', '#fff1f2'], font: 'Cairo' },
  { id: 'watch-classic', name: 'كحلي كلاسيكي', description: 'كحلي وأبيض بزوايا خفيفة. للساعات والمحافظ والإكسسوارات الرجالية.', category: 'gifts', mood: 'light', animated: false, swatches: ['#1e3a8a', '#b45309', '#ffffff', '#f1f5fb'], font: 'Tajawal' },
  { id: 'car-gear', name: 'إكسسوارات السيارات', description: 'واجهة فحمية مع أزرار صفراء. لإكسسوارات وأدوات السيارات.', category: 'electronics', mood: 'light', animated: false, swatches: ['#facc15', '#facc15', '#ffffff', '#f9fafb'], font: 'Cairo' },
  { id: 'daybreak', name: 'إشراقة', description: 'ستايل شوبيفاي: بانر صورة بعرض الصفحة، أزرار سودا بسيطة ومساحات بيضا كثير.', category: 'shopify', mood: 'light', animated: false, swatches: ['#121212', '#121212', '#ffffff', '#f3f3f3'], font: 'IBM Plex Sans Arabic' },
  { id: 'gentle-glow', name: 'توهّج ناعم', description: 'ستايل شوبيفاي: لافندر وخوخي ناعم بزوايا دائرية. للجمال والعناية.', category: 'shopify', mood: 'light', animated: false, swatches: ['#7b5ea7', '#f4a988', '#fdf9f6', '#f3ecfa'], font: 'Readex Pro' },
  { id: 'handmade', name: 'صنع يدوي', description: 'ستايل شوبيفاي: ألوان ورق دافية وخط نسخ، متل محل حرفي. للحرف والشموع والمنتجات الطبيعية.', category: 'shopify', mood: 'light', animated: false, swatches: ['#7c4a2d', '#6b7a3a', '#f6f1e7', '#ece3d2'], font: 'Noto Naskh Arabic' },
  { id: 'fresh-pop', name: 'فريش بوب', description: 'ستايل صفحة منتج شوبيفاي: الصور جنب التفاصيل والسعر وزر الطلب، مع معلومات بتنفتح.', category: 'shopify', mood: 'light', animated: false, swatches: ['#0b3d91', '#65a30d', '#ffffff', '#eef6d8'], font: 'Readex Pro' },
  { id: 'kitchen-table', name: 'طاولة المطبخ', description: 'ستايل شوبيفاي ببلوكات ألوان برتقالي وأخضر وأصفر. للأكل والقهوة ومنتجات المطبخ.', category: 'shopify', mood: 'light', animated: false, swatches: ['#d9480f', '#2b8a3e', '#fffaf3', '#ffe8cc'], font: 'Cairo' },
  { id: 'gallery-white', name: 'معرض أبيض', description: 'ستايل مجلة شوبيفاي: خط كبير وصور كبيرة وزوايا حادة وتقريباً بدون ألوان.', category: 'shopify', mood: 'light', animated: false, swatches: ['#111111', '#888888', '#ffffff', '#f7f7f7'], font: 'Noto Kufi Arabic' },
  { id: 'night-ride', name: 'جولة ليلية', description: 'ستايل شوبيفاي غامق مع أزرار نيون. للرياضة والرحلات والملابس الكاجوال.', category: 'shopify', mood: 'dark', animated: false, swatches: ['#d4ff3f', '#d4ff3f', '#0a0a0a', '#161616'], font: 'Noto Kufi Arabic' },
  { id: 'front-page', name: 'الصفحة الأولى', description: 'ستايل صفحة منتج شوبيفاي بالأبيض والأسود وخط نسخ، متل الجريدة.', category: 'shopify', mood: 'light', animated: false, swatches: ['#000000', '#b91c1c', '#ffffff', '#f2efe9'], font: 'Noto Naskh Arabic' },
  { id: 'playful', name: 'مرِح', description: 'ستايل شوبيفاي ببلوكات زهري وبنفسجي وأصفر. للأطفال والهدايا والمنتجات المرحة.', category: 'shopify', mood: 'light', animated: false, swatches: ['#e64980', '#ffd43b', '#ffffff', '#f8f0fc'], font: 'Readex Pro' },
  { id: 'colour-blocks', name: 'بلوكات ألوان', description: 'ستايل شوبيفاي ببلوكات أزرق وأصفر وأحمر قوية وزوايا حادة. صعب تتجاوزها.', category: 'shopify', mood: 'light', animated: false, swatches: ['#1c4ed8', '#ffd60a', '#ffffff', '#f1f3f5'], font: 'IBM Plex Sans Arabic' },
];

const BY_ID = new Map(DESIGNS.map((d) => [d.id, d]));

/** The design with this id, or undefined — never a fallback look. */
export function designById(id: string | null | undefined): LandingDesign | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/** The Arabic name of a category. */
export function categoryLabel(id: DesignCategory): string {
  return DESIGN_CATEGORIES.find((c) => c.id === id)?.label ?? id;
}

/**
 * THE FULL PREVIEW, DRAWN WITH THE SELLER'S OWN PRODUCT.
 *
 * The route behind it is the looks builder's; this only makes the link, so
 * every screen that shows a design opens the same address.
 */
export function designPreviewHref(id: string, productId?: string | null): string {
  const q = productId ? `?product=${encodeURIComponent(productId)}` : '';
  return `/lp/design-preview/${encodeURIComponent(id)}${q}`;
}

export interface DesignFilter {
  category?: DesignCategory | '';
  mood?: DesignMood | '';
  query?: string;
}

/** The library's and the wizard's filter, one rule for both screens. */
export function filterDesigns(list: readonly LandingDesign[], f: DesignFilter): LandingDesign[] {
  const q = (f.query ?? '').trim();
  return list.filter(
    (d) =>
      (!f.category || d.category === f.category) &&
      (!f.mood || d.mood === f.mood) &&
      (!q || d.name.includes(q) || d.description.includes(q))
  );
}

/**
 * «شوف كمان» — designs like this one: the same category first, then the
 * same mood, never the design itself.
 */
export function similarDesigns(id: string, limit = 4): LandingDesign[] {
  const me = designById(id);
  if (!me) return [];
  const others = DESIGNS.filter((d) => d.id !== id);
  const sameCat = others.filter((d) => d.category === me.category);
  const sameMood = others.filter((d) => d.category !== me.category && d.mood === me.mood);
  return [...sameCat, ...sameMood].slice(0, limit);
}
