'use client';

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ScanButton } from '@/components/scan/ScanButton';
import { Button } from '@/components/ui/Button';
import { apiJson } from '@/lib/api-client';
import { isDarkColor, verifyPageBackground, type VerifyDesign } from '@/lib/product-verify-design';
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
 *
 * 25/11 (owner): «احترافية زي الصفحة القديمة» — dressed in the store-level checker's language (`VerifyBarcodeView`,
 * `/verify/<id>`): a night page with a grid, drifting glow and points of light, the shield inside orbit rings, a gold
 * camera call to action, a radar while checking and a seal for the verdict. Everything stays inside `.vp` and in the
 * normal flow (nothing pinned to the screen), so the same markup sits quietly inside the editor's preview box.
 *
 * Colours: the owner's `primaryColor` is the accent (glow, rings, ticks, the genuine card); `backgroundColor` only
 * tints the night — see `verifyPageBackground`.
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

/** Long enough for the radar to read as a check rather than a flicker; the answer itself is usually faster. */
const MIN_CHECK_MS = 1400;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Points of light behind the page — fixed, so the server and the browser draw the same markup. [left%, top%, size, delay, period] */
const DOTS = [
  [8, 6, 3, 1.3, 9.4], [53, 3, 4, 4.5, 8.3], [88, 12, 4.5, 1.5, 7.2], [92, 30, 2.4, 3.1, 10.5], [14, 22, 4.5, 2, 5.9],
  [30, 40, 3, 5.6, 8.3], [72, 48, 2.2, 1.6, 8.4], [6, 58, 3, 2.2, 7.5], [46, 66, 4, 3.8, 8.1], [84, 72, 3.4, 3.6, 5.8],
  [95, 86, 4, 1.6, 6.3], [22, 80, 3, 2, 7.3], [62, 92, 3.5, 0, 10.5], [36, 16, 2.6, 4.4, 7.9],
];

/** The genuine card's burst: [x px, y px, turn deg, delay s, colour 0–2]. */
const BURST = [
  [-120, -70, 220, 0, 0], [-90, -120, -160, 0.05, 1], [-40, -140, 300, 0.1, 2], [10, -150, -240, 0.02, 0],
  [60, -130, 180, 0.08, 1], [110, -100, -300, 0.04, 2], [140, -40, 260, 0.12, 0], [-150, -20, -200, 0.09, 1],
  [-70, -90, 140, 0.15, 2], [90, -60, -120, 0.14, 0], [-20, -110, 90, 0.06, 1], [30, -80, -80, 0.11, 2],
  [-130, 20, 160, 0.16, 0], [130, 30, -180, 0.07, 1],
];

const css = (vars: Record<string, string | number>) => vars as React.CSSProperties;

function Tick() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}
function Alert() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M12 7.5v6M12 17h.01M10.3 3.9L2.6 17.3A2 2 0 004.3 20.3h15.4a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
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
function Code() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M4 6v12M7 6v12M10.5 6v12M14 6v12M16.5 6v12M20 6v12" />
    </svg>
  );
}
function Lock() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 017 0v3" />
    </svg>
  );
}
function Info() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M12 3a9 9 0 100 18 9 9 0 000-18zM12 11v5M12 8h.01" />
    </svg>
  );
}
function Steps() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M4 7h10M4 12h16M4 17h7M17 4l3 3-3 3" />
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

/** The shield of the old page, in three tones: the owner's colour (hero), gold (genuine card), red (not genuine). */
function ShieldArt({ tone, id }: { tone: 'p' | 'gold' | 'red'; id: string }) {
  return (
    <svg viewBox="0 0 120 140" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" className={`vp-${tone}1`} />
          <stop offset=".55" className={`vp-${tone}2`} />
          <stop offset="1" className={`vp-${tone}3`} />
        </linearGradient>
      </defs>
      <path d="M60 4l50 20v40c0 34-22 60-50 72C32 124 10 98 10 64V24z" fill={`url(#${id})`} />
      <path d="M60 14l41 16.4V64c0 28-17.6 49-41 59-23.4-10-41-31-41-59V30.4z" fill="rgba(5,9,18,.55)" stroke="rgba(255,255,255,.35)" />
      {tone === 'red' ? (
        <path className="vp-draw" d="M44 52l32 32M76 52L44 84" fill="none" stroke="white" strokeWidth="9" strokeLinecap="round" />
      ) : (
        <path className="vp-draw" d="M38 66l15 15 30-33" fill="none" stroke="white" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

/** Text running round a circle (the orbit and the verdict's seal). */
function RingText({ id, text, className }: { id: string; text: string; className: string }) {
  return (
    <svg className={className} viewBox="0 0 100 100" aria-hidden>
      <defs>
        <path id={id} d="M50,50 m-42,0 a42,42 0 1,1 84,0 a42,42 0 1,1 -84,0" />
      </defs>
      <text>
        <textPath href={`#${id}`}>{text}</textPath>
      </text>
    </svg>
  );
}

export function ProductVerifyView({ design, publicId, initialCode, preview }: ProductVerifyViewProps) {
  const [code, setCode] = useState(initialCode ?? '');
  const [verdict, setVerdict] = useState<Verdict>(initialCode && !preview ? 'checking' : null);
  const [failed, setFailed] = useState(false);
  const started = useRef(false);
  const verdictRef = useRef<HTMLDivElement>(null);
  // SVG ids must be unique on a page and safe inside `url(#…)`.
  const uid = 'vp' + useId().replace(/[^a-zA-Z0-9_-]/g, '');

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
    if (verdict && !preview) verdictRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
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
  const style = css({
    '--vp-p': design.primaryColor,
    '--vp-base': verifyPageBackground(design.backgroundColor),
    '--vp-on-p': isDarkColor(design.primaryColor) ? '#ffffff' : '#0b1220',
  });
  const hasAbout = Boolean(design.description) || design.features.length > 0;
  let step = 0; // the entrance order of the blocks below, for their stagger
  const rise = (extra = '') => ({ className: `vp-rise${extra}`, style: css({ '--i': step++ }) });

  return (
    <main className={`vp${preview ? ' vp-pv' : ''}`} style={style}>
      <style>{PRODUCT_VERIFY_CSS}</style>

      <div className="vp-fx" aria-hidden>
        <div className="vp-grid" />
        <div className="vp-blob vp-b1" />
        <div className="vp-blob vp-b2" />
        <div className="vp-dots">
          {DOTS.map(([l, t, s, d, k], i) => (
            <i key={i} style={css({ '--l': `${l}%`, '--t': `${t}%`, '--s': `${s}px`, '--d': `${d}s`, '--k': `${k}s` })} />
          ))}
        </div>
      </div>

      <div className="vp-wrap">
        <header {...rise(' vp-top')}>
          {design.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="vp-logo" src={design.logoUrl} alt="" />
          ) : (
            <span className="vp-mono" aria-hidden>
              {design.name.trim().charAt(0)}
            </span>
          )}
          <span className="vp-chip">
            <b aria-hidden /> تحقق من الأصالة
          </span>
        </header>

        <section className="vp-hero">
          <div {...rise(' vp-stage')} aria-hidden>
            <div className="vp-halo" />
            <div className="vp-ring vp-r1" />
            <div className="vp-ring vp-r2" />
            <div className="vp-ring vp-r3" />
            <RingText id={`${uid}-orbit`} className="vp-orbit" text="ORIGINAL • GENUINE • AUTHENTIC • ORIGINAL • GENUINE • AUTHENTIC •" />
            {design.imageUrl ? (
              <>
                <div className="vp-frame">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={design.imageUrl} alt="" />
                </div>
                <span className="vp-badge">
                  <ShieldArt tone="p" id={`${uid}-badge`} />
                </span>
              </>
            ) : (
              <span className="vp-shield">
                <ShieldArt tone="p" id={`${uid}-hero`} />
              </span>
            )}
          </div>
          {design.imageUrl && <span className="vp-sr">{`صورة ${design.name}`}</span>}
          <p {...rise(' vp-pill')}>نظامك الذكي للتأكد من أصالة المنتج</p>
          <h1 {...rise(' vp-name')}>{design.name}</h1>
          <p {...rise(' vp-head')}>{design.headline}</p>
          <ul {...rise(' vp-trust')}>
            <li>
              <Tick /> فحص في ثوانٍ
            </li>
            <li>
              <Tick /> آمن وخاص
            </li>
            <li>
              <Tick /> متاح دائماً
            </li>
          </ul>
        </section>

        <section {...rise(' vp-card vp-check')} aria-labelledby={`${uid}-check`}>
          <h2 id={`${uid}-check`}>تحقق من قطعتك</h2>
          <p className="vp-sub">صوّر الرمز الموجود على القطعة بالكاميرا.</p>

          <div className="vp-cta">
            {preview ? (
              <Button type="button" className="vp-scan" tabIndex={-1}>
                <Camera /> امسح بالكاميرا
              </Button>
            ) : (
              <ScanButton onScan={onScan} title="امسح الرمز الموجود على القطعة" label="امسح بالكاميرا" className="vp-scan" clean={cleanAnyScan} />
            )}
          </div>

          <form
            className="vp-form"
            onSubmit={(e) => {
              e.preventDefault();
              void check(code);
            }}
          >
            <span className="vp-field">
              <Code />
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
            </span>
            <Button className="vp-go" type="submit" disabled={!code.trim() || shown === 'checking'}>
              تحقق
            </Button>
          </form>
          {failed && (
            <p className="vp-err">
              <Alert /> تعذّر التحقق الآن — تأكد من الاتصال وحاول مرة تانية.
            </p>
          )}

          <div ref={verdictRef} role="status" aria-live="polite">
            {shown === 'checking' && (
              <div className="vp-scanning">
                <div className="vp-radar" aria-hidden>
                  <i />
                  <i />
                  <i />
                </div>
                <p>جاري التحقق…</p>
                <div className="vp-bar" aria-hidden>
                  <b />
                </div>
              </div>
            )}
            {shown === 'genuine' && (
              <div className="vp-verdict vp-ok">
                <div className="vp-confetti" aria-hidden>
                  {BURST.map(([x, y, r, d, c], i) => (
                    <i key={i} className={`vp-c${c}`} style={css({ '--x': `${x}px`, '--y': `${y}px`, '--r': `${r}deg`, '--d': `${d}s` })} />
                  ))}
                </div>
                <div className="vp-seal" aria-hidden>
                  <span className="vp-rip" />
                  <span className="vp-rip" />
                  <RingText id={`${uid}-ok`} className="vp-sealtxt" text="ORIGINAL • GENUINE • AUTHENTIC • ORIGINAL • GENUINE • AUTHENTIC •" />
                  <span className="vp-sh">
                    <ShieldArt tone="gold" id={`${uid}-okg`} />
                  </span>
                </div>
                <h3>منتج أصلي</h3>
                <p>{design.genuineMessage}</p>
                <div className="vp-meta" aria-hidden>
                  <span>
                    <Tick /> تم التحقق
                  </span>
                  <span>
                    <Tick /> مسجّل لدينا
                  </span>
                </div>
                <Button type="button" className="vp-again" onClick={again}>
                  تحقق من قطعة تانية
                </Button>
              </div>
            )}
            {shown === 'fake' && (
              <div className="vp-verdict vp-bad">
                <div className="vp-seal" aria-hidden>
                  <span className="vp-rip" />
                  <RingText id={`${uid}-bad`} className="vp-sealtxt" text="NOT VERIFIED • NOT VERIFIED • NOT VERIFIED • NOT VERIFIED •" />
                  <span className="vp-sh">
                    <ShieldArt tone="red" id={`${uid}-badg`} />
                  </span>
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

        {hasAbout && (
          <section {...rise(' vp-card vp-reveal')} aria-labelledby={`${uid}-about`}>
            <h2 id={`${uid}-about`} className="vp-h">
              <i aria-hidden>
                <Info />
              </i>
              عن المنتج
            </h2>
            {design.description && <p className="vp-desc">{design.description}</p>}
            {design.features.length > 0 && (
              <ul className="vp-feats">
                {design.features.map((f, i) => (
                  <li key={i} style={css({ '--i': i })}>
                    <i aria-hidden>
                      <Tick />
                    </i>
                    {f}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <section {...rise(' vp-card vp-reveal')} aria-labelledby={`${uid}-how`}>
          <h2 id={`${uid}-how`} className="vp-h">
            <i aria-hidden>
              <Steps />
            </i>
            كيف يعمل؟
          </h2>
          <ol className="vp-steps">
            <li>
              <span className="vp-num" aria-hidden>
                1
              </span>
              <div>
                <h3>امسح الرمز</h3>
                <p>الرمز موجود على القطعة أو على علبتها.</p>
              </div>
            </li>
            <li>
              <span className="vp-num" aria-hidden>
                2
              </span>
              <div>
                <h3>نطابقه فوراً</h3>
                <p>مع سجل القطع الأصلية لهذا المنتج بالذات.</p>
              </div>
            </li>
            <li>
              <span className="vp-num" aria-hidden>
                3
              </span>
              <div>
                <h3>النتيجة خلال ثوانٍ</h3>
                <p>«أصلي» أو تنبيه واضح إذا ما قدرنا نتأكد.</p>
              </div>
            </li>
          </ol>
        </section>

        {(design.whatsappUrl || design.reorderUrl) && (
          <div {...rise(' vp-acts vp-reveal')}>
            {design.reorderUrl && (
              <a className="vp-btn vp-re" href={design.reorderUrl} target={preview ? '_blank' : undefined} rel="noopener">
                <Bag /> اطلب مرة تانية
              </a>
            )}
            {design.whatsappUrl && (
              <a className="vp-btn vp-wa" href={design.whatsappUrl} target="_blank" rel="noopener noreferrer">
                <WhatsApp /> تواصل معنا على واتساب
              </a>
            )}
          </div>
        )}

        <footer className="vp-foot">
          <Lock /> كل قطعة أصلية إلها رمز خاص — التحقق مجاني ومتاح دائماً.
        </footer>
      </div>
    </main>
  );
}
