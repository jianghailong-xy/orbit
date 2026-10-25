(() => {
  const view = document.querySelector('.app-view');
  const keys = ['display', 'position', 'height', 'minHeight', 'maxHeight', 'overflowY', 'flexDirection', 'gridTemplateRows', 'alignContent', 'contain', 'containerType', 'contentVisibility', 'aspectRatio'];
  const walk = (el, depth) => {
    const s = getComputedStyle(el);
    const row = { depth, el: `${el.nodeName}.${String(el.className?.baseVal ?? el.className).slice(0, 50)}`, h: +el.getBoundingClientRect().height.toFixed(3),
      ...Object.fromEntries(keys.map((k) => [k, s[k]]).filter(([k, v]) => !['auto', 'none', 'normal', 'visible', 'static', 'block', '0px', 'row'].includes(v))) };
    const rows = [row];
    if (depth < 3) for (const child of el.children) rows.push(...walk(child, depth + 1));
    return rows;
  };
  return walk(view, 0);
})()
