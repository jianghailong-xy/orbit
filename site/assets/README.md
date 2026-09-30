# Public-site asset contract

The landing page deliberately keeps brand and product media behind stable, replaceable paths:

- `brand/logo.svg` — horizontal logo for the header and future press use.
- `brand/favicon.svg` — browser and pinned-tab mark.
- `social/og-image.svg` — 1200×630 social preview; replace with an approved PNG/WebP if the channel requires raster media.
- `product/hero-preview.svg` — clearly decorative UI preview, not evidence of a hosted deployment.
- `product/` — reserved for an approved screenshot (`screenshot-*.webp`) or a short demo GIF (`demo.gif`). Keep captions and alt text factual; never imply a worktree is a security boundary or that an agent is autonomous.

The HTML uses `data-asset-slot` attributes for future screenshots/GIFs so swapping media does not change the information architecture. The English and `zh/` pages intentionally share these stable files; localize each page's alt text, caption, and surrounding claim when replacing an asset. Do not add third-party tracking pixels without an explicit privacy review.
