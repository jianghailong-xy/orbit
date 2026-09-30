# Bilingual GitHub Pages entrance evidence (2026-09-30)

This record covers the Simplified Chinese revision of the public entrance. It supplements the original
[English launch record](github-pages-2026-09-29.md) and does not replace the dated clean-install evidence.

## Source and deployment

- Pull request: <https://github.com/jianghailong-xy/orbit/pull/100>
- `main` merge commit: `f5ac57557ca34da6fa9d3912e2272dbf20cd3cdb`
- Pages workflow run: <https://github.com/jianghailong-xy/orbit/actions/runs/36648240289> (**success**)
- Workflow source SHA: `f5ac57557ca34da6fa9d3912e2272dbf20cd3cdb`
- `gh-pages` deployment commit: `4a11612` (`deploy: GitHub Pages f5ac57557ca34da6fa9d3912e2272dbf20cd3cdb`)
- Deployment action used `peaceiris/actions-gh-pages@v4`, `publish_branch: gh-pages`, and `keep_files: true`.

The build log reports four bilingual HTML entry points and a passing local copy/link check. The release-owned
`appcast.xml` was retained on the same `gh-pages` branch.

## Public URLs and HTTP checks

- English: <https://jianghailong-xy.github.io/orbit/> → `200 text/html`
- 简体中文: <https://jianghailong-xy.github.io/orbit/zh/> → `200 text/html`
- English 404 document: <https://jianghailong-xy.github.io/orbit/404.html> → `200 text/html`
- Chinese 404 document: <https://jianghailong-xy.github.io/orbit/zh/404.html> → `200 text/html`
- Missing English route `/does-not-exist-20260930` → `404 text/html`, bilingual branded recovery body
- Missing Chinese route `/zh/does-not-exist-20260930` → `404 text/html`, the same bilingual branded recovery body
- Sparkle feed: <https://jianghailong-xy.github.io/orbit/appcast.xml> → `200 application/xml`

The shared stylesheet, logo, favicon, decorative preview, and social preview each returned `200` with the expected
content type. The Chinese page references them through `../assets/`, so they remain one stable brand-asset contract
rather than duplicated files.

## Build, content, and responsive checks

From the merged checkout:

~~~
./scripts/build-pages.sh --output /tmp/orbit-pages-bilingual
~~~

Result: `Pages link/content check passed (4 bilingual HTML entry points)`. The checker validates English and
`zh-CN` language attributes, `og:locale`, canonical/hreflang links, the explicit 中文 / English switch, required
launch copy, non-empty image alt text, local resources/fragments, and matching section IDs. It emits the expected
release-workflow preservation notes for `appcast.xml`.

Chromium rendered both roots at `1440×1100` and `390×844`. The first screen, sticky navigation, visible mobile
language switch, hero CTA, Quick Start CTA, shared preview asset, and responsive cards rendered without a missing
local resource. External repository, docs, community, release, security, and roadmap links in both language pages
returned HTTP 200 in the link sweep.

## Onboarding evidence and honest gaps

The page and README reuse [clean-install-2026-09-29.md](clean-install-2026-09-29.md): Compose boot, installer/register,
runner heartbeat online, workspace, and isolated worktree passed; the first real agent task was **blocked** by the
provider weekly quota. Therefore this record does not claim a completed first task or a measured conversion funnel.
The planned sequence remains `visit → Quick Start → runner online → first task`, with the lowercase UTM contract in
[`docs/github-pages.md`](../github-pages.md).

The repository's full JavaScript CI baseline remains separately visible in
<https://github.com/jianghailong-xy/orbit/actions/runs/36600717828>: two pre-existing failures
(`src/pages/ProvidersPage.codexLogin.test.tsx` at line 475 and
`src/components/WorkspaceView.sessionDeepLink.test.tsx` at line 320; 248/250 files and 2977/2979 tests passed).
The Pages-specific build/deploy checks are independent of those application-test failures; this site change does not
claim to fix or hide them.
