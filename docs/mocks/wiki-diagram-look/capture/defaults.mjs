import { browser, page } from './lib.mjs';
const b = await browser();
const p = await page(b, {});
const cfg = await p.evaluate(() => {
  window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', flowchart: { useMaxWidth: false } });
  const c = window.mermaid.mermaidAPI.getConfig();
  const f = c.flowchart;
  return { look: c.look, theme: c.theme, fontSize: c.fontSize, wrappingWidth: f.wrappingWidth, minNodeWidth: f.minNodeWidth, nodeSpacing: f.nodeSpacing, rankSpacing: f.rankSpacing, padding: f.padding, curve: f.curve, flowTheme: f.theme, flowLook: f.look };
});
console.log(JSON.stringify(cfg));
await b.close();
