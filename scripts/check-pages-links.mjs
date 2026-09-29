import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.argv[2] || "dist/pages");
const htmlFiles = ["index.html", "404.html"];
const requiredText = [
  "Self-hosted mission control for coding agents.",
  "Run coding agents on your own machines.",
  "Work that outlives a chat",
  "Parallel agents without checkout collisions",
  "Access to private infrastructure",
  "90-second demo",
  "Quick Start",
  "Architecture &amp; security boundary",
  "FAQ",
  "Community &amp; contribution",
  "Version &amp; roadmap",
  "not a security boundary",
  "not a hosted service",
];

const errors = [];
const warnings = [];
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

for (const file of htmlFiles) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) {
    errors.push(`${file}: file is missing`);
    continue;
  }
  const source = read(file);
  const refs = [...source.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);
  const ids = new Set([...source.matchAll(/\bid=["']([^"']+)["']/gi)].map((match) => match[1]));
  for (const ref of refs) {
    if (/^(?:https?:|mailto:|tel:|data:|javascript:)/i.test(ref)) continue;
    const [withoutHash] = ref.split("#", 1);
    const [relative] = withoutHash.split("?", 1);
    if (!relative) continue;
    // Root-absolute URLs are resolved by GitHub Pages at /orbit/ and cannot be
    // mapped to a local filesystem path without knowing the deployment prefix.
    if (relative.startsWith("/")) continue;
    if (relative === "appcast.xml" || relative.endsWith("/appcast.xml")) {
      warnings.push(`${file}: ${ref} is supplied by the release workflow and preserved during Pages deploy`);
      continue;
    }
    const target = path.resolve(path.dirname(full), relative);
    if (!target.startsWith(`${root}${path.sep}`) && target !== root) {
      errors.push(`${file}: reference escapes the Pages artifact: ${ref}`);
    } else if (!fs.existsSync(target)) {
      errors.push(`${file}: missing local reference: ${ref}`);
    }
  }
  for (const match of source.matchAll(/href\s*=\s*["']#([^"']+)["']/gi)) {
    if (!ids.has(match[1])) errors.push(`${file}: missing fragment target #${match[1]}`);
  }
  if (file === "index.html") {
    for (const text of requiredText) {
      if (!source.includes(text)) errors.push(`${file}: required copy is missing: ${text}`);
    }
  }
}

if (errors.length) {
  console.error("Pages link/content check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`Pages link/content check passed (${htmlFiles.length} HTML entry points)`);
for (const warning of warnings) console.log(`Pages check note: ${warning}`);
