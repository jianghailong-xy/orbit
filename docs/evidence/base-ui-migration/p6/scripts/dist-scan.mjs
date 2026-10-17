// What a production build ships of the component library: every asset under DIST, its size and gzip size, and
// the count of each signature the library leaves in built code. Run on the start tree's and the delivery's
// dist (vite build) to compare them.
//
// usage: node dist-scan.mjs DIST [DIST...]   (prints one JSON object per DIST)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

const SIGNATURES = {
  // The component library's own class names in CSS and JS (`.ant-btn`, "ant-modal-…"), its package name, and
  // its runtime: cssinjs and its style-tag marks, the App/ConfigProvider contexts, the message/notification holders.
  antClass: /(?<![\w@/-])ant-(?!design)[a-z][\w-]*/g,
  antdWord: /\bantd\b/g,
  cssinjs: /@ant-design\/cssinjs|data-css-hash|data-token-hash|useStyleRegister|css-var-/g,
  antPrefixDefault: /getPrefixCls|iconPrefixCls|rootPrefixCls/g,
  rcComponents: /rc-motion|rc-trigger|rc-virtual-list|rc-select|rc-dropdown|rc-dialog|rc-image|rc-tooltip|rc-menu/g,
  // What stays on purpose: the icons, their own injected style, and @rc-component/util's style-tag helper the
  // icons inject it with.
  anticon: /\banticon\b/g,
  iconsStyleId: /@ant-design-icons/g,
  rcUtilDynamicCss: /data-rc-order|data-rc-priority/g,
};

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});

for (const dist of process.argv.slice(2)) {
  const files = walk(dist).filter((path) => /\.(js|css|html)$/.test(path)).sort();
  const assets = files.map((path) => {
    const text = readFileSync(path, 'utf8');
    const counts = Object.fromEntries(Object.entries(SIGNATURES).map(([key, re]) => [key, (text.match(re) ?? []).length]));
    return { file: relative(dist, path).replace(/-[\w-]{8}\.(js|css)$/, '.$1'), bytes: Buffer.byteLength(text), gzip: gzipSync(text, { level: 9 }).length, counts };
  });
  const totals = Object.fromEntries(Object.keys(SIGNATURES).map((key) => [key, assets.reduce((sum, asset) => sum + asset.counts[key], 0)]));
  const sample = (re) => [...new Set(files.flatMap((path) => readFileSync(path, 'utf8').match(re) ?? []))].sort().slice(0, 40);
  console.log(JSON.stringify({ dist, totals, bytes: assets.reduce((s, a) => s + a.bytes, 0), gzip: assets.reduce((s, a) => s + a.gzip, 0),
    antClassSample: sample(SIGNATURES.antClass), assets }, null, 1));
}
