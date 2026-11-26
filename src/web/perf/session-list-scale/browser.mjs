// What is read in the browser: the load of a workspace's session list, and one watch frame on it.
const VIEWPORT = { width: 1440, height: 900 };

async function openPage(browser, base, session) {
  const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'light', serviceWorkers: 'block' });
  await context.addInitScript(({ accessToken, refreshToken }) => {
    localStorage.setItem('orbit_token', accessToken);
    localStorage.setItem('orbit_refresh', refreshToken);
  }, session);
  const page = await context.newPage();
  page.setDefaultTimeout(120_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  return { context, page, errors };
}

/** In the page, from before its first script: when the list is drawn and the main thread is free again, and
 *  every long task. */
function loadProbe(folders) {
  const probe = { drawnMs: null, interactiveMs: null, longTasks: [] };
  window.__perf = probe;
  new PerformanceObserver((list) => {
    for (const task of list.getEntries()) probe.longTasks.push({ start: task.startTime, duration: task.duration });
  }).observe({ type: 'longtask', buffered: true });
  const observer = new MutationObserver(() => {
    const splash = document.getElementById('boot');
    if (splash && !splash.classList.contains('hide')) return;
    const column = document.querySelector('.session-col-list');
    if (!column || !column.querySelector('.session-row') || column.querySelectorAll('.session-folder-row').length < folders) return;
    observer.disconnect();
    probe.drawnMs = performance.now();
    // After the next frame is painted, the first task that gets to run: from here a click is answered.
    requestAnimationFrame(() => setTimeout(() => { probe.interactiveMs = performance.now(); }, 0));
  });
  observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
}

const isListRead = (url) => url.pathname === '/api/sessions/listing'
  || (url.pathname === '/api/sessions' && url.searchParams.has('workspaceId') && url.searchParams.get('view') === 'open'
    && !url.searchParams.has('scheduled'));

/** Collects every /api read the page makes (not the streams). */
function recordReads(page) {
  const reads = [];
  const pending = new Set();
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/') || request.resourceType() === 'eventsource') return;
    const job = (async () => {
      const response = await request.response();
      if (!response || response.headers()['content-type']?.startsWith('text/event-stream')) return;
      await response.finished();
      const [sizes, body] = [await request.sizes(), await response.body().catch(() => Buffer.alloc(0))];
      const read = {
        path: url.pathname, query: url.search, status: response.status(), list: isListRead(url),
        encoding: response.headers()['content-encoding'] ?? null, wire: sizes.responseBodySize, bytes: body.length,
        startMs: request.timing().startTime, durationMs: request.timing().responseEnd,
      };
      if (read.list && body.length) {
        const json = JSON.parse(body.toString());
        const rows = Array.isArray(json) ? json : (json.entries ?? json.sessions ?? json.rows);
        read.items = rows?.length ?? null;
        read.kinds = json.entries ? json.entries.reduce((n, e) => ({ ...n, [e.kind]: (n[e.kind] ?? 0) + 1 }), {}) : undefined;
        read.next = json.next;
      }
      reads.push(read);
    })().catch(() => undefined);
    // A stream's response never finishes; only reads that end are waited for.
    pending.add(job);
    job.finally(() => pending.delete(job));
  });
  /** No read in flight and none started for `quietMs`. */
  const quiet = async (quietMs) => {
    for (let calm = 0, seen = -1; calm < quietMs; calm += 250) {
      await page.waitForTimeout(250);
      if (reads.length !== seen) { seen = reads.length; calm = 0; }
    }
  };
  return { reads, quiet };
}

const mounted = (page) => page.evaluate(() => {
  const column = document.querySelector('.session-col-list');
  const rows = [...column.querySelectorAll('.session-row')];
  return {
    rows: rows.length, folderRows: column.querySelectorAll('.session-folder-row').length,
    allElements: document.getElementsByTagName('*').length, height: column.clientHeight, scrollHeight: column.scrollHeight,
    first: rows[0]?.querySelector('.session-title')?.textContent ?? null,
    last: rows.at(-1)?.querySelector('.session-title')?.textContent ?? null,
  };
});

/** To the end of the column, again while that brings more of the list in; every row title seen on the way. */
async function scrollToEnd(page, recorder) {
  let steps = 0;
  const titles = new Set();
  const collect = async () => {
    for (const title of await page.locator('.session-col-list .session-row .session-title').allTextContents()) titles.add(title);
  };
  await collect();
  for (let still = 0, last = ''; still < 3 && steps < 400; steps += 1) {
    // A screen at a time, so every row of a windowed column is mounted at some step.
    const at = await page.evaluate(() => {
      const column = document.querySelector('.session-col-list');
      column.scrollTop += Math.max(200, column.clientHeight - 100);
      return { top: column.scrollTop, height: column.scrollHeight, end: column.scrollTop + column.clientHeight >= column.scrollHeight - 2 };
    });
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    await collect();
    if (!at.end) { still = 0; continue; }
    await recorder.quiet(750);
    const now = `${at.height}`;
    still = now === last ? still + 1 : 0;
    last = now;
  }
  await collect();
  const end = { ...(await mounted(page)), steps, titles: [...titles].sort() };
  // Once more from the top, with every page now read: a section that sits above the rows already passed (Needs
  // you, Working) may have gained rows from a later page.
  titles.clear();
  await page.evaluate(() => { document.querySelector('.session-col-list').scrollTop = 0; });
  for (let atBottom = false; !atBottom;) {
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    await collect();
    atBottom = await page.evaluate(() => {
      const column = document.querySelector('.session-col-list');
      if (column.scrollTop + column.clientHeight >= column.scrollHeight - 2) return true;
      column.scrollTop += Math.max(200, column.clientHeight - 100);
      return false;
    });
  }
  await collect();
  return { ...end, titlesOnceLoaded: [...titles].sort() };
}

export async function measureLoad(browser, base, session, facts, { scroll }) {
  const { context, page, errors } = await openPage(browser, base, session);
  await context.addInitScript(loadProbe, facts.seed.folders);
  const recorder = recordReads(page);
  await page.goto(`${base}/workspaces/${facts.workspaceId}`, { waitUntil: 'commit' });
  await page.waitForFunction(() => window.__perf?.interactiveMs != null, undefined, { polling: 50 });
  await recorder.quiet(3000);
  const probe = await page.evaluate(() => ({
    ...window.__perf,
    fcpMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
    scriptsEndMs: Math.max(0, ...performance.getEntriesByType('resource').filter((e) => e.name.endsWith('.js')).map((e) => e.responseEnd)),
  }));
  const atLoad = [...recorder.reads];
  // In the order they were asked for: the first is the response the column is first drawn from.
  const list = atLoad.filter((read) => read.list).sort((a, b) => a.startMs - b.startMs);
  if (!list.length) throw new Error(`no list read among ${atLoad.map((r) => r.path + r.query).join(' ')}`);
  const result = {
    ...probe,
    longTaskMs: probe.longTasks.reduce((n, task) => n + task.duration, 0),
    firstList: { wire: list[0].wire, decoded: list[0].bytes },
    listBytes: { wire: list.reduce((n, r) => n + r.wire, 0), decoded: list.reduce((n, r) => n + r.bytes, 0) },
    apiBytes: { wire: atLoad.reduce((n, r) => n + r.wire, 0), decoded: atLoad.reduce((n, r) => n + r.bytes, 0) },
    listReads: list,
    reads: atLoad.map(({ path, query, status, wire, bytes, durationMs }) => ({ path, query, status, wire, bytes, durationMs })),
    // From navigation to the first of the list reads having arrived.
    listArrivedMs: await page.evaluate(() => Math.min(...performance.getEntriesByType('resource')
      .filter((e) => /\/api\/sessions(\/listing)?\?.*workspaceId=/.test(e.name) && !e.name.includes('scheduled')).map((e) => e.responseEnd))),
    mounted: await mounted(page),
  };
  if (scroll) {
    result.atEnd = await scrollToEnd(page, recorder);
    const after = recorder.reads.filter((read) => read.list);
    result.atEnd.listReads = after.length;
    result.atEnd.listBytes = { wire: after.reduce((n, r) => n + r.wire, 0), decoded: after.reduce((n, r) => n + r.bytes, 0) };
    result.atEnd.listItems = after.reduce((n, r) => n + (r.items ?? 0), 0);
  }
  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
  await context.close();
  return result;
}

/** In the page: when the watched row's line changes, and (on the profiling build) every React commit. */
function frameProbe() {
  const probe = { commits: [], rowsRendered: null };
  window.__frame = probe;
  window.__watchRow = (title, watching) => {
    probe.commits = [];
    probe.since = performance.now();
    probe.domMs = null;
    probe.paintedMs = null;
    const says = () => [...document.querySelectorAll('.session-col-list .session-row')]
      .find((row) => row.querySelector('.session-title')?.textContent === title)
      ?.querySelector('.session-preview')?.textContent?.includes('Watching') ?? false;
    const observer = new MutationObserver(() => {
      if (says() !== watching) return;
      observer.disconnect();
      probe.domMs = performance.now();
      requestAnimationFrame(() => setTimeout(() => { probe.paintedMs = performance.now(); }, 0));
    });
    observer.observe(document.querySelector('.session-col-list'), { subtree: true, childList: true, characterData: true, attributes: true });
  };
}

/** React's DevTools hook: it sees every commit, and its presence turns the profiling renderer's timers on. */
function commitProbe() {
  const seen = new WeakMap();
  let renderers = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, isDisabled: false, renderers: new Map(),
    inject(renderer) { renderers += 1; this.renderers.set(renderers, renderer); return renderers; },
    checkDCE() {}, onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      const probe = window.__frame;
      const commit = { at: performance.now(), renderMs: root.current.actualDuration };
      probe.commits.push(commit);
      // Counting the rows a commit redraws walks the whole tree, so it is done only on the frames that are
      // not timed: a mounted row's element gets new props exactly when its row component rendered again.
      if (probe.rowsRendered === null) return;
      const earlier = probe.rowsRendered.length;
      const stack = [root.current];
      while (stack.length) {
        const fiber = stack.pop();
        const el = fiber.stateNode;
        if (fiber.tag === 5 && el?.classList?.contains('session-row') && el.closest?.('.session-col-list')) {
          const before = seen.get(el);
          if (before !== fiber.memoizedProps) {
            if (before !== undefined) probe.rowsRendered.push(el.querySelector('.session-title')?.textContent ?? '?');
            seen.set(el, fiber.memoizedProps);
          }
        }
        if (fiber.sibling) stack.push(fiber.sibling);
        if (fiber.child) stack.push(fiber.child);
      }
      commit.rows = probe.rowsRendered.length - earlier;
    },
  };
}

/** Watch frames on the loaded list: a watch that will resume an idle session on screen is created, then
 *  cancelled, through the API. Each is one `watch.changed` frame on the page's stream, a read of /watches, and
 *  that session's row saying (or no longer saying) that it is watching. */
export async function measureWatchFrames(browser, base, session, facts, { frames, profiling }) {
  const { context, page, errors } = await openPage(browser, base, session);
  await context.addInitScript(frameProbe);
  if (profiling) await context.addInitScript(commitProbe);
  const recorder = recordReads(page);
  await page.goto(`${base}/workspaces/${facts.workspaceId}`);
  await page.locator('.session-col-list .session-row').first().waitFor();
  await recorder.quiet(5000);
  const idle = new Map(facts.idleTitles.map((s) => [s.title, s.id]));
  const title = (await page.locator('.session-col-list .session-row .session-title').allTextContents()).find((t) => idle.has(t));
  if (!title) throw new Error('no idle session on screen to watch');
  const api = async (path, body) => {
    for (let attempt = 1; ; attempt += 1) {
      const res = await fetch(`${base}/api${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify(body ?? {}),
      });
      if (res.ok) return res.json();
      const text = await res.text();
      // A write the database rolled back to break a conflict saved nothing, and is asked to be sent again.
      if (res.status !== 503 || !text.includes('TRANSIENT_DB_CONFLICT') || attempt === 5) {
        throw new Error(`POST ${path} answered ${res.status}: ${text}`);
      }
      await new Promise((done) => setTimeout(done, 1000));
    }
  };
  let watchId;
  const frame = async (watching) => {
    await page.evaluate(([t, w]) => { performance.clearResourceTimings(); window.__watchRow(t, w); }, [title, watching]);
    if (watching) {
      watchId = (await api('/watches', {
        targets: [{ kind: 'SESSION', id: facts.runningId }], action: 'RESUME_SESSION', observerSessionId: idle.get(title),
        predicateVersion: 1, predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'SESSION_TURN_SETTLED' },
      })).id;
    } else await api(`/watches/${watchId}/cancel`);
    await page.waitForFunction(() => window.__frame.paintedMs != null, undefined, { polling: 100 });
    await page.waitForTimeout(1200);
    return page.evaluate(() => {
      const probe = window.__frame;
      const watches = performance.getEntriesByType('resource').filter((e) => /\/api\/watches(\?|$)/.test(e.name) && e.responseEnd <= probe.domMs);
      const arrived = watches.length ? Math.max(...watches.map((e) => e.responseEnd)) : null;
      const sum = (commits, key) => commits.reduce((n, c) => n + (c[key] ?? 0), 0);
      // The commits between the new watches arriving and the row saying so.
      const drawing = probe.commits.filter((c) => arrived !== null && c.at >= arrived && c.at <= probe.domMs + 1);
      return {
        responseToDomMs: arrived === null ? null : probe.domMs - arrived,
        responseToPaintedMs: arrived === null ? null : probe.paintedMs - arrived,
        commits: drawing.length, renderMs: sum(drawing, 'renderMs'),
        windowCommits: probe.commits.length, windowRenderMs: sum(probe.commits, 'renderMs'),
        rows: probe.rowsRendered === null ? undefined : [...probe.rowsRendered],
        perCommit: probe.rowsRendered === null ? undefined : probe.commits.map((c) => ({
          afterMs: Math.round(c.at - probe.since), renderMs: Math.round(c.renderMs * 10) / 10, rows: c.rows,
        })),
        reads: probe.rowsRendered === null ? undefined : performance.getEntriesByType('resource')
          .map((e) => ({ url: e.name.replace(/^.*?\/api/, '/api').replace(/(runnerId|workspaceId)=[^&]+/g, '$1=…'), afterMs: Math.round(e.responseEnd - probe.since) })),
        mounted: document.querySelectorAll('.session-col-list .session-row').length,
      };
    });
  };
  const timed = [];
  // The first pair is not recorded: it pays for code that has not run yet.
  await frame(true);
  await frame(false);
  for (let i = 0; i < frames; i += 1) timed.push({ watching: i % 2 === 0, ...(await frame(i % 2 === 0)) });
  // No watch is left live for the next page to start from.
  if (frames % 2) await frame(false);
  const rowProbe = [];
  if (profiling) {
    // Once through unrecorded so the probe has seen every mounted row's props.
    await page.evaluate(() => { window.__frame.rowsRendered = []; });
    await frame(true);
    await frame(false);
    for (const watching of [true, false]) {
      await page.evaluate(() => { window.__frame.rowsRendered = []; });
      const { rows, perCommit, reads, mounted: count } = await frame(watching);
      rowProbe.push({ watching, rowRenders: rows.length, distinctRows: new Set(rows).size, mounted: count, perCommit, reads });
    }
  }
  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
  await context.close();
  return { observer: title, frames: timed, rowProbe };
}
