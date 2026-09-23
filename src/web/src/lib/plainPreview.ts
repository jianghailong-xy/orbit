// Flatten an assistant reply into a single-line list preview: drop code blocks and the most
// common markdown markers so the line reads as prose, not syntax, then collapse all
// whitespace/newlines. Length is handled by CSS ellipsis, not here.
//
// A link keeps only its text and an image only its alt, so `[name](orbit-task:…)` reads as
// `name`. Both rules match a code span first and put it back as it was, which is what leaves the
// brackets inside `code` alone; the inline-code rule after them unwraps it. Images go first so a
// linked image, `[![alt](src)](url)`, still comes down to its alt.
export const plainPreview = (md: string): string =>
  md
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/(`[^`]+`)|!\[([^[\]]*)\]\([^)]*\)/g, '$1$2') // images -> alt
    .replace(/(`[^`]+`)|\[([^[\]]*)\]\([^)]*\)/g, '$1$2') // links -> link text
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/^[#>\-*\s]+/gm, '') // heading / quote / list markers at line start
    .replace(/[*_~]/g, '') // emphasis marks
    .replace(/\s+/g, ' ')
    .trim();
