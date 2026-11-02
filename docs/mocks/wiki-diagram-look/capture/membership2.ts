// Mermaid's own membership rules, by experiment: which cluster box holds node X.
import { browser, page, draw } from './lib.mjs';

const cases: Record<string, string> = {
  'outside first, then in A': `flowchart LR\n  Q --> X\n  subgraph A["A"]\n    X\n  end`,
  'in A, then in B': `flowchart LR\n  subgraph A["A"]\n    X --> Y\n  end\n  subgraph B["B"]\n    X --> Z\n  end`,
  'in A, then outside': `flowchart LR\n  subgraph A["A"]\n    X\n  end\n  X --> Q`,
  'nested: in A, then in inner C': `flowchart LR\n  subgraph A["A"]\n    X\n    subgraph C["C"]\n      W\n    end\n  end\n  subgraph C2["D"]\n    X\n  end`,
};
const b = await browser();
const p = await page(b, {});
for (const [name, source] of Object.entries(cases)) {
  await draw(p, { source, options: { flowchart: { useMaxWidth: false }, look: 'classic' } });
  const where = await p.evaluate(() => {
    const svg = document.querySelector('#fig > svg')!;
    const x = [...svg.querySelectorAll('g.node')].find((n) => n.textContent!.trim() === 'X')!.getBoundingClientRect();
    return [...svg.querySelectorAll('g.cluster')].filter((c) => {
      const r = c.querySelector('rect')!.getBoundingClientRect();
      return x.left >= r.left && x.right <= r.right && x.top >= r.top && x.bottom <= r.bottom;
    }).map((c) => c.textContent!.trim()).join(' ⊃ ') || '(none)';
  });
  console.log(`${name}: X in ${where}`);
}
await b.close();
