/**
 * ONE SPRITE, AND EVERY GLYPH IN IT IS THE ONE OPERATIONS DRAWS.
 *
 * The studio is plain JavaScript with no bundler, so it cannot import a
 * React icon package — and a second icon set would mean the two products
 * disagree about what a «delete» looks like, which is the whole reason this
 * package exists.
 *
 * THE PATHS ARE NOT COPIED BY HAND. Each icon is RENDERED from the very
 * component operations uses (`@remixicon/react`) and its markup lifted out,
 * so a glyph in the sprite cannot differ from the glyph on the dashboard.
 * Hand-copied path data is the kind of thing that is wrong in one corner
 * and nobody sees it for a year.
 *
 * Run: node packages/zaki-ui/scripts/build-icons.mjs
 *
 * ZAKI_UI_ICONS_OUT=<folder> writes the two files THERE instead of beside the
 * package. A test that wants to know whether the build still produces what is
 * committed must not rewrite what is committed while other tests read it (RV38).
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as Remix from '@remixicon/react';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
/** Where the two files are written. Beside the package unless asked otherwise. */
const OUT = process.env.ZAKI_UI_ICONS_OUT ? resolve(process.env.ZAKI_UI_ICONS_OUT) : PKG;

/**
 * THE SET, AS THE OWNER NAMED IT — five groups, and the Remix face chosen
 * for each. `Line` throughout: the product's chrome is line icons, and the
 * `Fill` variants belong to the navigation, which is the app's own data and
 * not the shell's furniture.
 */
export const ICONS = {
  state: {
    check: 'RiCheckLine',
    close: 'RiCloseLine',
    'error-warning': 'RiErrorWarningLine',
    alert: 'RiAlertLine',
    information: 'RiInformationLine',
    loader: 'RiLoader4Line',
    lock: 'RiLockLine',
    'lock-unlock': 'RiLockUnlockLine',
  },
  nav: {
    'arrow-up': 'RiArrowUpLine',
    'arrow-down': 'RiArrowDownLine',
    'arrow-left': 'RiArrowLeftLine',
    'arrow-right': 'RiArrowRightLine',
    'chevron-up': 'RiArrowUpSLine',
    'chevron-down': 'RiArrowDownSLine',
    'chevron-left': 'RiArrowLeftSLine',
    'chevron-right': 'RiArrowRightSLine',
    'external-link': 'RiExternalLinkLine',
    menu: 'RiMenuLine',
  },
  action: {
    refresh: 'RiRefreshLine',
    search: 'RiSearchLine',
    filter: 'RiFilter3Line',
    settings: 'RiSettings3Line',
    edit: 'RiPencilLine',
    delete: 'RiDeleteBinLine',
    copy: 'RiFileCopyLine',
    download: 'RiDownloadLine',
    upload: 'RiUploadLine',
    eye: 'RiEyeLine',
    'eye-off': 'RiEyeOffLine',
  },
  media: {
    play: 'RiPlayLine',
    pause: 'RiPauseLine',
    stop: 'RiStopLine',
    volume: 'RiVolumeUpLine',
    mic: 'RiMicLine',
    image: 'RiImageLine',
    film: 'RiFilmLine',
    scissors: 'RiScissorsLine',
    music: 'RiMusic2Line',
  },
  subject: {
    user: 'RiUserLine',
    group: 'RiGroupLine',
    'bar-chart': 'RiBarChartLine',
    database: 'RiDatabase2Line',
    cloud: 'RiCloudLine',
    inbox: 'RiInboxLine',
    time: 'RiTimeLine',
    history: 'RiHistoryLine',
    rocket: 'RiRocketLine',
  },
};

/** What the icon package declares about its own terms. */
function licence() {
  const pkg = JSON.parse(readFileSync(resolve(PKG, '..', '..', 'node_modules', '@remixicon', 'react', 'package.json'), 'utf8'));
  return { name: pkg.license ?? '(undeclared)', version: pkg.version };
}

/**
 * Render one icon and take its insides.
 *
 * `currentColor` is what makes a sprite usable: the consumer sets `color`
 * and the glyph follows, so one file serves a dark palette and a light one
 * without a second copy.
 */
function symbolFor(id, componentName) {
  const Icon = Remix[componentName];
  if (typeof Icon !== 'function') return { id, componentName, error: 'NOT_IN_PACKAGE' };
  const html = renderToStaticMarkup(createElement(Icon, { size: 24 }));
  const viewBox = (html.match(/viewBox="([^"]+)"/) || [])[1];
  const inner = html.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  if (!viewBox || !inner.trim()) return { id, componentName, error: 'EMPTY_RENDER' };
  return { id, componentName, viewBox, inner: inner.replace(/fill="currentColor"/g, '') };
}

const built = [];
const missing = [];
for (const [group, set] of Object.entries(ICONS)) {
  for (const [name, componentName] of Object.entries(set)) {
    const sym = symbolFor(`zk-${name}`, componentName);
    if (sym.error) missing.push({ group, name, componentName, error: sym.error });
    else built.push({ group, name, ...sym });
  }
}

const lic = licence();
const sprite = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!--',
  '  zaki-ui icons — one sprite, rendered from @remixicon/react v' + lic.version + '.',
  '  Licence as the package declares it: ' + lic.name + '.',
  '',
  '  Every symbol paints with `currentColor`, so one file serves every theme.',
  '  Use: <svg class="zk-icon"><use href="icons.svg#zk-check"/></svg>',
  '-->',
  '<svg xmlns="http://www.w3.org/2000/svg" style="display:none">',
  ...built.map((s) => `  <symbol id="${s.id}" viewBox="${s.viewBox}" fill="currentColor">${s.inner}</symbol>`),
  '</svg>',
  '',
].join('\n');

writeFileSync(join(OUT, 'icons.svg'), sprite, 'utf8');

const index = {
  name: 'zaki-ui icons',
  from: '@remixicon/react',
  fromVersion: lic.version,
  licence: lic.name,
  usage: '<svg class="zk-icon" aria-hidden="true"><use href="icons.svg#zk-check"></use></svg>',
  count: built.length,
  groups: Object.fromEntries(
    Object.keys(ICONS).map((g) => [
      g,
      built.filter((b) => b.group === g).map((b) => ({ name: b.name, id: b.id, remix: b.componentName })),
    ])
  ),
  missing,
};
writeFileSync(join(OUT, 'icons.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');

console.log(`icons.svg + icons.json — ${built.length} symbols, ${Math.round(sprite.length / 1024)} KB`);
if (missing.length) {
  console.log('NOT FOUND in the package (no glyph written, nothing invented):');
  for (const m of missing) console.log(`  ${m.group}/${m.name} → ${m.componentName} (${m.error})`);
}
