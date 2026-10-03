// Fills every <i class="tile" data-b="…"> with its brand gradient and glyph (colors from
// providerPresets.ts / sessionProviderChoices.ts ENGINE_BRAND). data-m gives a monogram instead,
// data-badge a pool count.
const BRANDS = {
  anthropic: ['#d97757', '#c15f3c'],
  openai: ['#4b5158', '#1f2226'],
  gemini: ['#4285f4', '#9b72cb'],
  deepseek: ['#5b7cff', '#3a57e8'],
  kimi: ['#3a3a3a', '#111111'],
  antigravity: ['#3186ff', '#00b95c'],
  neutral: ['#9aa0a8', '#6b7178'],
};
document.addEventListener('DOMContentLoaded', () => {
  for (const el of document.querySelectorAll('.tile[data-b]')) {
    const [from, to] = BRANDS[el.dataset.b] ?? BRANDS.neutral;
    el.style.background = `linear-gradient(135deg, ${from}, ${to})`;
    const glyph = window.GLYPHS[el.dataset.b];
    el.innerHTML = el.dataset.m
      ? el.dataset.m
      : glyph
        ? `<svg viewBox="0 0 24 24" fill="#fff">${glyph}</svg>`
        : '';
    if (el.dataset.badge) el.insertAdjacentHTML('beforeend', `<span class="badge">${el.dataset.badge}</span>`);
  }
});
