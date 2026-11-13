// Real-browser layout and media probe for the public Pages tree.
// Runs headless Chromium against a local static server at desktop and mobile widths,
// asserts no horizontal overflow, no broken images, the four demo steps, and that the
// hero's audience, problem, and three proofs are inside the first viewport.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const root = path.resolve(process.argv[2] || "dist/pages");
const outDir = path.resolve(process.argv[3] || "dist/pages-layout");
const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];
const pages = [
  { file: "index.html", label: "en", firstScreen: true },
  { file: "zh/index.html", label: "zh", firstScreen: true },
  { file: "404.html", label: "en-404", firstScreen: false },
  { file: "zh/404.html", label: "zh-404", firstScreen: false },
];
const demoSteps = ["task-graph", "runner", "approval", "result"];
const failures = [];
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml",
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  let pathname = decodeURIComponent(url.pathname);
  // Mirror the production base path so the 404 pages' root-absolute asset links resolve.
  if (pathname === "/orbit" || pathname.startsWith("/orbit/")) pathname = pathname.slice("/orbit".length) || "/";
  let target = path.resolve(root, `.${pathname}`);
  if (!target.startsWith(root)) {
    response.writeHead(403).end();
    return;
  }
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, "index.html");
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    response.writeHead(404).end("not found");
    return;
  }
  response.writeHead(200, { "content-type": mime[path.extname(target)] || "application/octet-stream" });
  fs.createReadStream(target).pipe(response);
});

function waitForFile(file, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fs.existsSync(file)) return resolve(fs.readFileSync(file, "utf8"));
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for ${file}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function launchChromium() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-pages-layout-"));
  const child = spawn("chromium", [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--mute-audio",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const portFile = path.join(profile, "DevToolsActivePort");
  const contents = await waitForFile(portFile, 15000);
  const port = Number(contents.split("\n")[0]);
  if (!port) throw new Error(`chromium did not report a debugging port: ${stderr.slice(-500)}`);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((item) => item.type === "page");
  if (!target) throw new Error("chromium did not expose a page target");
  return { child, profile, wsUrl: target.webSocketDebuggerUrl };
}

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const handler = pending.get(message.id);
    if (!handler) return;
    pending.delete(message.id);
    if (message.error) handler.reject(new Error(`${message.error.message} (${message.error.code})`));
    else handler.resolve(message.result);
  });
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { ready, send, close: () => socket.close() };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForLoad(cdp, expectedUrl) {
  await sleep(50);
  for (let i = 0; i < 200; i++) {
    const state = await cdp.send("Runtime.evaluate", {
      expression: "({ ready: document.readyState, href: location.href })",
      returnByValue: true,
    });
    if (state.result.value.ready === "complete" && state.result.value.href === expectedUrl) {
      await sleep(250);
      return;
    }
    await sleep(50);
  }
  throw new Error(`page did not finish loading: ${expectedUrl}`);
}

const probe = `(() => {
  const images = [...document.images].map((image) => ({
    src: image.currentSrc || image.src,
    loaded: image.complete && image.naturalWidth > 0,
    naturalWidth: image.naturalWidth,
    renderedWidth: image.getBoundingClientRect().width,
  }));
  const box = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) };
  };
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scrollWidth: document.documentElement.scrollWidth,
    images,
    demoSteps: [...document.querySelectorAll('[data-demo-step]')].map((element) => element.dataset.demoStep),
    hero: {
      audience: box('.hero-audience'),
      problem: box('.hero-problem'),
      proofs: [...document.querySelectorAll('.proofs li')].map((element) => {
        const rect = element.getBoundingClientRect();
        return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) };
      }),
    },
  };
})()`;

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port: serverPort } = server.address();
  const base = `http://127.0.0.1:${serverPort}/orbit/`;
  const browser = await launchChromium();
  const cdp = connect(browser.wsUrl);
  await cdp.ready;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  const rows = [];
  try {
    for (const viewport of viewports) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: viewport.width <= 480,
      });
      for (const page of pages) {
        const url = `${base}${page.file}`;
        await cdp.send("Page.navigate", { url });
        await waitForLoad(cdp, url);
        const result = (await cdp.send("Runtime.evaluate", { expression: probe, returnByValue: true })).result.value;
        const label = `${page.label} ${viewport.name} ${viewport.width}x${viewport.height}`;
        const overflow = result.scrollWidth - result.viewport.width;
        const unloaded = result.images.filter((image) => !image.loaded);
        const tiny = result.images.filter((image) => image.loaded && image.renderedWidth < 1);
        if (overflow > 1) failures.push(`${label}: horizontal overflow ${overflow}px`);
        if (unloaded.length) failures.push(`${label}: images did not load ${unloaded.map((image) => image.src).join(", ")}`);
        if (tiny.length) failures.push(`${label}: images not rendered ${tiny.map((image) => image.src).join(", ")}`);
        if (page.firstScreen && result.demoSteps.join(",") !== demoSteps.join(",")) {
          failures.push(`${label}: demo steps ${result.demoSteps.join(",") || "missing"}`);
        }
        if (page.firstScreen) {
          for (const key of ["audience", "problem"]) {
            const box = result.hero[key];
            if (!box) failures.push(`${label}: hero ${key} is missing`);
            else if (box.bottom > viewport.height) failures.push(`${label}: hero ${key} ends at ${box.bottom}px, below the first viewport`);
          }
          if (result.hero.proofs.length !== 3) failures.push(`${label}: expected 3 hero proofs, found ${result.hero.proofs.length}`);
          result.hero.proofs.forEach((box, index) => {
            if (box.bottom > viewport.height) failures.push(`${label}: hero proof ${index + 1} ends at ${box.bottom}px, below the first viewport`);
          });
        }
        const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
        const shotFile = path.join(outDir, `${page.label}-${viewport.name}.png`);
        fs.writeFileSync(shotFile, Buffer.from(shot.data, "base64"));
        let demoScreenshot = null;
        if (page.firstScreen) {
          await cdp.send("Runtime.evaluate", {
            expression: `(async () => {
              for (let y = 0; y <= document.documentElement.scrollHeight; y += 600) {
                window.scrollTo(0, y);
                await new Promise((resolve) => setTimeout(resolve, 30));
              }
              window.scrollTo(0, 0);
              await new Promise((resolve) => setTimeout(resolve, 120));
            })()`,
            awaitPromise: true,
          });
          const afterScroll = (await cdp.send("Runtime.evaluate", { expression: probe, returnByValue: true })).result.value;
          const stillUnloaded = afterScroll.images.filter((image) => !image.loaded);
          if (stillUnloaded.length) {
            failures.push(`${label}: images did not decode after scrolling ${stillUnloaded.map((image) => image.src).join(", ")}`);
          }
          await cdp.send("Runtime.evaluate", {
            expression: `(() => {
              document.documentElement.style.scrollBehavior = "auto";
              document.querySelector("#demo").scrollIntoView({ block: "start" });
              return true;
            })()`,
            returnByValue: true,
          });
          await sleep(300);
          const demoShot = await cdp.send("Page.captureScreenshot", { format: "png" });
          demoScreenshot = path.join(outDir, `${page.label}-${viewport.name}-demo.png`);
          fs.writeFileSync(demoScreenshot, Buffer.from(demoShot.data, "base64"));
        }
        rows.push({
          label,
          overflow,
          images: result.images.length,
          broken: unloaded.length,
          demoSteps: result.demoSteps.join(","),
          hero: result.hero,
          screenshot: shotFile,
          demoScreenshot,
        });
      }
    }
  } finally {
    cdp.close();
    browser.child.kill("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 200));
    fs.rmSync(browser.profile, { recursive: true, force: true });
    server.close();
  }
  for (const row of rows) {
    const proofs = row.hero.proofs.map((box) => box.bottom).join("/");
    console.log(`${row.label}: overflow=${row.overflow}px images=${row.images} broken=${row.broken} demo=[${row.demoSteps}] ` +
      `audience.bottom=${row.hero.audience?.bottom} problem.bottom=${row.hero.problem?.bottom} proofs.bottom=${proofs || "-"} -> ` +
      `${row.screenshot}${row.demoScreenshot ? ` + ${row.demoScreenshot}` : ""}`);
  }
  if (failures.length) {
    console.error("Pages layout check failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(`Pages layout check passed (${pages.length} pages x ${viewports.length} viewports).`);
}

main().catch((error) => {
  console.error(error);
  server.close();
  process.exit(1);
});
