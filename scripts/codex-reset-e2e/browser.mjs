// The browser half of the Codex rate-limit reset E2E (scripts/test-codex-reset-e2e.sh): a headless Chromium driven
// over the DevTools protocol with Node's own WebSocket. The production web bundle is loaded, pressed, reloaded and read
// the way a person's browser would do it — real mouse events on the rendered page, the page's own fetches, its own
// localStorage — so nothing between a confirmation and the operation API is stood in for.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

export async function launchChromium({ binary, profileDir, port, env, log }) {
  mkdirSync(profileDir, { recursive: true });
  const child = spawn(
    binary,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--window-size=1440,1000',
      'about:blank',
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', (chunk) => log(chunk));
  child.stderr.on('data', (chunk) => log(chunk));
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`chromium exited ${child.exitCode} before opening its DevTools port`);
    try {
      const res = await fetch(`${origin}/json/version`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error('chromium never opened its DevTools port');
    await sleep(250);
  }
  return {
    child,
    async newPage() {
      const res = await fetch(`${origin}/json/new?about:blank`, { method: 'PUT' });
      if (!res.ok) throw new Error(`chromium refused a new target: ${res.status}`);
      const target = await res.json();
      return Page.connect(target.webSocketDebuggerUrl);
    },
    close() {
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

export class Page {
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`could not open the DevTools socket ${url}`));
    });
    const page = new Page(ws);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    return page;
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = [];
    this.exceptions = [];
    ws.onmessage = (event) => {
      const message = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'));
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result);
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        this.exceptions.push(details?.exception?.description ?? details?.text ?? 'exception');
      }
      for (const waiter of this.waiters.filter((candidate) => candidate.method === message.method)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message.params);
      }
    };
  }

  send(method, params = {}, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer in ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  next(method, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      const waiter = { method, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const at = this.waiters.indexOf(waiter);
        if (at < 0) return;
        this.waiters.splice(at, 1);
        reject(new Error(`no ${method} in ${timeoutMs}ms`));
      }, timeoutMs).unref();
    });
  }

  /** Runs fn inside the page with JSON arguments and returns its JSON result. */
  async call(fn, ...args) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(${fn.toString()})(...${JSON.stringify(args)})`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`the page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result.value;
  }

  async goto(url) {
    const loaded = this.next('Page.loadEventFired');
    await this.send('Page.navigate', { url });
    await loaded;
  }

  async reload() {
    const loaded = this.next('Page.loadEventFired');
    await this.send('Page.reload', { ignoreCache: true });
    await loaded;
  }

  async mouse(type, x, y, extra = {}) {
    await this.send('Input.dispatchMouseEvent', { type, x, y, ...extra });
  }

  /** A real press and release at the centre of the element `locate` finds, after checking the press lands on it. */
  async click(locate, ...args) {
    const at = await this.point(locate, ...args);
    await this.mouse('mouseMoved', at.x, at.y);
    await this.mouse('mousePressed', at.x, at.y, { button: 'left', clickCount: 1 });
    await this.mouse('mouseReleased', at.x, at.y, { button: 'left', clickCount: 1 });
    return at;
  }

  /**
   * Where a press on the element lands: its centre once the modal or popover holding it has no finite animation
   * running (antd zooms a confirmation in from the pointer, so a button starts tiny), three measurements 150ms apart
   * agree, and nothing covers it there.
   */
  async point(locate, ...args) {
    const what = locate.toString().slice(0, 160);
    const deadline = Date.now() + 10_000;
    const samples = [];
    for (;;) {
      const at = await this.call(
        (source, locateArgs) => {
          // eslint-disable-next-line no-new-func
          const element = new Function(`return (${source})`)()(...locateArgs);
          if (!element) return null;
          element.scrollIntoView({ block: 'center', inline: 'center' });
          const rect = element.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const hit = document.elementFromPoint(x, y);
          const lands = !!hit && (hit === element || element.contains(hit));
          const cover = hit && !lands ? `${hit.tagName.toLowerCase()}.${String(hit.className).split(' ').join('.')}` : null;
          const container = element.closest('.ant-modal-wrap, .ant-popover') ?? element;
          const moving = (container.getAnimations ? container.getAnimations({ subtree: true }) : []).some(
            (animation) => animation.playState === 'running' && animation.effect?.getTiming?.().iterations !== Infinity,
          );
          return { x, y, width: rect.width, height: rect.height, lands, cover, moving };
        },
        locate.toString(),
        args,
      );
      const visible = !!at && at.width > 0 && at.height > 0;
      samples.push(visible ? at : null);
      const recent = samples.slice(-3);
      const still =
        visible &&
        recent.length === 3 &&
        recent.every(
          (sample) =>
            sample !== null &&
            Math.abs(sample.x - at.x) < 0.5 &&
            Math.abs(sample.y - at.y) < 0.5 &&
            Math.abs(sample.width - at.width) < 0.5 &&
            Math.abs(sample.height - at.height) < 0.5,
        );
      if (still && !at.moving && at.lands) return at;
      if (Date.now() > deadline) {
        if (!visible) throw new Error(`nothing to press: ${what}`);
        if (!at.lands) throw new Error(`a press would not land on: ${what} (covered by ${at.cover})`);
        throw new Error(`never stopped moving: ${what} (${JSON.stringify(at)})`);
      }
      await sleep(150);
    }
  }

  async screenshot(file) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // already gone
    }
  }
}
