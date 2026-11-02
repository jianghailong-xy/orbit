// Resolve the theme before first paint so dark users never flash a white
// screen. Mirrors lib/theme: 'system' follows the OS, else explicit choice.
//
// A file of its own because the page's Content-Security-Policy (src/web/nginx.conf) runs no inline
// script, and a plain file in public/ because only a classic script holds the parser until it has
// run: a module script, which is what Vite bundles, runs after the first paint.
(function () {
  try {
    var m = localStorage.getItem('orbit-theme') || 'system';
    var dark =
      m === 'dark' ||
      (m === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    // Same first-paint reasoning as the theme above: Safari reads theme-color at
    // load, so setting it here stops the address bar flashing the wrong shade.
    // Hexes mirror --bg-base in index.css (also duplicated in lib/theme.tsx).
    var mc = document.getElementById('theme-color');
    if (mc) mc.setAttribute('content', dark ? '#202023' : '#ffffff');
  } catch (e) {}
})();
