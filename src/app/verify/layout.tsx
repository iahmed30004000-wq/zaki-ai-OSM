/**
 * THIS ROUTE'S OWN LOOK, AND NOTHING ELSE'S.
 *
 * `/verify/[id]` is reached with no session and no company context in the
 * browser, so it cannot sit under `(system)/layout.tsx` (its `system.css`
 * is the DASHBOARD's look — "its colours are --sys-*, and a store's are
 * --store-*, and neither family may appear in the other's files",
 * `theme-isolation.test.ts`). This page is neither: it is not a shop with a
 * seller's own colours, and it must not change because a logged-in staff
 * member picked a theme for their own dashboard.
 *
 * 19/11 (owner): the page wears the look of the owner's own landing page
 * «تحقق من أصالة منتجك» (`/lp/verify-original`): deep navy, the teal → blue →
 * violet gradient, a gold call to action, a shield that draws its tick, and
 * the Cairo face. Every rule is prefixed `vf-` so none of it can collide with
 * a utility class, and none of it is shared with any other page.
 *
 * The `--sys-*` NAMES are set only because the shared scanner
 * (`src/components/scan/ScanButton.tsx`) and `Modal` read them — the camera
 * sheet then opens in this page's dark palette. The VALUES are this page's
 * own and do not move when `system.css` does.
 *
 * Written as an inline `<style>` and not an imported stylesheet on purpose:
 * an imported `.css` becomes its own chunk under `.next/static` and is
 * counted by `quality-gates.test.ts`'s first-load stylesheet budget for
 * every visitor of every page. Inlined here, it travels only with this
 * page's own HTML.
 *
 * But Tailwind still READS this file: any bare word below that is also a
 * utility's name gets that utility generated into the shared stylesheet.
 * The CSS easing keyword for a slow finish did exactly that (+116 bytes over
 * the ceiling), so the curve is written out as `cubic-bezier(0,0,.2,1)`.
 * Keep such keywords out of this file, comments included.
 */
const STYLE = `
@font-face{font-family:'Cairo';font-style:normal;font-weight:400 900;font-display:swap;src:url(https://fonts.gstatic.com/s/cairo/v31/SLXVc1nY6HkvangtZmpQdkhzfH5lkSscQyyS4J0.woff2) format('woff2');unicode-range:U+0600-06FF,U+0750-077F,U+0870-08FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FEFC}
@font-face{font-family:'Cairo';font-style:normal;font-weight:400 900;font-display:swap;src:url(https://fonts.gstatic.com/s/cairo/v31/SLXVc1nY6HkvangtZmpQdkhzfH5lkSscRiyS.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2212,U+FEFF,U+FFFD}
:root{
  --sys-background:#050912;--sys-card:#0d1727;--sys-surface:#0a1220;
  --sys-border:rgba(255,255,255,.12);--sys-border-input:rgba(255,255,255,.18);--sys-destructive-border:rgba(255,93,108,.4);
  --sys-foreground:#eaf2ff;--sys-heading:#eaf2ff;--sys-muted:#8fa3bf;--sys-muted-foreground:#8fa3bf;
  --sys-primary:#19e0cf;--sys-primary-foreground:#04101c;
  --sys-success:#19e0cf;--sys-success-soft:rgba(25,224,207,.15);
  --sys-destructive:#ff5d6c;--sys-destructive-soft:rgba(255,93,108,.15);
  --vf-bg:#050912;--vf-bg2:#0a1220;--vf-card:#0d1727;--vf-line:rgba(255,255,255,.08);--vf-ink:#eaf2ff;--vf-mute:#8fa3bf;
  --vf-teal:#19e0cf;--vf-blue:#3b82f6;--vf-violet:#a855f7;--vf-gold:#ffc857;--vf-red:#ff5d6c;
  --vf-grad:linear-gradient(135deg,#19e0cf,#3b82f6 55%,#a855f7);
  --vf-gold-grad:linear-gradient(135deg,#fff1b8,#ffc857 45%,#f59e0b);
  --vf-red-grad:linear-gradient(135deg,#ffb4bc,#ff5d6c 50%,#c2185b);
}
html,body{background:#050912}
.vf{position:relative;min-height:100vh;overflow:hidden;background:var(--vf-bg);color:var(--vf-ink);font-family:'Cairo',Tahoma,'Segoe UI',system-ui,sans-serif;line-height:1.7;direction:rtl}
.vf *{box-sizing:border-box}
.vf-gridbg{position:absolute;inset:0;background-image:linear-gradient(var(--vf-line) 1px,transparent 1px),linear-gradient(90deg,var(--vf-line) 1px,transparent 1px);background-size:56px 56px;-webkit-mask-image:radial-gradient(ellipse at center,#000 20%,transparent 72%);mask-image:radial-gradient(ellipse at center,#000 20%,transparent 72%);pointer-events:none}
.vf-blob{position:absolute;border-radius:50%;filter:blur(90px);opacity:.5;animation:vf-drift 14s ease-in-out infinite;pointer-events:none}
.vf-b1{width:420px;height:420px;background:#19e0cf55;top:-120px;right:-120px}
.vf-b2{width:480px;height:480px;background:#a855f755;bottom:-200px;left:-160px;animation-delay:-5s}
.vf-dots i{position:absolute;left:var(--l);top:var(--t);width:var(--s);height:var(--s);border-radius:50%;background:var(--vf-teal);box-shadow:0 0 12px var(--vf-teal);opacity:.7;animation:vf-dot var(--k) ease-in-out var(--d) infinite;pointer-events:none}
.vf-wrap{position:relative;width:min(1080px,100% - 32px);margin-inline:auto}
.vf-hero{position:relative;min-height:100vh;display:flex;align-items:center;padding:56px 0 64px}
.vf-hero .vf-wrap{display:grid;grid-template-columns:1.05fr .95fr;gap:40px;align-items:center}
.vf-chip{display:inline-flex;align-items:center;gap:8px;padding:6px 16px;border:1px solid rgba(25,224,207,.35);border-radius:999px;background:rgba(25,224,207,.08);color:var(--vf-teal);font-weight:700;font-size:14px;margin-bottom:22px}
.vf-chip b{width:8px;height:8px;border-radius:50%;background:var(--vf-teal);animation:vf-blink 1.4s infinite}
.vf h1,.vf h2,.vf h3{margin:0;line-height:1.25;font-weight:900}
.vf-hero h1{font-size:clamp(34px,6vw,64px);margin-bottom:20px}
.vf-w{display:inline-block;opacity:0;transform:translateY(50px);animation:vf-word .9s cubic-bezier(.2,.8,.2,1) forwards;animation-delay:calc(var(--d)*110ms + 200ms)}
.vf-grad{background:var(--vf-grad);-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;background-size:200% 200%;animation:vf-flow 6s ease infinite}
.vf-lead{font-size:19px;color:var(--vf-mute);max-width:520px;margin:0 0 30px}
.vf-cta{display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-bottom:28px}
.vf-vwrap{position:relative;display:inline-block;border-radius:999px;isolation:isolate}
.vf-vwrap::before,.vf-vwrap::after{content:"";position:absolute;inset:0;border-radius:999px;border:2px solid var(--vf-gold);opacity:0;z-index:-1;animation:vf-ripple 2.6s cubic-bezier(0,0,.2,1) infinite;pointer-events:none}
.vf-vwrap::after{animation-delay:1.3s}
.vf .vf-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:10px;height:64px;min-width:220px;padding:0 42px;border:0;border-radius:999px;font:800 21px 'Cairo',Tahoma,sans-serif;color:#04101c;cursor:pointer;background:var(--vf-gold-grad);overflow:hidden;white-space:nowrap;animation:vf-glow 2.6s ease-in-out infinite}
.vf .vf-btn::after{content:"";position:absolute;inset:0;background:linear-gradient(110deg,transparent 30%,rgba(255,255,255,.7) 50%,transparent 70%);transform:translateX(120%);animation:vf-shine 3.2s infinite}
.vf .vf-btn svg{width:24px;height:24px}
.vf .vf-btn:hover{animation-play-state:paused}
.vf .vf-ghost{display:inline-flex;align-items:center;justify-content:center;height:52px;padding:0 28px;border-radius:999px;border:1px solid var(--vf-line);color:var(--vf-ink);font-weight:700;text-decoration:none}
.vf-trust{display:flex;gap:22px;flex-wrap:wrap;color:var(--vf-mute);font-size:15px;font-weight:600}
.vf-trust span{display:inline-flex;align-items:center;gap:8px}
.vf-trust svg{width:16px;height:16px;stroke:var(--vf-teal);fill:none;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
.vf-stage{position:relative;aspect-ratio:1;display:grid;place-items:center}
.vf-ring{position:absolute;border-radius:50%;border:1px dashed rgba(25,224,207,.35)}
.vf-ring::before{content:"";position:absolute;top:-5px;left:50%;width:10px;height:10px;border-radius:50%;background:var(--vf-teal);box-shadow:0 0 20px var(--vf-teal)}
.vf-r1{inset:2%;animation:vf-spin 40s linear infinite}
.vf-r2{inset:12%;border-color:rgba(168,85,247,.4);animation:vf-spin 28s linear infinite reverse}
.vf-r3{inset:22%;border-style:solid;border-color:rgba(255,200,87,.18);animation:vf-spin 60s linear infinite}
.vf-halo{position:absolute;width:62%;aspect-ratio:1;border-radius:50%;background:radial-gradient(circle,rgba(25,224,207,.45),transparent 68%);animation:vf-breathe 4s ease-in-out infinite}
.vf-orbit{position:absolute;inset:3%;width:94%;height:94%;animation:vf-spin 22s linear infinite}
.vf-orbit text{font:800 8.4px 'Cairo',sans-serif;fill:#ffe9a8;letter-spacing:2.4px}
.vf-shield{position:relative;display:block;width:52%;animation:vf-float 5s ease-in-out infinite}
.vf-shield svg{width:100%;display:block;filter:drop-shadow(0 30px 50px rgba(25,224,207,.35))}
.vf-tick{stroke-dasharray:90;stroke-dashoffset:90;animation:vf-draw 1.2s 1.2s forwards}
.vf-s1{stop-color:#19e0cf}.vf-s2{stop-color:#3b82f6}.vf-s3{stop-color:#a855f7}
.vf-r-s1{stop-color:#ffb4bc}.vf-r-s2{stop-color:#ff5d6c}.vf-r-s3{stop-color:#c2185b}
.vf-sec{position:relative;padding:72px 0;border-top:1px solid var(--vf-line);background:var(--vf-bg2)}
.vf-sec h2{font-size:clamp(26px,4.5vw,40px);text-align:center;margin-bottom:10px}
.vf-sub{text-align:center;color:var(--vf-mute);max-width:600px;margin:0 auto 40px;font-size:17px}
.vf-steps{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;position:relative}
.vf-steps::before{content:"";position:absolute;top:36px;inset-inline:16%;height:2px;background:linear-gradient(90deg,var(--vf-teal),var(--vf-blue),var(--vf-violet));opacity:.5}
.vf-step{text-align:center;position:relative}
.vf-num{width:72px;height:72px;margin:0 auto 16px;border-radius:50%;display:grid;place-items:center;font-size:30px;font-weight:900;background:var(--vf-bg);border:2px solid var(--vf-teal);box-shadow:0 0 30px rgba(25,224,207,.4);position:relative}
.vf-step h3{font-size:20px;margin-bottom:6px}
.vf-step p{color:var(--vf-mute);margin:0}
.vf-foot{padding:32px 0 40px;text-align:center;color:var(--vf-mute);border-top:1px solid var(--vf-line);font-size:14px}
.vf-ov{position:fixed;inset:0;z-index:100;display:grid;place-items:center;background:radial-gradient(ellipse at 50% 40%,#0b1a30,#02050c 75%);overflow:hidden}
.vf-ovgrid{position:absolute;inset:0;background-image:linear-gradient(rgba(25,224,207,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(25,224,207,.07) 1px,transparent 1px);background-size:44px 44px;-webkit-mask-image:radial-gradient(circle at center,#000,transparent 70%);mask-image:radial-gradient(circle at center,#000,transparent 70%)}
.vf-ph{position:relative;z-index:2;width:min(460px,100% - 32px);text-align:center;animation:vf-in .5s cubic-bezier(.2,1,.3,1) both}
.vf-radar{position:relative;width:min(220px,56vw);aspect-ratio:1;margin:0 auto 22px}
.vf-radar i{position:absolute;inset:0;border-radius:50%;border:1px solid rgba(25,224,207,.4)}
.vf-radar i:nth-child(2){inset:18%}.vf-radar i:nth-child(3){inset:36%}
.vf-radar::before{content:"";position:absolute;inset:0;border-radius:50%;background:conic-gradient(from 0deg,rgba(25,224,207,.55),transparent 28%);animation:vf-spin 1.6s linear infinite}
.vf-radar::after{content:"";position:absolute;inset:0;border-radius:50%;border:2px solid rgba(25,224,207,.8);box-shadow:0 0 40px rgba(25,224,207,.5),inset 0 0 40px rgba(25,224,207,.2)}
.vf-scanning{font-size:clamp(21px,5vw,26px);font-weight:900;margin:0 0 6px}
.vf-bar{height:6px;border-radius:6px;background:rgba(255,255,255,.1);margin:14px auto 0;max-width:300px;overflow:hidden}
.vf-bar b{display:block;height:100%;width:0;background:var(--vf-grad);animation:vf-fill 1.8s cubic-bezier(.3,.6,.3,1) forwards}
.vf-seal{position:relative;width:min(240px,62vw);aspect-ratio:1;margin:0 auto 18px;display:grid;place-items:center}
.vf-rip{position:absolute;inset:14%;border-radius:50%;border:2px solid var(--vf-teal);opacity:0;animation:vf-rip 2.4s cubic-bezier(0,0,.2,1) .4s infinite both}
.vf-rip:nth-child(2){animation-delay:1.2s}.vf-rip:nth-child(3){animation-delay:2s}
.vf-bad .vf-rip{border-color:var(--vf-red)}
.vf-sealtxt{position:absolute;inset:0;width:100%;height:100%;animation:vf-spin 20s linear infinite}
.vf-sealtxt text{font:800 8px 'Cairo',sans-serif;fill:#ffe9a8;letter-spacing:2.6px}
.vf-bad .vf-sealtxt text{fill:#ffc2c8}
.vf-sh{position:relative;width:56%;filter:drop-shadow(0 0 40px rgba(25,224,207,.7));animation:vf-slam .9s .1s cubic-bezier(.2,1.5,.3,1) both}
.vf-bad .vf-sh{filter:drop-shadow(0 0 40px rgba(255,93,108,.6))}
.vf-sh svg{width:100%;display:block}
.vf-mark{stroke-dasharray:90;stroke-dashoffset:90;animation:vf-draw .7s .7s forwards}
.vf-verdict{font-size:clamp(34px,9vw,50px);margin-bottom:6px;animation:vf-up .7s .85s both}
.vf-red{background:var(--vf-red-grad);-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent}
.vf-why{color:var(--vf-mute);margin:0 0 20px;animation:vf-up .7s 1s both}
.vf-meta{display:flex;justify-content:center;gap:10px;flex-wrap:wrap;margin-bottom:22px;animation:vf-up .7s 1.15s both}
.vf-meta span{padding:6px 14px;border-radius:999px;border:1px solid rgba(25,224,207,.35);background:rgba(25,224,207,.08);color:var(--vf-teal);font-weight:700;font-size:14px}
.vf-bad .vf-meta span{border-color:rgba(255,93,108,.35);background:rgba(255,93,108,.08);color:var(--vf-red)}
.vf-acts{display:grid;gap:10px;animation:vf-up .7s 1.3s both}
.vf-acts .vf-btn{width:100%;height:54px;font-size:18px}
.vf-err{margin:14px 0 0;color:var(--vf-red);font-weight:700}
@keyframes vf-flow{0%,100%{background-position:0 50%}50%{background-position:100% 50%}}
@keyframes vf-spin{to{transform:rotate(360deg)}}
@keyframes vf-drift{50%{transform:translate(30px,-40px) scale(1.12)}}
@keyframes vf-blink{50%{opacity:.2;transform:scale(.6)}}
@keyframes vf-dot{50%{transform:translate(18px,-26px);opacity:.15}}
@keyframes vf-word{to{opacity:1;transform:none}}
@keyframes vf-ripple{0%{transform:scale(1);opacity:.75}100%{transform:scale(1.2,1.6);opacity:0}}
@keyframes vf-glow{0%,100%{box-shadow:0 10px 40px -8px rgba(255,200,87,.55);transform:scale(1)}50%{box-shadow:0 16px 64px -4px rgba(255,200,87,.95);transform:scale(1.03)}}
@keyframes vf-shine{60%,100%{transform:translateX(-120%)}}
@keyframes vf-breathe{50%{transform:scale(1.2);opacity:.6}}
@keyframes vf-float{50%{transform:translateY(-16px)}}
@keyframes vf-draw{to{stroke-dashoffset:0}}
@keyframes vf-in{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:none}}
@keyframes vf-fill{to{width:100%}}
@keyframes vf-rip{0%{transform:scale(.7);opacity:.8}100%{transform:scale(1.5);opacity:0}}
@keyframes vf-slam{from{transform:scale(0) rotate(-30deg)}to{transform:none}}
@keyframes vf-up{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:none}}
@media(max-width:900px){
  .vf-hero{min-height:0;padding:24px 0 40px}
  .vf-hero .vf-wrap{grid-template-columns:1fr;text-align:center;gap:8px}
  .vf-stage{width:min(170px,44vw);margin-inline:auto;order:-1}
  .vf-chip{font-size:12px;padding:4px 12px;margin-bottom:12px}
  .vf-hero h1{font-size:clamp(28px,8.5vw,40px);margin-bottom:12px}
  .vf-lead{margin-inline:auto;font-size:15px;line-height:1.65;margin-bottom:20px}
  .vf-cta,.vf-trust{justify-content:center}
  .vf-cta .vf-vwrap{display:block;width:100%}
  .vf .vf-cta .vf-btn{width:100%;height:58px;font-size:19px}
  .vf-trust{gap:12px;font-size:13px}
  .vf-sec{padding:44px 0}
  .vf-steps{grid-template-columns:1fr}
  .vf-steps::before{display:none}
}
@media(prefers-reduced-motion:reduce){
  .vf *,.vf *::before,.vf *::after{animation-duration:.01ms!important;animation-delay:0s!important;animation-iteration-count:1!important}
  .vf-w{opacity:1;transform:none}
}
`;

export default function VerifyLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style>{STYLE}</style>
      {children}
    </>
  );
}
