// Small SVG icons for the board. Names are the board's; each client picture maps its own glyphs onto them.
const S = (body, { fill = false } = {}) => (color, size = 16) =>
  `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 16 16" fill="${fill ? color : 'none'}" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS = {
  // the three states
  clock: S('<circle cx="8" cy="8" r="6.25"/><path d="M8 4.6V8l2.3 1.5"/>'),
  spinner: (color, size = 16) =>
    `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round"><path d="M8 1.75a6.25 6.25 0 1 1-6.25 6.25" /></svg>`,
  circle: S('<circle cx="8" cy="8" r="6.25"/>'),
  // today's other glyphs
  message: S('<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>'),
  'minus-circle': S('<circle cx="8" cy="8" r="6.25"/><path d="M5 8h6"/>'),
  'check-circle': S('<circle cx="8" cy="8" r="6.25"/><path d="M5.2 8.2l1.9 1.9 3.7-4"/>'),
  'check-circle-filled': (color, size = 16) =>
    `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="${color}"/><path d="M5 8.2l2 2 4-4.3" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  'close-circle-filled': (color, size = 16) =>
    `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="${color}"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  'pause-circle': S('<circle cx="8" cy="8" r="6.25"/><path d="M6.5 5.5v5M9.5 5.5v5"/>'),
  'pause-circle-filled': (color, size = 16) =>
    `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="${color}"/><path d="M6.4 5.3v5.4M9.6 5.3v5.4" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  eye: S('<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.9"/>'),
  terminal: S('<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5"/><path d="M4.5 6.2l2 1.8-2 1.8M8 10h3.5"/>'),
  unplug: S('<path d="M10.5 2.5l-2 2M13.5 5.5l-2 2M6 6.5l3.5 3.5M7.5 5l3.5 3.5-2.5 2.5a2.5 2.5 0 0 1-3.5-3.5zM4.6 11.4L2.5 13.5"/>'),
  'dot-filled': (color, size = 16) => `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 16 16"><circle cx="8" cy="8" r="4" fill="${color}"/></svg>`,
  none: () => '<span class="ic-none">—</span>',
  // marks
  hand: S('<path d="M5.5 8.5V3.8a1 1 0 0 1 2 0V8M7.5 7V2.8a1 1 0 0 1 2 0V8M9.5 7.2V3.8a1 1 0 0 1 2 0v5.4c0 2.6-1.6 4.3-4 4.3-1.7 0-2.6-.8-3.6-2.3L2.6 8.6a1 1 0 0 1 1.6-1.1l1.3 1.5"/>'),
  cross: S('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'),
  retry: S('<path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.8v2.6h-2.6"/>'),
  pause: S('<path d="M6 4v8M10 4v8"/>'),
  minus: S('<path d="M4 8h8"/>'),
  check: S('<path d="M3.5 8.4l3 3 6-6.6"/>'),
  stop: S('<rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1"/>'),
};

export const icon = (name, color, size) => (ICONS[name] ?? ICONS.circle)(color, size);
