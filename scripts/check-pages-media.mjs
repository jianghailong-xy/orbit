import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(process.argv[2] || "dist/pages");
const repository = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

// The public-site screenshots are byte-identical copies of the onboarding evidence set.
// Refreshing the evidence must refresh the site media rather than letting the two drift.
const screenshotSources = new Map([
  ["screenshot-task-graph.png", "docs/images/onboarding/05-task-graph.png"],
  ["screenshot-runner.png", "docs/images/onboarding/03-first-workspace.png"],
  ["screenshot-approval.png", "docs/images/onboarding/06-approval.png"],
  ["screenshot-result.png", "docs/images/onboarding/04-session.png"],
]);

function pngSize(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.length < 24 || bytes.toString("ascii", 1, 4) !== "PNG") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const social = path.join(root, "assets/social/og-image.png");
const socialSize = fs.existsSync(social) ? pngSize(social) : null;
if (!socialSize) {
  errors.push("assets/social/og-image.png: missing or not a PNG");
} else if (socialSize.width !== 1200 || socialSize.height !== 630) {
  errors.push(`assets/social/og-image.png: expected 1200x630, got ${socialSize.width}x${socialSize.height}`);
}

for (const [file, source] of screenshotSources) {
  const media = path.join(root, "assets/product", file);
  const evidence = path.join(repository, source);
  if (!fs.existsSync(media)) {
    errors.push(`assets/product/${file}: missing`);
    continue;
  }
  if (!pngSize(media)) {
    errors.push(`assets/product/${file}: not a PNG`);
    continue;
  }
  if (!fs.existsSync(evidence)) {
    errors.push(`assets/product/${file}: evidence source ${source} is missing`);
    continue;
  }
  if (sha256(media) !== sha256(evidence)) {
    errors.push(`assets/product/${file}: no longer matches ${source}`);
  }
}

// Every product image the HTML references must carry the intrinsic size it is rendered with.
for (const page of ["index.html", "zh/index.html", "404.html", "zh/404.html"]) {
  const file = path.join(root, page);
  if (!fs.existsSync(file)) continue;
  const source = fs.readFileSync(file, "utf8");
  for (const image of source.matchAll(/<img\b[^>]*>/gi)) {
    const tag = image[0];
    const src = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1];
    if (!src || /^(?:https?:|data:)/i.test(src)) continue;
    if (!/\.png$/i.test(src)) continue;
    const target = path.resolve(path.dirname(file), src);
    const size = fs.existsSync(target) ? pngSize(target) : null;
    if (!size) {
      errors.push(`${page}: ${src} is missing or not a PNG`);
      continue;
    }
    const width = Number(tag.match(/\bwidth=["'](\d+)["']/i)?.[1] || 0);
    const height = Number(tag.match(/\bheight=["'](\d+)["']/i)?.[1] || 0);
    if (width !== size.width || height !== size.height) {
      errors.push(`${page}: ${src} declares ${width}x${height}, file is ${size.width}x${size.height}`);
    }
  }
}

if (errors.length) {
  console.error("Pages media check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
const dims = [...screenshotSources.keys()].map((file) => {
  const size = pngSize(path.join(root, "assets/product", file));
  return `${file} (${size.width}x${size.height})`;
});
console.log(`Pages media check passed: og-image.png 1200x630; ${dims.join(", ")} match the onboarding evidence set.`);
