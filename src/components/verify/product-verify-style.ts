/**
 * THE LOOK OF A PRODUCT'S OWN PAGE (`/v/<slug>`), AND OF ITS PREVIEW IN THE OWNER'S EDITOR.
 *
 * One string, drawn by `ProductVerifyView` itself in a `<style>`, so the public page and the live preview inside the
 * dashboard wear exactly the same rules. Every rule sits under `.vp` — nothing here can reach the dashboard around the
 * preview. The owner's colours arrive as custom properties on the root (`--vp-p` the accent, `--vp-base` the night it is
 * drawn on, `--vp-on-p` text on the accent), set from validated `#rrggbb` values only.
 *
 * 25/11 (owner): the language of the store-level checker (`src/app/verify/layout.tsx`, `vf-`): deep night, a masked
 * grid, drifting glow, points of light, the shield inside dashed orbit rings, a gold call to action with ripples and a
 * shine, a radar while checking, a seal for the verdict. The teal of that page is the owner's `--vp-p` here; the gold
 * and the violet are kept as they are. Nothing is `position:fixed` — the page must also sit inside the editor's box.
 *
 * Motion: entrances are staggered by `--i`; the blocks below the fold reveal on scroll where the browser has scroll
 * timelines (`@supports`), and simply rise on load elsewhere. `prefers-reduced-motion` stops every animation and leaves
 * each element in its final state.
 *
 * Not an imported `.css`: that would be a chunk of its own counted by the first-load stylesheet budget for every
 * visitor of every page. And this FILE is excluded from Tailwind's scan (`@source not` in `globals.css`), so no word in
 * the rules below can grow the shared utility sheet.
 */
export const PRODUCT_VERIFY_CSS = `
.vp{--vp-pl:color-mix(in srgb,var(--vp-p) 45%,#fff);--vp-pd:color-mix(in srgb,var(--vp-p) 60%,#000);
  --vp-ink:#eef4ff;--vp-mute:#9fb0c8;--vp-line:rgba(255,255,255,.09);
  --vp-gold:#ffc857;--vp-gold-grad:linear-gradient(135deg,#fff1b8,#ffc857 45%,#f59e0b);--vp-red:#ff6b78;
  position:relative;isolation:isolate;min-height:100vh;background:var(--vp-base);color:var(--vp-ink);direction:rtl;
  font-family:'Cairo',Tahoma,'Segoe UI',system-ui,sans-serif;line-height:1.7;padding:0 0 36px;overflow:hidden;
  -webkit-font-smoothing:antialiased}
.vp *{box-sizing:border-box}
.vp.vp-pv{min-height:0}
.vp h1,.vp h2,.vp h3{margin:0;line-height:1.3;font-weight:900}
.vp p{margin:0}
.vp a:focus-visible,.vp button:focus-visible,.vp input:focus-visible{outline:3px solid var(--vp-pl);outline-offset:3px}
.vp-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

/* the night behind everything */
.vp-fx{position:absolute;inset:0;z-index:-1;pointer-events:none;overflow:hidden}
.vp-grid{position:absolute;inset:0 0 auto;height:820px;background-image:linear-gradient(var(--vp-line) 1px,transparent 1px),linear-gradient(90deg,var(--vp-line) 1px,transparent 1px);background-size:44px 44px;-webkit-mask-image:radial-gradient(ellipse 75% 55% at 50% 28%,#000 15%,transparent 75%);mask-image:radial-gradient(ellipse 75% 55% at 50% 28%,#000 15%,transparent 75%)}
.vp-blob{position:absolute;border-radius:50%;filter:blur(80px);opacity:.5;animation:vp-drift 14s ease-in-out infinite}
.vp-b1{width:380px;height:380px;top:-150px;right:-150px;background:color-mix(in srgb,var(--vp-p) 55%,transparent)}
.vp-b2{width:440px;height:440px;top:460px;left:-240px;background:rgba(168,85,247,.3);animation-delay:-6s}
.vp-dots i{position:absolute;left:var(--l);top:var(--t);width:var(--s);height:var(--s);border-radius:50%;background:var(--vp-pl);box-shadow:0 0 12px var(--vp-pl);opacity:.6;animation:vp-dot var(--k) ease-in-out var(--d) infinite}

.vp-wrap{position:relative;width:min(560px,100% - 28px);margin-inline:auto}
.vp-rise{animation:vp-rise .75s cubic-bezier(.2,.8,.2,1) both;animation-delay:calc(var(--i,0) * 90ms + 60ms)}

/* top bar */
.vp-top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 0 4px}
.vp-logo{height:38px;max-width:150px;object-fit:contain;filter:drop-shadow(0 4px 14px rgba(0,0,0,.45))}
.vp-mono{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;font-weight:900;font-size:18px;background:var(--vp-p);color:var(--vp-on-p);box-shadow:0 8px 26px -8px var(--vp-p),inset 0 1px 0 rgba(255,255,255,.25)}
.vp-chip{display:inline-flex;align-items:center;gap:8px;padding:5px 14px;border-radius:999px;font-size:13px;font-weight:700;color:var(--vp-pl);background:color-mix(in srgb,var(--vp-p) 12%,transparent);border:1px solid color-mix(in srgb,var(--vp-p) 40%,transparent)}
.vp-chip b{width:7px;height:7px;border-radius:50%;background:var(--vp-pl);box-shadow:0 0 8px var(--vp-pl);animation:vp-blink 1.4s infinite}

/* hero: the stage, the product, its name */
.vp-hero{text-align:center}
.vp-stage{position:relative;width:min(300px,80vw);aspect-ratio:1;margin:4px auto 0;display:grid;place-items:center}
.vp-pv .vp-stage{width:min(280px,80%)}
.vp-halo{position:absolute;width:66%;aspect-ratio:1;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--vp-p) 60%,transparent),transparent 68%);animation:vp-breathe 4s ease-in-out infinite}
.vp-ring{position:absolute;border-radius:50%;border:1px dashed color-mix(in srgb,var(--vp-pl) 42%,transparent)}
.vp-ring::before{content:"";position:absolute;top:-4px;left:50%;width:8px;height:8px;margin-left:-4px;border-radius:50%;background:var(--vp-pl);box-shadow:0 0 16px var(--vp-pl)}
.vp-r1{inset:1%;animation:vp-spin 40s linear infinite}
.vp-r2{inset:11%;border-color:rgba(168,85,247,.4);animation:vp-spin 28s linear infinite reverse}
.vp-r2::before{background:#c084fc;box-shadow:0 0 16px #c084fc}
.vp-r3{inset:21%;border-style:solid;border-color:rgba(255,200,87,.2);animation:vp-spin 60s linear infinite}
.vp-r3::before{background:var(--vp-gold);box-shadow:0 0 16px var(--vp-gold)}
.vp-orbit{position:absolute;inset:2%;width:96%;height:96%;animation:vp-spin 24s linear infinite}
.vp-orbit text{font:800 7.6px 'Cairo',sans-serif;fill:#ffe9a8;letter-spacing:2.3px;opacity:.85}
.vp-shield{position:relative;display:block;width:50%;animation:vp-float 5s ease-in-out infinite}
.vp-shield svg,.vp-badge svg,.vp-sh svg{width:100%;display:block}
.vp-shield svg{filter:drop-shadow(0 26px 44px color-mix(in srgb,var(--vp-p) 45%,transparent))}
.vp-frame{position:relative;width:56%;aspect-ratio:1;border-radius:30%;overflow:hidden;display:grid;place-items:center;animation:vp-float 5s ease-in-out infinite;box-shadow:0 26px 60px -18px color-mix(in srgb,var(--vp-p) 75%,transparent),0 0 0 6px rgba(255,255,255,.03)}
.vp-frame::before{content:"";position:absolute;inset:-40%;background:conic-gradient(var(--vp-pl),var(--vp-gold),#a855f7,var(--vp-p),var(--vp-pl));animation:vp-spin 6s linear infinite}
.vp-frame img{position:relative;width:calc(100% - 6px);height:calc(100% - 6px);object-fit:cover;border-radius:29%;background:#0b1424}
.vp-badge{position:absolute;left:18%;bottom:15%;width:20%;filter:drop-shadow(0 8px 16px rgba(0,0,0,.5));animation:vp-slam .8s .9s cubic-bezier(.2,1.5,.3,1) both}
.vp-p1{stop-color:var(--vp-pl)}.vp-p2{stop-color:var(--vp-p)}.vp-p3{stop-color:#a855f7}
.vp-gold1{stop-color:#fff1b8}.vp-gold2{stop-color:#ffc857}.vp-gold3{stop-color:#f59e0b}
.vp-red1{stop-color:#ffb4bc}.vp-red2{stop-color:#ff5d6c}.vp-red3{stop-color:#c2185b}
.vp-draw{stroke-dasharray:90;stroke-dashoffset:90;animation:vp-draw .9s 1.1s forwards}
.vp-pill{display:inline-flex;align-items:center;margin-top:6px;padding:5px 16px;border-radius:999px;border:1px solid rgba(255,200,87,.35);background:rgba(255,200,87,.08);color:#ffe3a1;font-size:13px;font-weight:700}
.vp .vp-name{margin-top:12px;font-size:clamp(27px,7.4vw,38px);text-shadow:0 6px 30px color-mix(in srgb,var(--vp-p) 45%,transparent)}
.vp .vp-head{margin:8px auto 0;max-width:440px;color:var(--vp-mute);font-size:16px}
.vp-trust{display:flex;justify-content:center;flex-wrap:wrap;gap:8px 18px;margin:16px 0 0;padding:0;list-style:none;color:var(--vp-mute);font-size:13.5px;font-weight:600}
.vp-trust li{display:inline-flex;align-items:center;gap:6px}
.vp-trust svg{width:15px;height:15px;fill:none;stroke:var(--vp-pl);stroke-width:3;stroke-linecap:round;stroke-linejoin:round}

/* cards */
.vp-card{position:relative;margin-top:22px;padding:22px 18px;border-radius:24px;background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.025));border:1px solid var(--vp-line);box-shadow:0 30px 60px -36px rgba(0,0,0,.85),inset 0 1px 0 rgba(255,255,255,.06);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
.vp-check{border-color:transparent}
.vp-check::before{content:"";position:absolute;inset:-1px;border-radius:inherit;padding:1px;background:linear-gradient(135deg,color-mix(in srgb,var(--vp-p) 80%,transparent),rgba(255,255,255,.08) 38%,rgba(255,255,255,.08) 62%,rgba(255,200,87,.55));-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude;pointer-events:none}
.vp-card h2{font-size:20px}
.vp .vp-sub{margin-top:4px;color:var(--vp-mute);font-size:14px}
.vp-h{display:flex;align-items:center;gap:10px}
.vp-h i{flex:none;width:34px;height:34px;border-radius:11px;display:grid;place-items:center;background:color-mix(in srgb,var(--vp-p) 18%,transparent);color:var(--vp-pl);border:1px solid color-mix(in srgb,var(--vp-p) 35%,transparent)}
.vp-h svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}

/* the check */
.vp-cta{position:relative;margin-top:18px;border-radius:18px;isolation:isolate}
.vp-cta::before,.vp-cta::after{content:"";position:absolute;inset:0;border-radius:inherit;border:2px solid var(--vp-gold);opacity:0;z-index:-1;animation:vp-ripple 2.6s cubic-bezier(0,0,.2,1) infinite;pointer-events:none}
.vp-cta::after{animation-delay:1.3s}
.vp .vp-scan{position:relative;display:flex;align-items:center;justify-content:center;gap:10px;width:100%;height:60px;padding:0 18px;border:0;border-radius:18px;background:var(--vp-gold-grad);color:#1a1204;font:800 18px 'Cairo',Tahoma,sans-serif;cursor:pointer;overflow:hidden;box-shadow:0 12px 36px -10px rgba(255,200,87,.65);transition:transform .2s,box-shadow .2s}
.vp .vp-scan::after{content:"";position:absolute;inset:0;background:linear-gradient(110deg,transparent 30%,rgba(255,255,255,.7) 50%,transparent 70%);transform:translateX(120%);animation:vp-shine 3.2s infinite;pointer-events:none}
.vp .vp-scan:hover{transform:translateY(-2px);box-shadow:0 18px 44px -10px rgba(255,200,87,.85);background:var(--vp-gold-grad)}
.vp .vp-scan:active{transform:scale(.98)}
.vp .vp-scan svg{width:24px;height:24px;fill:currentColor}
.vp .vp-scan span{gap:10px}
.vp-form{display:flex;gap:8px;margin-top:14px}
.vp-field{position:relative;flex:1;min-width:0}
.vp-field svg{position:absolute;left:14px;top:50%;width:20px;height:20px;margin-top:-10px;fill:none;stroke:var(--vp-mute);stroke-width:1.8;stroke-linecap:round;pointer-events:none}
.vp-in{width:100%;height:54px;border-radius:15px;border:1.5px solid rgba(255,255,255,.14);background:rgba(3,7,15,.55);color:var(--vp-ink);padding:0 14px 0 44px;font:700 17px 'Cairo',Tahoma,sans-serif;letter-spacing:.05em;direction:ltr;text-align:left;transition:border-color .2s,box-shadow .2s}
.vp-in::placeholder{color:rgba(159,176,200,.65);letter-spacing:0;font-weight:600}
.vp .vp-in:focus{outline:none;border-color:var(--vp-pl);box-shadow:0 0 0 4px color-mix(in srgb,var(--vp-p) 30%,transparent)}
.vp .vp-go{height:54px;padding:0 24px;border:0;border-radius:15px;background:var(--vp-p);color:var(--vp-on-p);font:800 16px 'Cairo',Tahoma,sans-serif;cursor:pointer;white-space:nowrap;box-shadow:inset 0 1px 0 rgba(255,255,255,.25),0 10px 26px -10px var(--vp-p);transition:transform .2s,filter .2s}
.vp .vp-go:hover{background:var(--vp-p);filter:brightness(1.1);transform:translateY(-1px)}
.vp .vp-go:disabled{opacity:.5;cursor:default;transform:none;filter:none}
.vp .vp-err{display:flex;align-items:center;gap:8px;margin-top:12px;padding:10px 12px;border-radius:12px;background:rgba(255,93,108,.1);color:var(--vp-red);font-weight:700;font-size:14px;animation:vp-pop .35s both}
.vp-err svg{flex:none;width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}

/* checking: the radar */
.vp-scanning{margin-top:20px;padding:22px 16px 20px;border-radius:20px;text-align:center;background:rgba(3,7,15,.5);border:1px solid color-mix(in srgb,var(--vp-p) 32%,transparent);animation:vp-pop .4s both}
.vp-radar{position:relative;width:124px;aspect-ratio:1;margin:0 auto 12px}
.vp-radar i{position:absolute;inset:0;border-radius:50%;border:1px solid color-mix(in srgb,var(--vp-pl) 40%,transparent)}
.vp-radar i:nth-child(2){inset:20%}
.vp-radar i:nth-child(3){inset:45%;background:var(--vp-pl);box-shadow:0 0 18px var(--vp-pl);border:0}
.vp-radar::before{content:"";position:absolute;inset:0;border-radius:50%;background:conic-gradient(from 0deg,color-mix(in srgb,var(--vp-pl) 60%,transparent),transparent 28%);animation:vp-spin 1.4s linear infinite}
.vp-radar::after{content:"";position:absolute;inset:0;border-radius:50%;border:2px solid color-mix(in srgb,var(--vp-pl) 80%,transparent);box-shadow:0 0 36px color-mix(in srgb,var(--vp-p) 55%,transparent),inset 0 0 30px color-mix(in srgb,var(--vp-p) 25%,transparent)}
.vp-scanning p{font-weight:800;font-size:17px}
.vp-bar{height:5px;border-radius:5px;background:rgba(255,255,255,.08);margin:12px auto 0;max-width:240px;overflow:hidden}
.vp-bar b{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--vp-p),var(--vp-gold));animation:vp-fill 1.4s cubic-bezier(.3,.6,.3,1) forwards}

/* the verdict */
.vp-verdict{position:relative;margin-top:20px;padding:22px 18px;border-radius:22px;text-align:center;overflow:hidden;animation:vp-pop .55s cubic-bezier(.2,1.2,.3,1) both}
.vp-ok{background:radial-gradient(120% 90% at 50% 0%,color-mix(in srgb,var(--vp-p) 88%,#fff),var(--vp-p) 45%,var(--vp-pd));color:var(--vp-on-p);box-shadow:0 30px 70px -26px var(--vp-p),inset 0 1px 0 rgba(255,255,255,.3)}
.vp-bad{background:linear-gradient(180deg,rgba(255,93,108,.15),rgba(255,93,108,.05));border:1.5px solid rgba(255,107,120,.42);color:#ffd5da}
.vp-seal{position:relative;width:150px;aspect-ratio:1;margin:0 auto 8px;display:grid;place-items:center}
.vp-rip{position:absolute;inset:18%;border-radius:50%;border:2px solid currentColor;opacity:0;animation:vp-rip 2.4s cubic-bezier(0,0,.2,1) .4s infinite both}
.vp-rip:nth-child(2){animation-delay:1.6s}
.vp-bad .vp-rip{border-color:var(--vp-red);animation-duration:3.2s}
.vp-sealtxt{position:absolute;inset:0;width:100%;height:100%;animation:vp-spin 20s linear infinite}
.vp-sealtxt text{font:800 8px 'Cairo',sans-serif;fill:currentColor;letter-spacing:2.4px;opacity:.75}
.vp-bad .vp-sealtxt{animation-duration:40s}
.vp-bad .vp-sealtxt text{fill:#ffc2c8;opacity:.6}
.vp-sh{position:relative;width:52%;filter:drop-shadow(0 12px 24px rgba(0,0,0,.35));animation:vp-slam .8s .1s cubic-bezier(.2,1.5,.3,1) both}
.vp-bad .vp-sh{filter:drop-shadow(0 0 26px rgba(255,93,108,.45));animation:vp-pop .6s .1s cubic-bezier(.2,1,.3,1) both}
.vp-verdict .vp-draw{animation-delay:.55s;animation-duration:.6s}
.vp-verdict h3{font-size:clamp(26px,7.5vw,32px);margin-bottom:6px;animation:vp-up .6s .5s both}
.vp-bad h3{color:var(--vp-red)}
.vp-verdict p{margin:0 auto;max-width:400px;font-size:15.5px;animation:vp-up .6s .65s both}
.vp-meta{display:flex;justify-content:center;gap:8px;flex-wrap:wrap;margin-top:14px;animation:vp-up .6s .78s both}
.vp-meta span{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:999px;font-size:13px;font-weight:800;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.3)}
.vp-meta svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
.vp .vp-again{margin-top:16px;height:44px;padding:0 20px;border-radius:13px;border:1.5px solid currentColor;background:rgba(255,255,255,.08);color:inherit;font:800 14.5px 'Cairo',Tahoma,sans-serif;cursor:pointer;animation:vp-up .6s .9s both;transition:background .2s,transform .2s}
.vp .vp-again:hover{background:rgba(255,255,255,.18);transform:translateY(-1px)}
.vp-confetti{position:absolute;left:50%;top:92px;width:0;height:0;pointer-events:none}
.vp-confetti i{position:absolute;width:7px;height:12px;border-radius:2px;opacity:0;animation:vp-burst 1.5s calc(var(--d) + .45s) cubic-bezier(.15,.8,.3,1) both}
.vp-c0{background:#fff}.vp-c1{background:var(--vp-gold)}.vp-c2{background:var(--vp-pl)}

/* about the product */
.vp .vp-desc{margin-top:12px;white-space:pre-line;color:#d5deec;font-size:15.5px}
.vp-feats{list-style:none;margin:14px 0 0;padding:0;display:grid;gap:10px}
.vp-feats li{display:flex;gap:12px;align-items:center;padding:11px 14px;border-radius:14px;background:rgba(255,255,255,.035);border:1px solid var(--vp-line);font-size:15px;font-weight:700;transition:transform .2s,border-color .2s,background .2s}
.vp-feats li:hover{transform:translateX(-4px);border-color:color-mix(in srgb,var(--vp-p) 45%,transparent);background:color-mix(in srgb,var(--vp-p) 8%,transparent)}
.vp-feats i{flex:none;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:var(--vp-p);color:var(--vp-on-p);box-shadow:0 0 0 4px color-mix(in srgb,var(--vp-p) 20%,transparent);animation:vp-popin .5s calc(var(--i) * 110ms + .3s) cubic-bezier(.2,1.6,.3,1) both}
.vp-feats svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
.vp-feats path{stroke-dasharray:24;stroke-dashoffset:24;animation:vp-draw .45s calc(var(--i) * 110ms + .6s) forwards}

/* how it works */
.vp-steps{position:relative;list-style:none;margin:16px 0 0;padding:0;display:grid;gap:16px}
.vp-steps::before{content:"";position:absolute;top:22px;bottom:22px;inset-inline-start:21px;width:2px;background:linear-gradient(180deg,var(--vp-p),#a855f7,var(--vp-gold));opacity:.55}
.vp-steps li{position:relative;display:flex;gap:14px;align-items:flex-start}
.vp-num{flex:none;position:relative;width:44px;height:44px;border-radius:50%;display:grid;place-items:center;font-weight:900;font-size:18px;background:var(--vp-base);border:2px solid var(--vp-pl);color:var(--vp-ink);box-shadow:0 0 22px color-mix(in srgb,var(--vp-p) 50%,transparent);transition:transform .25s}
.vp-steps li:hover .vp-num{transform:scale(1.08)}
.vp-steps h3{font-size:16.5px;margin:3px 0 2px}
.vp-steps p{color:var(--vp-mute);font-size:14px}

/* the two actions */
.vp-acts{display:grid;gap:12px;margin-top:22px}
.vp .vp-btn{position:relative;display:flex;align-items:center;justify-content:center;gap:10px;height:58px;border-radius:18px;font:800 17px 'Cairo',Tahoma,sans-serif;text-decoration:none;cursor:pointer;overflow:hidden;transition:transform .2s,box-shadow .2s,background .2s}
.vp .vp-btn:hover{transform:translateY(-2px)}
.vp .vp-btn:active{transform:scale(.98)}
.vp .vp-btn svg{width:22px;height:22px}
.vp .vp-re{background:var(--vp-gold-grad);color:#1a1204;box-shadow:0 14px 36px -12px rgba(255,200,87,.7);animation:vp-glow 2.8s ease-in-out infinite}
.vp .vp-re::after{content:"";position:absolute;inset:0;background:linear-gradient(110deg,transparent 30%,rgba(255,255,255,.65) 50%,transparent 70%);transform:translateX(120%);animation:vp-shine 3.6s 1s infinite;pointer-events:none}
.vp .vp-re svg{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.vp .vp-wa{background:rgba(37,211,102,.1);color:#6ee7a0;border:1.5px solid rgba(37,211,102,.45)}
.vp .vp-wa:hover{background:rgba(37,211,102,.18)}
.vp .vp-wa svg{fill:currentColor}

.vp-foot{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:28px;color:var(--vp-mute);font-size:12.5px;text-align:center}
.vp-foot svg{flex:none;width:15px;height:15px;fill:none;stroke:var(--vp-pl);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}

@keyframes vp-rise{from{opacity:0;transform:translateY(22px)}to{opacity:1;transform:none}}
@keyframes vp-drift{50%{transform:translate(30px,-40px) scale(1.12)}}
@keyframes vp-dot{50%{transform:translate(16px,-24px);opacity:.15}}
@keyframes vp-blink{50%{opacity:.2;transform:scale(.6)}}
@keyframes vp-spin{to{transform:rotate(360deg)}}
@keyframes vp-breathe{50%{transform:scale(1.18);opacity:.65}}
@keyframes vp-float{50%{transform:translateY(-12px)}}
@keyframes vp-draw{to{stroke-dashoffset:0}}
@keyframes vp-ripple{0%{transform:scale(1);opacity:.7}100%{transform:scale(1.06,1.45);opacity:0}}
@keyframes vp-shine{60%,100%{transform:translateX(-120%)}}
@keyframes vp-glow{0%,100%{box-shadow:0 12px 34px -12px rgba(255,200,87,.55)}50%{box-shadow:0 16px 50px -8px rgba(255,200,87,.9)}}
@keyframes vp-pop{from{opacity:0;transform:translateY(12px) scale(.96)}to{opacity:1;transform:none}}
@keyframes vp-popin{from{opacity:0;transform:scale(0)}to{opacity:1;transform:none}}
@keyframes vp-up{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
@keyframes vp-fill{to{width:100%}}
@keyframes vp-rip{0%{transform:scale(.75);opacity:.8}100%{transform:scale(1.5);opacity:0}}
@keyframes vp-slam{from{transform:scale(0) rotate(-30deg)}to{transform:none}}
@keyframes vp-burst{0%{opacity:1;transform:translate(0,0) rotate(0)}80%{opacity:1}100%{opacity:0;transform:translate(var(--x),calc(var(--y) + 120px)) rotate(var(--r))}}

@supports (animation-timeline:view()){
  .vp-reveal{animation:vp-rise linear both;animation-timeline:view();animation-range:entry 0% entry 70%}
}
@media(min-width:760px){
  .vp-wrap{width:min(600px,100% - 48px)}
  .vp-top{padding-top:28px}
  .vp-card{padding:26px 24px}
}
@media(prefers-reduced-motion:reduce){
  .vp *,.vp *::before,.vp *::after{animation:none!important;transition:none!important}
  .vp-draw,.vp-feats path{stroke-dashoffset:0}
  .vp-bar b{width:100%}
  .vp-confetti,.vp-rip,.vp-cta::before,.vp-cta::after,.vp .vp-scan::after,.vp .vp-re::after{display:none}
}
`;
