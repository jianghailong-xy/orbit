// Read-only browser probe. Native event and animation clocks are left untouched.
export function observeEntry() {
  const entries = [];
  window.legacyEntry = entries;
  const describe = (el) => el && ({ tag: el.tagName, role: el.getAttribute('role'), text: el.textContent?.trim().slice(0, 80) });
  const sample = (kind, event) => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((el) => el.textContent.includes('Legacy confirmation'));
    const ok = dialog && [...dialog.querySelectorAll('button')].find((el) => el.textContent.trim() === 'OK');
    const box = ok?.getBoundingClientRect();
    const style = dialog && getComputedStyle(dialog);
    const x = event?.clientX ?? (box && box.x + box.width / 2);
    const y = event?.clientY ?? (box && box.y + box.height / 2);
    const hit = x !== undefined && document.elementFromPoint(x, y);
    entries.push({ kind, time: performance.now(),
      dialog: style && { opacity: style.opacity, transform: style.transform, pointerEvents: style.pointerEvents },
      box: box?.toJSON(), hit: describe(hit), hitOK: !!(ok && hit && ok.contains(hit)),
      animations: dialog?.getAnimations().map((a) => ({ name: a.animationName, state: a.playState, pending: a.pending, currentTime: a.currentTime })),
      event: event && { trusted: event.isTrusted, x, y, target: describe(event.target), targetOK: !!(ok && ok.contains(event.target)) },
      confirmed: !![...document.querySelectorAll('[role="region"]')].find((el) => el.textContent.includes('Legacy confirmed')),
    });
  };
  for (const type of ['pointerdown', 'pointerup', 'click', 'animationstart', 'animationend']) {
    document.addEventListener(type, (event) => sample(type, event), true);
  }
  let running = true;
  const frame = () => { if (running) { sample('frame'); requestAnimationFrame(frame); } };
  requestAnimationFrame(frame);
  window.stopLegacyEntry = () => { running = false; sample('end'); return entries; };
}
