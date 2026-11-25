'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScanButton } from '@/components/scan/ScanButton';
import { Button } from '@/components/ui/Button';
import { apiJson } from '@/lib/api-client';
import { isDarkColor, type VerifyDesign } from '@/lib/product-verify-design';
import { PRODUCT_VERIFY_CSS } from './product-verify-style';

/**
 * «باركود المنتجات» — ONE PRODUCT'S OWN AUTHENTICITY PAGE, AS THE WORLD SEES IT AND AS THE OWNER PREVIEWS IT.
 *
 * Drawn by `/v/<slug>` (public, no session) and, live, inside the owner's editor on «باركود المنتجات» — the same
 * component, so what the owner sees is what a customer gets. With `preview` it makes no request at all: the verdict it
 * shows is the one the owner picked to look at.
 *
 * A code typed, scanned or carried in the link (`?code=…`, a piece's printed QR) is sent as-is to
 * `POST /api/public/verify-product/<publicId>`, which answers `{ genuine }` and nothing else. The marks are inline SVG,
 * not Remix icons: every Remix icon used anywhere lands in the one shared chunk each staff screen downloads.
 */

type Verdict = null | 'checking' | 'genuine' | 'fake';

export interface ProductVerifyViewProps {
  design: VerifyDesign;
  /** The page's public id — where the check is sent. Unused in a preview. */
  publicId?: string;
  initialCode?: string;
  /** The editor's preview: no request is made, and this verdict is shown. */
  preview?: { verdict: 'genuine' | 'fake' | null };
}

/** The same rule as the store-level page: anything readable goes to the server, which judges it. */
function cleanAnyScan(raw: string): string | null {
  const text = raw.trim();
  if (!text || text.length > 1000 || /[\u0000-\u001F\u007F]/.test(text)) return null;
  return text;
}

const MIN_CHECK_MS = 900;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function Tick() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}
function Cross() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M12 7.5v6M12 17h.01M10.3 3.9L2.6 17.3A2 2 0 004.3 20.3h15.4a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
    </svg>
  );
}
function Shield() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z" />
      <path d="M8.5 12l2.5 2.5 4.5-5" />
    </svg>
  );
}
function Camera() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M9 3h6l1.8 2.5H20a1 1 0 011 1V19a1 1 0 01-1 1H4a1 1 0 01-1-1V6.5a1 1 0 011-1h3.2zm3 4.5a5 5 0 100 10 5 5 0 000-10zm0 2a3 3 0 110 6 3 3 0 010-6z" />
    </svg>
  );
}
function WhatsApp() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M12 2a10 10 0 00-8.6 15.1L2 22l5-1.3A10 10 0 1012 2zm0 18.2a8.2 8.2 0 01-4.2-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1112 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 01-3.3-2.9c-.3-.4.3-.4.8-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 00-.7.3 3 3 0 00-.9 2.2 5.2 5.2 0 001.1 2.7 11.8 11.8 0 004.5 4c1.7.7 2.3.8 3.2.6a2.7 2.7 0 001.8-1.3 2.2 2.2 0 00.1-1.3c0-.1-.2-.2-.4-.3z" />
    </svg>
  );
}
function Bag() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M6 7h12l1 13H5zM9 7a3 3 0 016 0" />
    </svg>
  );
}

export function ProductVerifyView({ design, publicId, initialCode, preview }: ProductVerifyViewProps) {
  const [code, setCode] = useState(initialCode ?? '');
  const [verdict, setVerdict] = useState<Verdict>(initialCode && !preview ? 'checking' : null);
  const [failed, setFailed] = useState(false);
  const started = useRef(false);
  const verdictRef = useRef<HTMLDivElement>(null);

  const check = useCallback(
    async (raw: string) => {
      if (preview || !publicId || !raw.trim()) return;
      setVerdict('checking');
      setFailed(false);
      try {
        const [data] = await Promise.all([
          apiJson<{ genuine?: boolean }>(`/api/public/verify-product/${publicId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: raw }),
          }),
          wait(MIN_CHECK_MS),
        ]);
        setVerdict(data.genuine ? 'genuine' : 'fake');
      } catch {
        setVerdict(null);
        setFailed(true);
      }
    },
    [preview, publicId]
  );

  // A piece's printed QR carries its code: checked once, on arrival.
  useEffect(() => {
    if (!initialCode || preview || started.current) return;
    started.current = true;
    void check(initialCode);
  }, [initialCode, preview, check]);

  useEffect(() => {
    if (verdict && verdict !== 'checking' && !preview) verdictRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  }, [verdict, preview]);

  const onScan = useCallback(
    (scanned: string) => {
      setCode(scanned);
      void check(scanned);
      return 'جاري التحقق…';
    },
    [check]
  );

  const again = () => {
    if (initialCode && typeof window !== 'undefined') window.history.replaceState(null, '', window.location.pathname);
    setCode('');
    setVerdict(null);
  };

  const shown: Verdict = preview ? preview.verdict : verdict;
  const dark = isDarkColor(design.backgroundColor);
  const style = {
    ['--vp-p' as string]: design.primaryColor,
    ['--vp-bg' as string]: design.backgroundColor,
    ['--vp-on-p' as string]: isDarkColor(design.primaryColor) ? '#ffffff' : '#0b1220',
    ['--vp-ink' as string]: dark ? '#f1f5fb' : '#0f172a',
    ['--vp-mute' as string]: dark ? 'rgba(241,245,251,.7)' : '#5b6578',
  } as React.CSSProperties;

  return (
    <main className={`vp${dark ? ' vp-dark' : ''}${preview ? ' vp-pv' : ''}`} style={style}>
      <style>{PRODUCT_VERIFY_CSS}</style>
      <div className="vp-glow" aria-hidden />
      <div className="vp-wrap">
        <header className="vp-top">
          {design.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="vp-logo" src={design.logoUrl} alt="" />
          ) : (
            <span className="vp-mono" aria-hidden>
              {design.name.trim().charAt(0)}
            </span>
          )}
          <span className="vp-chip">
            <Shield /> تحقق من الأصالة
          </span>
        </header>

        <section className="vp-hero">
          {design.imageUrl && (
            <div className="vp-media">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={design.imageUrl} alt={design.name} />
            </div>
          )}
          <h1>{design.name}</h1>
          <p className="vp-head">{design.headline}</p>
        </section>

        <section className="vp-card" aria-labelledby="vp-check-title">
          <h2 id="vp-check-title">تحقق من قطعتك</h2>
          <p className="vp-sub">اكتب الرمز الموجود على القطعة، أو صوّره بالكاميرا.</p>
          <form
            className="vp-form"
            onSubmit={(e) => {
              e.preventDefault();
              void check(code);
            }}
          >
            <input
              className="vp-in"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="رمز القطعة"
              aria-label="رمز القطعة"
              maxLength={1000}
              autoComplete="off"
              spellCheck={false}
            />
            <Button className="vp-go" type="submit" disabled={!code.trim() || shown === 'checking'}>
              تحقق
            </Button>
          </form>
          {preview ? (
            <Button type="button" className="vp-cam" tabIndex={-1}>
              <Camera /> امسح بالكاميرا
            </Button>
          ) : (
            <ScanButton onScan={onScan} title="امسح الرمز الموجود على القطعة" label="امسح بالكاميرا" className="vp-cam" clean={cleanAnyScan} />
          )}
          {failed && <p className="vp-err">تعذّر التحقق الآن — تأكد من الاتصال وحاول مرة تانية.</p>}

          <div ref={verdictRef} role="status" aria-live="polite">
            {shown === 'checking' && (
              <div className="vp-checking">
                <span className="vp-spin" aria-hidden /> جاري التحقق…
              </div>
            )}
            {shown === 'genuine' && (
              <div className="vp-verdict vp-ok">
                <div className="vp-seal">
                  <Tick />
                </div>
                <h3>منتج أصلي</h3>
                <p>{design.genuineMessage}</p>
                <Button type="button" className="vp-again" onClick={again}>
                  تحقق من قطعة تانية
                </Button>
              </div>
            )}
            {shown === 'fake' && (
              <div className="vp-verdict vp-bad">
                <div className="vp-seal">
                  <Cross />
                </div>
                <h3>لم نتمكن من التأكد</h3>
                <p>{design.notGenuineMessage}</p>
                <Button type="button" className="vp-again" onClick={again}>
                  أعد المحاولة
                </Button>
              </div>
            )}
          </div>
        </section>

        {(design.description || design.features.length > 0) && (
          <section className="vp-card">
            <h2>عن المنتج</h2>
            {design.description && <p className="vp-desc">{design.description}</p>}
            {design.features.length > 0 && (
              <ul className="vp-feats">
                {design.features.map((f, i) => (
                  <li key={i}>
                    <i>
                      <Tick />
                    </i>
                    {f}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {(design.whatsappUrl || design.reorderUrl) && (
          <div className="vp-acts">
            {design.whatsappUrl && (
              <a className="vp-btn vp-wa" href={design.whatsappUrl} target="_blank" rel="noopener noreferrer">
                <WhatsApp /> تواصل معنا على واتساب
              </a>
            )}
            {design.reorderUrl && (
              <a className="vp-btn vp-re" href={design.reorderUrl} target={preview ? '_blank' : undefined} rel="noopener">
                <Bag /> اطلب مرة تانية
              </a>
            )}
          </div>
        )}

        <footer className="vp-foot">كل قطعة أصلية إلها رمز خاص — التحقق مجاني ومتاح دائماً.</footer>
      </div>
    </main>
  );
}
