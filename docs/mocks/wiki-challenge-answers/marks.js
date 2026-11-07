// Rings and numbers over a real capture. A .b-shot carries data-w: the width, in the capture's own CSS px, of what
// it shows. Each .b-ring / .b-badge inside carries data-box="x,y,w,h" in those px (measured on the page by
// capture/measure.mjs, or read off the device's own accessibility tree), and is placed by the picture's drawn scale.
window.addEventListener('load', () => {
  for (const shot of document.querySelectorAll('.b-shot[data-w]')) {
    const img = shot.querySelector('img');
    // Absolutely placed marks start inside the frame's border, where the picture starts too.
    const inset = 0;
    const scale = img.clientWidth / Number(shot.dataset.w);
    for (const mark of shot.querySelectorAll('[data-box]')) {
      const [x, y, w, h] = mark.dataset.box.split(',').map(Number);
      const pad = Number(mark.dataset.pad ?? 4);
      if (mark.classList.contains('b-ring')) {
        Object.assign(mark.style, { left: `${inset + x * scale - pad}px`, top: `${inset + y * scale - pad}px`,
          width: `${w * scale + 2 * pad}px`, height: `${h * scale + 2 * pad}px` });
      } else {
        // Kept inside the picture: the frame clips anything outside it.
        const side = mark.dataset.side ?? 'left';
        const want = side === 'right' ? (x + w) * scale - 14 : x * scale - 10;
        const left = Math.max(2, Math.min(img.clientWidth - 26, want));
        const top = Math.max(2, y * scale - 12);
        Object.assign(mark.style, { left: `${inset + left}px`, top: `${inset + top}px` });
      }
    }
  }
});
