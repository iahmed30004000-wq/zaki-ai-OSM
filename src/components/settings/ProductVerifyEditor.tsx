'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';
import { useConfirm } from '@/components/ui/Confirm';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { apiJson } from '@/lib/api-client';
import { copyText } from '@/lib/clipboard';
import { ProductVerifyView } from '@/components/verify/ProductVerifyView';
import {
  HEX_COLOR,
  VERIFY_DEFAULTS,
  VERIFY_LIMITS,
  normalizeSlug,
  productVerifyLink,
  productVerifyStableLink,
  slugProblem,
  contactWhatsappUrl,
  type VerifyDesign,
} from '@/lib/product-verify-design';
import {
  RiArrowLeftLine,
  RiCheckLine,
  RiDeleteBinLine,
  RiDownload2Line,
  RiFileCopyLine,
  RiImageAddLine,
  RiLoader4Line,
  RiPrinterLine,
} from '@remixicon/react';

/**
 * «صمّم الصفحة» — THE OWNER'S EDITOR OF ONE PRODUCT'S PUBLIC PAGE, WITH THE PAGE ITSELF BESIDE IT (25/11, owner).
 *
 * The preview is `ProductVerifyView`, the very component `/v/<slug>` draws, fed from the form as it is typed — so what
 * the owner sees is what a customer gets (a «صفحة الهبوط» reorder link is resolved by the server, so the preview only
 * shows that the button is there). Below it: the short link (editable — an old one keeps working as a redirect), the
 * product's barcode (its QR) to download or print, and the QR of each piece code tagged to this product.
 *
 * Reads on `settings.view` (the screen's door); every save asks `settings.edit` on the server. Without it the form is
 * read-only and says so.
 */

export interface ProductRow {
  id: string;
  name: string;
  nameEn: string | null;
  sku: string;
  image: string | null;
  status: string;
  store: { logo: string | null } | null;
}
export interface PageRow {
  id: string;
  productId: string;
  publicId: string;
  slug: string;
  active: boolean;
  headline: string | null;
  nameOverride: string | null;
  imageUrl: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
  backgroundColor: string | null;
  description: string | null;
  features: string;
  genuineMessage: string | null;
  notGenuineMessage: string | null;
  whatsappNumber: string | null;
  reorderMode: string;
  reorderUrl: string | null;
  oldSlugs: { slug: string }[];
}
interface CodeRow {
  id: string;
  code: string;
  note: string | null;
  productId: string | null;
}

const API = '/api/settings/product-verify-pages';
const QR_API = '/api/settings/product-verify-pages/qr';
const IMAGE_API = '/api/settings/product-verify-pages/image';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A sheet of labels in a window of its own — the same way «رموز الأصالة» prints. */
function printLabels(title: string, items: { caption: string; sub?: string; img: string }[]): boolean {
  const w = window.open('', '_blank');
  if (!w) return false;
  const cells = items
    .map((i) => `<figure><img alt="" src="${esc(i.img)}"><figcaption>${esc(i.caption)}</figcaption>${i.sub ? `<small dir="ltr">${esc(i.sub)}</small>` : ''}</figure>`)
    .join('');
  w.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
@page{margin:10mm}body{margin:0;font-family:Tahoma,'Segoe UI',sans-serif;color:#000}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(48mm,1fr));gap:6mm}
figure{margin:0;padding:3mm;border:1px dashed #999;text-align:center;break-inside:avoid}
img{width:100%;height:auto;display:block}
figcaption{font:700 10pt Tahoma,sans-serif;margin-top:2mm}small{display:block;font:8pt monospace;word-break:break-all;color:#333;margin-top:1mm}
</style></head><body><main>${cells}</main></body></html>`);
  w.document.close();
  setTimeout(() => {
    w.focus();
    w.print();
  }, 400);
  return true;
}

function download(href: string) {
  const a = document.createElement('a');
  a.href = href;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

interface Form {
  slug: string;
  active: boolean;
  headline: string;
  nameOverride: string;
  imageUrl: string;
  logoUrl: string;
  primaryColor: string;
  backgroundColor: string;
  description: string;
  features: string;
  genuineMessage: string;
  notGenuineMessage: string;
  whatsappNumber: string;
  reorderMode: 'landing' | 'custom' | 'none';
  reorderUrl: string;
}

function formOf(page: PageRow | null): Form {
  let features: string[] = [];
  try {
    features = page ? (JSON.parse(page.features) as string[]) : [];
  } catch {
    features = [];
  }
  return {
    slug: page?.slug ?? '',
    active: page?.active ?? true,
    headline: page?.headline ?? '',
    nameOverride: page?.nameOverride ?? '',
    imageUrl: page?.imageUrl ?? '',
    logoUrl: page?.logoUrl ?? '',
    primaryColor: page?.primaryColor ?? VERIFY_DEFAULTS.primaryColor,
    backgroundColor: page?.backgroundColor ?? VERIFY_DEFAULTS.backgroundColor,
    description: page?.description ?? '',
    features: features.join('\n'),
    genuineMessage: page?.genuineMessage ?? '',
    notGenuineMessage: page?.notGenuineMessage ?? '',
    whatsappNumber: page?.whatsappNumber ?? '',
    reorderMode: (['landing', 'custom', 'none'].includes(page?.reorderMode ?? '') ? page!.reorderMode : 'landing') as Form['reorderMode'],
    reorderUrl: page?.reorderUrl ?? '',
  };
}

/** What the server is sent: the form, with empty text as null and the features as a list. */
function bodyOf(f: Form) {
  const t = (s: string) => s.trim() || null;
  return {
    slug: normalizeSlug(f.slug),
    active: f.active,
    headline: t(f.headline),
    nameOverride: t(f.nameOverride),
    imageUrl: t(f.imageUrl),
    logoUrl: t(f.logoUrl),
    primaryColor: t(f.primaryColor),
    backgroundColor: t(f.backgroundColor),
    description: t(f.description),
    features: f.features.split('\n').map((s) => s.trim()).filter(Boolean),
    genuineMessage: t(f.genuineMessage),
    notGenuineMessage: t(f.notGenuineMessage),
    whatsappNumber: t(f.whatsappNumber),
    reorderMode: f.reorderMode,
    reorderUrl: f.reorderMode === 'custom' ? t(f.reorderUrl) : null,
  };
}

/** An image the DASHBOARD can show: an https link or one of our own (the owner is signed in). */
const viewable = (u: string) => (/^https:\/\//i.test(u) || u.startsWith('/api/') ? u : null);

export function ProductVerifyEditor({
  product,
  page,
  canEdit,
  onSaved,
  onDeleted,
  onBack,
}: {
  product: ProductRow;
  page: PageRow | null;
  canEdit: boolean;
  onSaved: (page: PageRow) => void;
  onDeleted: () => void;
  onBack: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [form, setForm] = useState<Form>(() => formOf(page));
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<null | 'image' | 'logo'>(null);
  const [verdict, setVerdict] = useState<'genuine' | 'fake' | null>(null);
  const [codes, setCodes] = useState<CodeRow[] | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const logoInput = useRef<HTMLInputElement>(null);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  // A client screen drawn after its data arrives, so the address is read directly. The form is the page it was opened
  // with: the screen gives the editor a new `key` when the page itself changes identity (created, or another product).
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  // A new page starts with a free short link, suggested by the server from the product's name.
  useEffect(() => {
    if (page) return;
    let live = true;
    apiJson<{ slug: string }>(`${API}?suggest=${encodeURIComponent(product.id)}`)
      .then((d) => live && setForm((f) => (f.slug ? f : { ...f, slug: d.slug })))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [page, product.id]);

  // The piece codes of this product: the ones tagged to it (the page also accepts untagged ones, which belong to all).
  const loadCodes = useCallback(async () => {
    try {
      const d = await apiJson<{ codes: CodeRow[] }>('/api/settings/authenticity-codes');
      setCodes((d.codes ?? []).filter((c) => c.productId === product.id));
    } catch {
      setCodes([]);
    }
  }, [product.id]);
  useLiveRefresh(loadCodes);

  const slug = normalizeSlug(form.slug);
  const slugError = form.slug ? slugProblem(slug) : null;
  const slugChanged = !!page && slug !== page.slug;
  const link = origin && slug && !slugError ? productVerifyLink(origin, slug) : '';
  const savedLink = origin && page ? productVerifyLink(origin, page.slug) : '';

  const design: VerifyDesign = useMemo(() => {
    const name = form.nameOverride.trim() || product.name;
    const primary = HEX_COLOR.test(form.primaryColor) ? form.primaryColor : VERIFY_DEFAULTS.primaryColor;
    const background = HEX_COLOR.test(form.backgroundColor) ? form.backgroundColor : VERIFY_DEFAULTS.backgroundColor;
    return {
      name,
      headline: form.headline.trim() || VERIFY_DEFAULTS.headline,
      description: form.description.trim(),
      features: form.features.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, VERIFY_LIMITS.features),
      imageUrl: viewable(form.imageUrl.trim()) ?? (product.image ? viewable(product.image) : null),
      logoUrl: viewable(form.logoUrl.trim()) ?? (product.store?.logo ? viewable(product.store.logo) : null),
      primaryColor: primary,
      backgroundColor: background,
      genuineMessage: form.genuineMessage.trim() || VERIFY_DEFAULTS.genuineMessage,
      notGenuineMessage: form.notGenuineMessage.trim() || VERIFY_DEFAULTS.notGenuineMessage,
      whatsappUrl: contactWhatsappUrl(form.whatsappNumber, name),
      // The landing page is resolved by the server on the real page; here the button only shows it will be there.
      reorderUrl: form.reorderMode === 'custom' ? form.reorderUrl.trim() || null : form.reorderMode === 'landing' ? '#' : null,
    };
  }, [form, product]);

  const save = async () => {
    if (slugError) {
      toast.failed(slugError);
      return;
    }
    setBusy(true);
    try {
      const d = page
        ? await apiJson<{ page: PageRow }>(API, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: page.id, ...bodyOf(form) }),
          })
        : await apiJson<{ page: PageRow }>(API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ productId: product.id, ...bodyOf(form) }),
          });
      onSaved(d.page);
      toast.done(page ? 'انحفظت الصفحة' : 'انعملت صفحة المنتج');
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الحفظ');
    } finally {
      setBusy(false);
    }
  };

  /** The switch of a saved page takes effect at once; a new page's is part of the first save. */
  const toggle = async (next: boolean) => {
    if (!page) {
      set('active', next);
      return;
    }
    const d = await apiJson<{ page: PageRow }>(API, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: page.id, active: next }),
    });
    onSaved(d.page);
  };

  const remove = async () => {
    if (!page) return;
    const ok = await confirm({
      title: `حذف صفحة «${product.name}»؟`,
      body: 'كل باركود مطبوع لهالمنتج (ولكل روابطه القديمة) رح يوقف يفتح الصفحة، والرابط بيرجع متاح لغيره. إذا بدك توقفها مؤقتاً، طفّي «الصفحة شغالة» بدل الحذف.',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await apiJson(API, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: page.id }) });
      toast.done('انحذفت الصفحة');
      onDeleted();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الحذف');
    } finally {
      setBusy(false);
    }
  };

  const upload = async (kind: 'image' | 'logo', file: File | undefined) => {
    if (!file) return;
    setUploading(kind);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('productId', product.id);
      fd.append('kind', kind);
      const d = await apiJson<{ url: string }>(IMAGE_API,{ method: 'POST', body: fd });
      set(kind === 'image' ? 'imageUrl' : 'logoUrl', d.url);
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر رفع الصورة');
    } finally {
      setUploading(null);
    }
  };

  const copy = async (text: string) => {
    if (await copyText(text)) toast.done('تم نسخ الرابط');
    else toast.failed('تعذر النسخ — الرابط: ' + text);
  };

  const qr = (extra = '') => (page ? `${QR_API}?id=${encodeURIComponent(page.id)}${extra}&v=${encodeURIComponent(page.slug)}` : '');
  const blocked = () => toast.failed('المتصفح منع نافذة الطباعة — اسمح بالنوافذ المنبثقة لهذا الموقع');

  const printProduct = () => {
    if (!page) return;
    if (!printLabels(product.name, [{ caption: product.name, sub: savedLink, img: `${origin}${qr('&format=svg')}` }])) blocked();
  };
  const printPieces = () => {
    if (!page || !codes?.length) return;
    const items = codes.map((c) => ({
      caption: product.name,
      sub: c.code,
      img: `${origin}${qr(`&code=${encodeURIComponent(c.id)}&format=svg`)}`,
    }));
    if (!printLabels(`${product.name} — رموز القطع`, items)) blocked();
  };

  const ro = !canEdit;
  const field = { disabled: ro } as const;

  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="quiet" size="sm" onClick={onBack}>
          <RiArrowLeftLine className="h-4 w-4 icon-mirror" /> رجوع لقائمة المنتجات
        </Button>
        <p className="text-note font-semibold text-[var(--sys-foreground)]">{product.name}</p>
      </div>
      {ro && <p className="text-note text-[var(--sys-muted-foreground)]">قراءة فقط — لا تملك صلاحية التعديل.</p>}

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', alignItems: 'start' }}>
        {/* ── the form ── */}
        <div className="space-y-4" style={{ minWidth: 0 }}>
          <Card>
            <CardHeader title="الرابط والحالة" subtitle="الرابط المختصر هو اللي بينطبع بالباركود." />
            <CardContent className="space-y-3">
              <Switch
                checked={page ? page.active : form.active}
                onChange={toggle}
                disabled={ro}
                label="الصفحة شغالة"
                hint="إذا طفيتها، الباركود بيفتح «الصفحة غير موجودة» لحتى ترجع تشغّلها."
              />
              <Input
                label="الرابط المختصر"
                value={form.slug}
                onChange={(e) => set('slug', e.target.value.toLowerCase())}
                dir="ltr"
                maxLength={40}
                placeholder="krem-1"
                error={slugError ?? undefined}
                helperText={origin ? `${origin}/v/…  — أحرف إنكليزية صغيرة وأرقام وشرطة` : undefined}
                {...field}
              />
              {slugChanged && !slugError && (
                <p className="rounded-lg border border-[var(--sys-border)] p-2.5 text-note text-[var(--sys-foreground)]">
                  الباركودات المطبوعة بالرابط القديم «{page!.slug}» بتضل شغالة — بتتحوّل تلقائياً للرابط الجديد بعد الحفظ.
                </p>
              )}
              {link && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--sys-border)] p-2.5 text-note">
                  <span className="font-mono text-[var(--sys-foreground)]" dir="ltr" style={{ wordBreak: 'break-all', minWidth: 0 }}>
                    {link}
                  </span>
                  <Button variant="quiet" size="sm" onClick={() => void copy(link)}>
                    <RiFileCopyLine className="h-4 w-4" /> نسخ
                  </Button>
                </div>
              )}
              {page && page.oldSlugs.length > 0 && (
                <p className="text-note text-[var(--sys-muted-foreground)]">
                  روابط قديمة بتتحوّل لهون: <span dir="ltr">{page.oldSlugs.map((s) => s.slug).join(' · ')}</span>
                </p>
              )}
              {page && origin && (
                <p className="text-note text-[var(--sys-muted-foreground)]">
                  رابط ثابت ما بيتغيّر أبداً (بيحوّل للرابط المختصر):{' '}
                  <span className="font-mono" dir="ltr" style={{ wordBreak: 'break-all' }}>
                    {productVerifyStableLink(origin, page.publicId)}
                  </span>
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader title="المنتج والشكل" subtitle="الفاضي بياخد من المنتج نفسه." />
            <CardContent className="space-y-3">
              <Input label="اسم المنتج على الصفحة" value={form.nameOverride} onChange={(e) => set('nameOverride', e.target.value)} placeholder={product.name} maxLength={VERIFY_LIMITS.name} {...field} />
              <div className="space-y-2">
                <Input label="صورة المنتج (رابط https أو ارفع صورة)" value={form.imageUrl} onChange={(e) => set('imageUrl', e.target.value)} dir="ltr" placeholder="صورة المنتج نفسه" {...field} />
                <div className="flex flex-wrap gap-2">
                  <input ref={imageInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => void upload('image', e.target.files?.[0])} />
                  <Button variant="quiet" size="sm" disabled={ro || !!uploading} onClick={() => imageInput.current?.click()}>
                    {uploading === 'image' ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiImageAddLine className="h-4 w-4" />} ارفع صورة
                  </Button>
                  {form.imageUrl && (
                    <Button variant="quiet" size="sm" disabled={ro} onClick={() => set('imageUrl', '')}>
                      رجّع صورة المنتج
                    </Button>
                  )}
                </div>
              </div>
              <div className="space-y-2">
                <Input label="الشعار (رابط https أو ارفع صورة)" value={form.logoUrl} onChange={(e) => set('logoUrl', e.target.value)} dir="ltr" placeholder="شعار المتجر" {...field} />
                <div className="flex flex-wrap gap-2">
                  <input ref={logoInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => void upload('logo', e.target.files?.[0])} />
                  <Button variant="quiet" size="sm" disabled={ro || !!uploading} onClick={() => logoInput.current?.click()}>
                    {uploading === 'logo' ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiImageAddLine className="h-4 w-4" />} ارفع شعار
                  </Button>
                  {form.logoUrl && (
                    <Button variant="quiet" size="sm" disabled={ro} onClick={() => set('logoUrl', '')}>
                      رجّع شعار المتجر
                    </Button>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-3">
                {(['primaryColor', 'backgroundColor'] as const).map((k) => (
                  <label key={k} className="flex items-center gap-2 text-sm" style={{ flex: '1 1 10rem' }}>
                    <input
                      type="color"
                      value={HEX_COLOR.test(form[k]) ? form[k] : VERIFY_DEFAULTS[k]}
                      onChange={(e) => set(k, e.target.value)}
                      disabled={ro}
                      aria-label={k === 'primaryColor' ? 'اللون الأساسي' : 'لون الخلفية'}
                      style={{ width: 44, height: 36, padding: 0, border: 0, background: 'none' }}
                    />
                    <span className="text-[var(--sys-foreground)]">{k === 'primaryColor' ? 'اللون الأساسي' : 'لون الخلفية'}</span>
                    <span className="font-mono text-note text-[var(--sys-muted-foreground)]" dir="ltr">
                      {form[k]}
                    </span>
                  </label>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader title="النصوص والميزات" />
            <CardContent className="space-y-3">
              <Input label="العنوان" value={form.headline} onChange={(e) => set('headline', e.target.value)} placeholder={VERIFY_DEFAULTS.headline} maxLength={VERIFY_LIMITS.headline} {...field} />
              <Textarea label="وصف قصير" value={form.description} onChange={(e) => set('description', e.target.value)} rows={3} maxLength={VERIFY_LIMITS.description} {...field} />
              <Textarea
                label={`الميزات — كل ميزة بسطر (${VERIFY_LIMITS.features} على الأكثر)`}
                value={form.features}
                onChange={(e) => set('features', e.target.value)}
                rows={4}
                {...field}
              />
              <Textarea label="رسالة «منتج أصلي»" value={form.genuineMessage} onChange={(e) => set('genuineMessage', e.target.value)} placeholder={VERIFY_DEFAULTS.genuineMessage} rows={2} maxLength={VERIFY_LIMITS.message} {...field} />
              <Textarea label="رسالة «غير أصلي» (اختياري)" value={form.notGenuineMessage} onChange={(e) => set('notGenuineMessage', e.target.value)} placeholder={VERIFY_DEFAULTS.notGenuineMessage} rows={2} maxLength={VERIFY_LIMITS.message} {...field} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader title="أزرار التواصل والطلب" />
            <CardContent className="space-y-3">
              <Input label="رقم واتساب (مع رمز البلد)" value={form.whatsappNumber} onChange={(e) => set('whatsappNumber', e.target.value)} dir="ltr" placeholder="963912345678" maxLength={20} {...field} />
              <div className="space-y-2 text-sm">
                <p className="font-medium text-[var(--sys-foreground)]">زر «اطلب مرة تانية»</p>
                {(
                  [
                    ['landing', 'لصفحة الهبوط تبع المنتج (الأحدث المنشورة)'],
                    ['custom', 'لرابط بختاره'],
                    ['none', 'بلا زر'],
                  ] as const
                ).map(([v, label]) => (
                  <label key={v} className="flex items-center gap-2">
                    <input type="radio" name="reorder" checked={form.reorderMode === v} onChange={() => set('reorderMode', v)} disabled={ro} />
                    {label}
                  </label>
                ))}
                {form.reorderMode === 'custom' && (
                  <Input label="الرابط" value={form.reorderUrl} onChange={(e) => set('reorderUrl', e.target.value)} dir="ltr" placeholder="https://…" {...field} />
                )}
              </div>
            </CardContent>
          </Card>

          {canEdit && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button onClick={() => void save()} disabled={busy || !!slugError || !slug}>
                {busy ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiCheckLine className="h-4 w-4" />}
                {page ? 'احفظ' : 'اعمل الصفحة'}
              </Button>
              {page && (
                <Button variant="danger" size="sm" onClick={() => void remove()} disabled={busy}>
                  <RiDeleteBinLine className="h-4 w-4" /> حذف الصفحة
                </Button>
              )}
            </div>
          )}
        </div>

        {/* ── the page itself, live ── */}
        <div className="space-y-3" style={{ minWidth: 0, position: 'sticky', top: 8 }}>
          <div className="flex flex-wrap items-center gap-2 text-note">
            <span className="text-[var(--sys-muted-foreground)]">معاينة النتيجة:</span>
            {(
              [
                [null, 'قبل الفحص'],
                ['genuine', 'أصلي'],
                ['fake', 'غير أصلي'],
              ] as const
            ).map(([v, label]) => (
              <Button key={label} variant={verdict === v ? 'primary' : 'quiet'} size="sm" onClick={() => setVerdict(v)}>
                {label}
              </Button>
            ))}
          </div>
          <div className="rounded-lg border border-[var(--sys-border)]" style={{ maxHeight: '78vh', overflowY: 'auto', maxWidth: 430, marginInline: 'auto', width: '100%' }}>
            <ProductVerifyView design={design} preview={{ verdict }} />
          </div>
        </div>
      </div>

      {page && (
        <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', alignItems: 'start' }}>
          <Card>
            <CardHeader title="باركود المنتج" subtitle="QR بيفتح صفحة المنتج. لحالو ما بيثبت إنو القطعة أصلية — رمز القطعة هو اللي بيثبت." />
            <CardContent className="space-y-3 text-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qr('&format=svg')} alt={`باركود ${product.name}`} style={{ width: '100%', maxWidth: 240, aspectRatio: '1', margin: '0 auto', display: 'block', background: 'white' }} />
              <p className="font-mono text-note text-[var(--sys-foreground)]" dir="ltr" style={{ wordBreak: 'break-all' }}>
                {savedLink}
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="quiet" size="sm" onClick={() => void copy(savedLink)}>
                  <RiFileCopyLine className="h-4 w-4" /> نسخ الرابط
                </Button>
                <Button variant="quiet" size="sm" onClick={() => download(qr('&format=png&download=1'))}>
                  <RiDownload2Line className="h-4 w-4" /> نزّل PNG
                </Button>
                <Button variant="quiet" size="sm" onClick={() => download(qr('&format=svg&download=1'))}>
                  <RiDownload2Line className="h-4 w-4" /> نزّل SVG
                </Button>
                <Button size="sm" onClick={printProduct}>
                  <RiPrinterLine className="h-4 w-4" /> طباعة ملصق
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader title="QR لكل قطعة" subtitle="رابط الصفحة مع رمز القطعة — الزبون بيصوّره وبتطلع النتيجة لحالها." />
            <CardContent className="space-y-2">
              {codes === null ? (
                <p className="text-note text-[var(--sys-muted-foreground)]">
                  <RiLoader4Line className="h-4 w-4 animate-spin" />
                </p>
              ) : codes.length === 0 ? (
                <p className="rounded-lg border border-[var(--sys-border)] p-3 text-note text-[var(--sys-muted-foreground)]">
                  ما في رموز مربوطة بهالمنتج. ضيفها من «رموز الأصالة» واختار المنتج. (الرموز اللي «لكل المنتجات» كمان بتطلع «أصلي» هون.)
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-note font-semibold text-[var(--sys-foreground)]">رموز هالمنتج ({codes.length})</p>
                    <Button variant="quiet" size="sm" onClick={printPieces}>
                      <RiPrinterLine className="h-4 w-4" /> طباعة كل الرموز
                    </Button>
                  </div>
                  {codes.map((c) => (
                    <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--sys-border)] p-2.5 text-note">
                      <span className="font-mono font-semibold text-[var(--sys-foreground)]" dir="ltr" style={{ wordBreak: 'break-all', minWidth: 0, flex: '1 1 10rem' }}>
                        {c.code}
                      </span>
                      <div className="flex flex-wrap gap-2">
                        <Button variant="quiet" size="sm" onClick={() => void copy(productVerifyLink(origin, page.slug, c.code))}>
                          <RiFileCopyLine className="h-4 w-4" /> نسخ
                        </Button>
                        <Button variant="quiet" size="sm" onClick={() => download(qr(`&code=${encodeURIComponent(c.id)}&format=png&download=1`))}>
                          <RiDownload2Line className="h-4 w-4" /> QR
                        </Button>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
