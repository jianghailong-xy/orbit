// Reachability check for the public links a visitor can follow from the Pages tree.
// Needs network access; it is a verification step rather than part of the offline build.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.argv[2] || "dist/pages");
const pages = ["index.html", "zh/index.html", "404.html", "zh/404.html"];
const urls = new Set();

for (const page of pages) {
  const file = path.join(root, page);
  if (!fs.existsSync(file)) continue;
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(/<a\b[^>]*\bhref=["'](https?:\/\/[^"']+)["']/gi)) {
    const url = new URL(match[1]);
    url.search = "";
    url.hash = "";
    urls.add(url.href);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function status(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: "HEAD",
        redirect: "follow",
        signal: AbortSignal.timeout(20000),
        headers: { "user-agent": "orbit-pages-link-check" },
      });
      if (response.status === 405 || response.status === 403) {
        const fallback = await fetch(url, {
          method: "GET",
          redirect: "follow",
          signal: AbortSignal.timeout(20000),
          headers: { "user-agent": "orbit-pages-link-check", range: "bytes=0-0" },
        });
        if (fallback.status < 400) return fallback.status;
        if (attempt === 3) return fallback.status;
      } else if (response.status < 400) {
        return response.status;
      } else if (response.status < 500 && response.status !== 429) {
        return response.status;
      }
    } catch (error) {
      if (attempt === 3) return `error: ${error.name}`;
    }
    await sleep(attempt * 1500);
  }
  return "no response";
}

const failures = [];
const rows = [];
for (const url of [...urls].sort()) {
  const code = await status(url);
  rows.push(`${code} ${url}`);
  if (typeof code !== "number" || code >= 400) failures.push(`${url}: ${code}`);
}
for (const row of rows) console.log(row);
if (failures.length) {
  console.error("Pages external-link check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`Pages external-link check passed (${urls.size} unique public links).`);
