(() => {
  const view = document.querySelector('.app-view');
  const keys = ['display', 'position', 'overflowX', 'overflowY', 'height', 'width', 'minHeight', 'contain', 'scrollbarGutter', 'overflowAnchor', 'flexDirection', 'flex', 'boxSizing', 'transform', 'willChange', 'scrollBehavior', 'scrollSnapType'];
  const describe = (el) => {
    const s = getComputedStyle(el);
    return { el: `${el.nodeName}#${el.id}.${String(el.className).slice(0, 80)}`, ...Object.fromEntries(keys.map((k) => [k, s[k]])),
      rect: el.getBoundingClientRect().toJSON(), scroll: [el.scrollTop, el.scrollHeight, el.clientHeight, el.clientWidth] };
  };
  const chain = [];
  for (let el = view; el; el = el.parentElement) chain.push(describe(el));
  const children = [...view.children].map((el) => ({ ...describe(el), children: el.children.length }));
  const bodyChildren = [...document.body.children].map((el) => `${el.nodeName}#${el.id}.${String(el.className).slice(0, 60)} ${getComputedStyle(el).position}`);
  return { chain, children, bodyChildren, sheets: [...document.styleSheets].length };
})()
