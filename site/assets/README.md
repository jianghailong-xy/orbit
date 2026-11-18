# Public-site asset contract

The landing page deliberately keeps brand and product media behind stable, replaceable paths:

- `brand/logo.svg` — horizontal logo for the header and future press use.
- `brand/favicon.svg` — browser and pinned-tab mark.
- `social/og-image.svg` — editable 1200×630 social-card source.
- `social/og-image.png` — the shipped 1200×630 raster. Social platforms do not reliably render SVG previews, so every page points `og:image` and `twitter:image` here. Re-render it with `rsvg-convert -w 1200 -h 630 social/og-image.svg -o social/og-image.png` whenever the SVG changes.
- `product/screenshot-task-graph.png` — the current UI's project page: task graph, run queue, acceptance criteria.
- `product/screenshot-runner.png` — the current UI's new-workspace form on a registered machine, with its online heartbeat.
- `product/screenshot-approval.png` — the current UI waiting for approval, showing the exact command and the approve/allow/reject actions.
- `product/screenshot-result.png` — the current UI's succeeded session with tool calls, test output, reply, and the composer.

The four product screenshots are byte-identical copies of the onboarding evidence set
(`docs/images/onboarding/05-task-graph.png`, `03-first-workspace.png`, `06-approval.png`, and `04-session.png`).
They are real current-UI captures, not mockups. Refresh both copies together; `scripts/check-pages-media.mjs`
fails the Pages build when they drift, when a declared `width`/`height` stops matching the file, or when the
social image is not 1200×630 PNG.

Keep captions and alt text factual: identify the screen and the visible state, keep the demo-data note, and never
imply that a worktree is a security boundary, that an agent is autonomous, or that the public host is a managed
deployment. The English and `zh/` pages share these files; localize each page's alt text, caption, and
surrounding claim when replacing an asset.

A reader-facing short recording can replace the four-step walkthrough later. If one is added, put it under
`product/`, label it as a recording rather than a live deployment, and keep the checked-in
[90-second storyboard](../../docs/90-second-demo.md) as its script. Do not add third-party tracking pixels
without an explicit privacy review.
