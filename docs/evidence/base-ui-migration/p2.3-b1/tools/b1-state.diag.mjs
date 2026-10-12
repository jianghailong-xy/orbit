import { test, expect } from './harness.mjs';
import { settingsScenario, profileScenario } from './page-scenarios.mjs';
import { sessionScenarios } from './session-scenarios.mjs';

// Runs the unchanged P0 scenarios with the unchanged P0 capture (toHaveScreenshot into the scratch
// snapshot directory). Right after the screenshot of a notification scene it records, read-only
// except for short-lived probes appended and removed in the same task: the notification's DOM host,
// computed styles, geometry, the viewport metrics, fixed-position probes and, in Chromium, the
// compositor layers (CDP LayerTree) with their compositing reasons.
const targets = new Set(['settings-saved', 'profile-validation', 'notification-error']);

async function domState(page) {
  return page.evaluate(() => {
    const rect = (el) => el && el.getBoundingClientRect().toJSON();
    const pick = (el, keys) => { const s = getComputedStyle(el); return Object.fromEntries(keys.map((k) => [k, s[k]])); };
    const section = document.querySelector('.toast-viewport');
    const host = section?.parentElement ?? null;
    const probe = (parent, css) => {
      const el = document.createElement('div');
      el.style.cssText = css;
      parent.appendChild(el);
      const r = el.getBoundingClientRect().toJSON();
      el.remove();
      return r;
    };
    const persistent = [...document.body.children].filter((el) => el.getAttribute('aria-hidden') === 'true' && el.style.position === 'fixed' && el.style.visibility === 'hidden');
    let uninlined = null;
    if (section?.getAttribute('style')) {
      const saved = section.getAttribute('style');
      section.removeAttribute('style');
      uninlined = { rect: rect(section), style: pick(section, ['left', 'right', 'width']) };
      section.setAttribute('style', saved);
    }
    return {
      viewport: {
        innerWidth, innerHeight, clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight,
        scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
        bodyScrollWidth: document.body.scrollWidth, bodyScrollHeight: document.body.scrollHeight, scrollX, scrollY,
        visual: window.visualViewport && { width: visualViewport.width, height: visualViewport.height, scale: visualViewport.scale, offsetLeft: visualViewport.offsetLeft, offsetTop: visualViewport.offsetTop, pageLeft: visualViewport.pageLeft, pageTop: visualViewport.pageTop },
        html: pick(document.documentElement, ['overflow', 'overflowX', 'overflowY', 'width', 'height']),
        body: pick(document.body, ['overflow', 'overflowX', 'overflowY', 'width', 'height', 'margin']),
        phoneQuery: matchMedia('(max-width: 600px)').matches,
      },
      section: section && {
        className: section.className, inlineStyle: section.getAttribute('style'), rect: rect(section),
        style: pick(section, ['position', 'left', 'right', 'top', 'width', 'maxWidth', 'zIndex', 'transform', 'willChange', 'fontSize', 'lineHeight']),
        uninlined,
      },
      host: host && { tag: host.tagName, className: host.className, popover: host.getAttribute('popover'), popoverOpen: host.matches(':popover-open'), parent: host.parentElement?.tagName ?? null, rect: rect(host), style: pick(host, ['position', 'top', 'left', 'width', 'height', 'transform', 'willChange', 'overflow']) },
      cards: [...(section?.querySelectorAll('.toast') ?? [])].map((el) => ({
        className: el.className, rect: rect(el), text: rect(el.querySelector('.toast-head')),
        style: pick(el, ['willChange', 'transform', 'animationName', 'animationDuration', 'opacity', 'borderRadius', 'boxShadow', 'backgroundColor']),
        slot: el.parentElement && { className: el.parentElement.className, style: pick(el.parentElement, ['willChange', 'transform', 'animationName', 'opacity']) },
        animations: el.getAnimations({ subtree: true }).map((a) => ({ name: a.animationName ?? null, playState: a.playState })),
      })),
      probes: {
        bodyInset0: probe(document.body, 'position:fixed;inset:0;visibility:hidden;pointer-events:none'),
        bodyLeftRight16: probe(document.body, 'position:fixed;left:16px;right:16px;top:0;height:1px;visibility:hidden;pointer-events:none'),
        hostInset0: host && host !== document.body ? probe(host, 'position:fixed;inset:0;visibility:hidden;pointer-events:none') : null,
        hostLeftRight16: host && host !== document.body ? probe(host, 'position:fixed;left:16px;right:16px;top:0;height:1px;visibility:hidden;pointer-events:none') : null,
        persistent: persistent.map(rect),
      },
    };
  });
}

// Chromium only: CDP LayerTree enabled from the start of the test. layerTreeDidChange is sent when the
// layerization changes, so the latest tree at capture time is the steady state the screenshot shows.
async function layerRecorder(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('DOM.getDocument', { depth: -1 });
  const trees = [];
  cdp.on('LayerTree.layerTreeDidChange', (event) => {
    if (!event.layers) return;
    // With B1_MOTION=1, ask for each layer's compositing reasons while that layer tree is current.
    const reasons = process.env.B1_MOTION === '1'
      ? Promise.all(event.layers.map((l) => cdp.send('LayerTree.compositingReasons', { layerId: l.layerId }).then((r) => r.compositingReasonIds, () => null)))
      : null;
    trees.push({ at: Date.now(), layers: event.layers, reasons });
  });
  await cdp.send('LayerTree.enable');
  const describe = async (layers) => {
    const out = [];
    for (const layer of layers) {
      let node = null;
      if (layer.backendNodeId) {
        try {
          const { node: n } = await cdp.send('DOM.describeNode', { backendNodeId: layer.backendNodeId });
          const attrs = Object.fromEntries((n.attributes ?? []).reduce((acc, v, i, a) => (i % 2 ? acc : [...acc, [v, a[i + 1]]]), []));
          node = { name: n.nodeName, className: attrs.class, popover: attrs.popover };
        } catch (error) { node = { error: String(error).slice(0, 120) }; }
      }
      let reasons = null;
      try { reasons = (await cdp.send('LayerTree.compositingReasons', { layerId: layer.layerId })).compositingReasonIds; } catch (error) { reasons = { error: String(error).slice(0, 120) }; }
      out.push({ layerId: layer.layerId, parentLayerId: layer.parentLayerId ?? null, offsetX: layer.offsetX, offsetY: layer.offsetY, width: layer.width, height: layer.height,
        transform: layer.transform ?? null, drawsContent: layer.drawsContent, invisible: layer.invisible ?? false, backendNodeId: layer.backendNodeId ?? null, node, reasons });
    }
    return out;
  };
  const history = async () => {
    const rows = [];
    for (const tree of trees) {
      const mine = [];
      const reasons = tree.reasons ? await tree.reasons : [];
      for (const [i, layer] of tree.layers.entries()) {
        if (!layer.backendNodeId) continue;
        try {
          const { node: n } = await cdp.send('DOM.describeNode', { backendNodeId: layer.backendNodeId });
          const cls = (n.attributes ?? []).reduce((acc, v, i, a) => (v === 'class' && i % 2 === 0 ? a[i + 1] : acc), '');
          if (/(^|\s)toast/.test(cls)) mine.push({ node: `${n.nodeName.toLowerCase()}.${cls.split(' ').join('.')}`, width: layer.width, height: layer.height, drawsContent: layer.drawsContent, reasons: reasons[i] ?? null });
        } catch { /* node gone */ }
      }
      rows.push({ at: tree.at, layers: mine });
    }
    return rows;
  };
  return async function snapshot() {
    const latest = trees.at(-1);
    const result = { events: trees.map((t) => t.at), latest: latest ? { at: latest.at, layers: await describe(latest.layers) } : null };
    if (process.env.B1_MOTION === '1') result.history = await history();
    // Cross-check: a 1x1 transparent will-change element in the bottom-left corner, away from the
    // notification, forces one layerization update; the tree it reports is the current one plus that probe.
    const before = trees.length;
    await page.evaluate(() => {
      const el = document.createElement('div');
      el.id = 'b1-layer-probe';
      el.style.cssText = `position:fixed;left:0;bottom:0;width:1px;height:1px;will-change:transform;pointer-events:none`;
      document.body.appendChild(el);
    });
    for (let i = 0; i < 30 && trees.length === before; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    if (trees.length > before) result.forced = { at: trees.at(-1).at, layers: await describe(trees.at(-1).layers) };
    await page.evaluate(() => document.getElementById('b1-layer-probe')?.remove());
    return result;
  };
}

for (const [name, scenario] of Object.entries({ settings: settingsScenario, profile: profileScenario, session: sessionScenarios })) {
  test(name, async ({ evidence }, info) => {
    const { page } = evidence;
    // B1_MOTION=1: normal motion, so the notification's own entrance animation runs (P0 itself uses reduce).
    if (process.env.B1_MOTION === '1') await page.emulateMedia({ reducedMotion: 'no-preference' });
    let layers = null;
    const capture = async (shot, selectors = {}) => {
      // Enabled after the scenario's navigation, before its notification appears.
      if (!layers && info.project.use.browserName === 'chromium' && process.env.B1_LAYERS !== '0') layers = await layerRecorder(page);
      if (!targets.has(shot)) return evidence.capture(shot, selectors);
      // The P0 harness's own waits and screenshot assertion (harness.mjs capture), then the state at once,
      // so a short notification is still in its steady state.
      await page.evaluate(() => document.fonts.ready);
      for (const selector of Object.values(selectors)) {
        const locator = typeof selector === 'string' ? page.locator(selector).first() : selector;
        await expect(locator).toBeVisible();
        await expect.poll(() => locator.evaluate((el) => {
          for (let node = el; node; node = node.parentElement) if (Number(getComputedStyle(node).opacity) < 1) return false;
          return true;
        })).toBe(true);
      }
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(page).toHaveScreenshot(`${shot}.png`);
      const state = { screenshot: shot, at: Date.now() };
      if (layers) state.layers = await layers();
      state.dom = await domState(page);
      await info.attach(`${shot}-b1-state`, { body: JSON.stringify(state, null, 1), contentType: 'application/json' });
    };
    await scenario({ ...evidence, capture });
  });
}
