'use client';

import { useRef, useState } from 'react';
import { RiDeleteBinLine, RiImageLine, RiLoader4Line, RiUpload2Line } from '@remixicon/react';
import { Input } from '@/components/ui/Input';
import { apiJson } from '@/lib/api-client';

/** One slide, as the slider block stores it. */
export interface Slide {
  image: string;
  title: string;
  text: string;
  button: string;
  link: string;
}

export const BLANK_SLIDE: Slide = { image: '', title: '', text: '', button: '', link: '' };

const LABEL = 'mb-1 block text-xs font-semibold text-[var(--sys-muted-foreground)]';

/**
 * «الشرائح» — their slider's per-slide form: a picture, a title, a line, a
 * button and where it goes. The picture is uploaded (the editor's own upload
 * door) or picked from this store's own product photographs — never a
 * picture from somewhere else.
 */
export function SlidesField({
  slides,
  onChange,
  onUpload,
}: {
  slides: Slide[];
  onChange: (next: Slide[]) => void;
  onUpload: (files: FileList) => Promise<string[]>;
}) {
  const put = (i: number, patch: Partial<Slide>) => onChange(slides.map((s, k) => (k === i ? { ...s, ...patch } : s)));
  return (
    <div className="space-y-2.5">
      {slides.map((slide, i) => (
        <div key={i} className="space-y-2 rounded-lg border border-[var(--sys-border)] p-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-bold text-[var(--sys-heading)]">الشريحة {i + 1}</span>
            <button
              type="button"
              aria-label={`احذف الشريحة ${i + 1}`}
              onClick={() => onChange(slides.filter((_, k) => k !== i))}
              className="text-[var(--sys-muted-foreground)] hover:text-[var(--sys-destructive)]"
            >
              <RiDeleteBinLine className="h-4 w-4" />
            </button>
          </div>
          <SlideImage image={slide.image} onImage={(image) => put(i, { image })} onUpload={onUpload} />
          <label className="block">
            <span className={LABEL}>العنوان</span>
            <Input className="text-xs" maxLength={120} value={slide.title} onChange={(e) => put(i, { title: e.target.value })} />
          </label>
          <label className="block">
            <span className={LABEL}>النص</span>
            <Input className="text-xs" maxLength={240} value={slide.text} onChange={(e) => put(i, { text: e.target.value })} />
          </label>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block">
              <span className={LABEL}>نص الزر</span>
              <Input className="text-xs" maxLength={40} value={slide.button} onChange={(e) => put(i, { button: e.target.value })} />
            </label>
            <label className="block">
              <span className={LABEL}>الرابط</span>
              <Input
                className="text-xs"
                dir="ltr"
                maxLength={2048}
                placeholder="/s/متجري/shop"
                value={slide.link}
                onChange={(e) => put(i, { link: e.target.value.trim() })}
              />
            </label>
          </div>
        </div>
      ))}
      {slides.length < 10 && (
        <button
          type="button"
          onClick={() => onChange([...slides, { ...BLANK_SLIDE }])}
          className="w-full rounded-lg border border-dashed border-[var(--sys-border-strong)] py-2 text-xs font-bold text-[var(--sys-muted-foreground)] hover:text-[var(--sys-primary)]"
        >
          أضف شريحة
        </button>
      )}
      <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
        الزر بيظهر بس إذا كتبت نصه ورابطه. الرابط صفحة من متجرك (بيبدأ بـ /) أو عنوان كامل بيبدأ بـ https://
      </p>
    </div>
  );
}

function SlideImage({
  image,
  onImage,
  onUpload,
}: {
  image: string;
  onImage: (src: string) => void;
  onUpload: (files: FileList) => Promise<string[]>;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [photos, setPhotos] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      const [url] = await onUpload(files);
      if (url) onImage(url);
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = '';
    }
  }

  async function pick() {
    setError(null);
    try {
      const res = await apiJson<{ photos: string[] }>('/api/store/photos');
      setPhotos(res.photos);
    } catch {
      setError('تعذّر جلب صور المنتجات');
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt="" className="h-14 w-20 rounded-md border border-[var(--sys-border)] object-cover" />
        ) : (
          <span className="flex h-14 w-20 items-center justify-center rounded-md border border-dashed border-[var(--sys-border-strong)] text-[var(--sys-muted)]">
            <RiImageLine className="h-4 w-4" />
          </span>
        )}
        <div className="flex flex-wrap gap-1">
          <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-[var(--sys-border)] px-2 py-1 text-xs font-bold text-[var(--sys-foreground)] hover:text-[var(--sys-primary)]">
            {busy ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiUpload2Line className="h-4 w-4" />}
            ارفع
            <input ref={ref} type="file" accept="image/*" className="hidden" disabled={busy} onChange={(e) => void upload(e.target.files)} />
          </label>
          <button
            type="button"
            onClick={() => void pick()}
            className="rounded-md border border-[var(--sys-border)] px-2 py-1 text-xs font-bold text-[var(--sys-foreground)] hover:text-[var(--sys-primary)]"
          >
            من صور منتجاتك
          </button>
        </div>
      </div>
      {error && <p className="mt-1 text-xs text-[var(--sys-destructive)]">{error}</p>}
      {photos && (
        <div className="mt-2">
          {photos.length === 0 ? (
            <p className="text-xs text-[var(--sys-muted)]">ما في صور منتجات بهالمتجر بعد.</p>
          ) : (
            <div className="grid grid-cols-4 gap-1">
              {photos.map((src) => (
                <button
                  key={src}
                  type="button"
                  aria-label="اختر هالصورة"
                  aria-pressed={src === image}
                  onClick={() => {
                    onImage(src);
                    setPhotos(null);
                  }}
                  className={`overflow-hidden rounded-md border ${src === image ? 'border-[var(--sys-primary)]' : 'border-[var(--sys-border)]'}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt="" className="aspect-square w-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
