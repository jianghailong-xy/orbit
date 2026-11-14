import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.argv[2] || "dist/pages");
const pageRules = {
  "index.html": {
    lang: "en",
    locale: "en_US",
    requiredText: [
      "Self-hosted mission control for coding agents.",
      "Run coding agents on your own machines.",
      "Built for",
      "The problem",
      "Durable work",
      "Local execution",
      "Supervised parallelism",
      "Work that outlives a chat",
      "Parallel agents without checkout collisions",
      "Access to private infrastructure",
      "Product demo · four steps",
      "1 · Task graph",
      "2 · Runner",
      "3 · Approval",
      "4 · Result",
      "90-second recording script",
      "Quick Start",
      "Architecture &amp; security boundary",
      "FAQ",
      "Community &amp; contribution",
      "Version &amp; roadmap",
      "not a security boundary",
      "not a hosted service",
    ],
    canonical: "https://jianghailong-xy.github.io/orbit/",
    index: true,
  },
  "zh/index.html": {
    lang: "zh-CN",
    locale: "zh_CN",
    requiredText: [
      "面向编码代理的自托管任务控制台。",
      "在自己的机器上运行编码代理",
      "适用对象",
      "要解决的问题",
      "持久的工作",
      "本地执行",
      "受监督的并行",
      "让工作超越一次聊天",
      "并行代理，避免 checkout 冲突",
      "访问私有基础设施",
      "产品演示 · 四步",
      "1 · 任务图",
      "2 · Runner",
      "3 · 审批",
      "4 · 结果",
      "90 秒演示",
      "快速开始",
      "架构与安全边界",
      "常见问题 FAQ",
      "社区与贡献",
      "版本与路线图",
      "不是安全边界",
      "不是托管服务",
    ],
    canonical: "https://jianghailong-xy.github.io/orbit/zh/",
    index: true,
  },
  "404.html": {
    lang: "en",
    locale: "en_US",
    canonical: "https://jianghailong-xy.github.io/orbit/404.html",
  },
  "zh/404.html": {
    lang: "zh-CN",
    locale: "zh_CN",
    canonical: "https://jianghailong-xy.github.io/orbit/zh/404.html",
  },
};
const htmlFiles = Object.keys(pageRules);
const errors = [];
const warnings = [];
const idsByFile = new Map();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const socialImage = "https://jianghailong-xy.github.io/orbit/assets/social/og-image.png";
const requiredMeta = [
  ["property", "og:image", socialImage],
  ["property", "og:image:type", "image/png"],
  ["property", "og:image:width", "1200"],
  ["property", "og:image:height", "630"],
  ["name", "twitter:card", "summary_large_image"],
  ["name", "twitter:image", socialImage],
];
const nonEmptyMeta = ["og:title", "og:description", "og:image:alt", "twitter:title", "twitter:description", "twitter:image:alt"];
const publicLinkTargets = {
  docs: "https://github.com/jianghailong-xy/orbit/blob/main/docs/README.md",
  github: "https://github.com/jianghailong-xy/orbit",
  releases: "https://github.com/jianghailong-xy/orbit/releases",
  support: "https://github.com/jianghailong-xy/orbit/blob/main/SUPPORT.md",
  security: "https://github.com/jianghailong-xy/orbit/blob/main/SECURITY.md",
};
const demoSteps = ["task-graph", "runner", "approval", "result"];

function localTarget(file, relative) {
  let target = path.resolve(path.dirname(path.join(root, file)), relative);
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, "index.html");
  return target;
}

function insideRoot(target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function idsFor(target) {
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return new Set();
  const source = fs.readFileSync(target, "utf8");
  return new Set([...source.matchAll(/\bid=["']([^"']+)["']/gi)].map((match) => match[1]));
}

for (const file of htmlFiles) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) {
    errors.push(`${file}: file is missing`);
    continue;
  }
  const source = read(file);
  idsByFile.set(file, idsFor(full));
  const rule = pageRules[file];
  if (!new RegExp(`<html\\s+[^>]*lang=["']${rule.lang}["']`, "i").test(source)) {
    errors.push(`${file}: expected html lang=${rule.lang}`);
  }
  if (!source.includes(`<meta property="og:locale" content="${rule.locale}">`)) {
    errors.push(`${file}: expected og:locale ${rule.locale}`);
  }
  if (!source.includes("中文") || !source.includes("English")) {
    errors.push(`${file}: explicit 中文 / English language switch is missing`);
  }
  if (rule.canonical && !source.includes(`<link rel="canonical" href="${rule.canonical}">`)) {
    errors.push(`${file}: canonical URL is missing or incorrect`);
  }
  for (const text of rule.requiredText || []) {
    if (!source.includes(text)) errors.push(`${file}: required copy is missing: ${text}`);
  }
  for (const image of source.matchAll(/<img\b[^>]*>/gi)) {
    const alt = image[0].match(/\balt=["']([^"']*)["']/i)?.[1];
    if (!alt || !alt.trim()) errors.push(`${file}: image is missing accessible alt text`);
    if (!/\bwidth=["']\d+["']/i.test(image[0]) || !/\bheight=["']\d+["']/i.test(image[0])) {
      errors.push(`${file}: image is missing intrinsic width/height: ${image[0]}`);
    }
  }
  for (const [attribute, property, value] of requiredMeta) {
    if (!source.includes(`<meta ${attribute}="${property}" content="${value}">`)) {
      errors.push(`${file}: social metadata ${property} is missing or incorrect`);
    }
  }
  for (const property of nonEmptyMeta) {
    const match = source.match(new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)"`));
    if (!match || !match[1].trim()) errors.push(`${file}: social metadata ${property} is missing or empty`);
  }
  if (rule.index) {
    for (const [key, target] of Object.entries(publicLinkTargets)) {
      const tag = source.match(new RegExp(`<a\\b[^>]*data-public-link="${key}"[^>]*>`))?.[0];
      const href = tag?.match(/\bhref="([^"]+)"/)?.[1]?.split("?", 1)[0];
      if (!href) errors.push(`${file}: public link ${key} is missing`);
      else if (href !== target) errors.push(`${file}: public link ${key} points at ${href}, expected ${target}`);
    }
    const steps = [...source.matchAll(/data-demo-step="([^"]+)"/g)].map((match) => match[1]);
    if (steps.join(",") !== demoSteps.join(",")) {
      errors.push(`${file}: demo steps are ${steps.join(",") || "missing"}, expected ${demoSteps.join(",")}`);
    }
  }

  const refs = [...source.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);
  for (const ref of refs) {
    if (/^(?:https?:|mailto:|tel:|data:|javascript:)/i.test(ref)) continue;
    const hashIndex = ref.indexOf("#");
    const withoutHash = hashIndex === -1 ? ref : ref.slice(0, hashIndex);
    const fragment = hashIndex === -1 ? "" : ref.slice(hashIndex + 1).split("?", 1)[0];
    const [relative] = withoutHash.split("?", 1);
    if (!relative) {
      if (fragment && !idsByFile.get(file)?.has(fragment)) errors.push(`${file}: missing fragment target #${fragment}`);
      continue;
    }
    // Root-absolute URLs are resolved by GitHub Pages at /orbit/ and are checked
    // against the live site separately; they cannot be mapped without that prefix.
    if (relative.startsWith("/")) continue;
    if (relative === "appcast.xml" || relative.endsWith("/appcast.xml")) {
      warnings.push(`${file}: ${ref} is supplied by the release workflow and preserved during Pages deploy`);
      continue;
    }
    const target = localTarget(file, relative);
    if (!insideRoot(target)) {
      errors.push(`${file}: reference escapes the Pages artifact: ${ref}`);
    } else if (!fs.existsSync(target)) {
      errors.push(`${file}: missing local reference: ${ref}`);
    } else if (fragment && !idsFor(target).has(fragment)) {
      errors.push(`${file}: missing fragment target ${ref}`);
    }
  }
}

const englishIds = idsByFile.get("index.html");
const chineseIds = idsByFile.get("zh/index.html");
if (englishIds && chineseIds) {
  for (const id of englishIds) if (!chineseIds.has(id)) errors.push(`zh/index.html: missing English section id #${id}`);
  for (const id of chineseIds) if (!englishIds.has(id)) errors.push(`index.html: missing Chinese section id #${id}`);
}

if (errors.length) {
  console.error("Pages link/content check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`Pages link/content check passed (${htmlFiles.length} bilingual HTML entry points)`);
for (const warning of warnings) console.log(`Pages check note: ${warning}`);
