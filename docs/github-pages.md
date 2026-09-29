# GitHub Pages public entrance

The public entrance is a curated, static pointer to Orbit's first-use path. It is intentionally smaller than the
internal documentation tree and keeps the canonical copy in [docs/messaging-brief.md](messaging-brief.md).

Live URL: <https://jianghailong-xy.github.io/orbit/>

## Information architecture

site/index.html keeps the launch path in this order:

1. First screen — **Orbit — Agent Mission Control**, the category line, the core promise, Quick Start CTA, and
   a 90-second demo CTA.
2. Three launch scenarios — **Work that outlives a chat**, **Parallel agents without checkout collisions**, and
   **Access to private infrastructure**, in that order.
3. 90-second demo storyboard — a link to the checked-in script rather than an invented hosted video.
4. Quick Start — the three operator decisions and a link to the complete README/self-hosting instructions.
5. Architecture and security boundary — outbound runner topology, worktree limitation, operator responsibilities,
   and the explicit no-SaaS/no-SLA boundary.
6. FAQ — hosting, credentials, worktrees, runner loss, runtime support, and release posture.
7. Community/contribution — Discussions, Issues, contribution guide, and private vulnerability reporting.
8. Version and roadmap — pre-1.0 release language, tagged-release guidance, and direction without date promises.

The page links back to the repository for detail; it does not mirror the complete docs/ directory.

## Build and deploy contract

The site has no package or bundler dependency:

~~~
./scripts/build-pages.sh --output dist/pages
~~~

The script copies site/, creates an empty .nojekyll, checks required copy/assets, validates local links and
fragments, and writes dist/pages/build-report.md. A failed command emits a GitHub ::error annotation, appends
the command and line to GITHUB_STEP_SUMMARY, and writes dist/pages-build-diagnostics.txt for the workflow artifact.

.github/workflows/pages.yml runs on main and supports workflow_dispatch. It publishes the generated tree to
the existing gh-pages branch with peaceiris/actions-gh-pages@v4 and keep_files: true. The existing release
workflow publishes Sparkle's appcast.xml to that same branch; keep_files is a required compatibility boundary.
Do not replace it with a deployment that prunes the branch or switches Pages to an artifact-only source
without carrying the appcast forward.

The deployment summary records both URLs:

- <https://jianghailong-xy.github.io/orbit/>
- <https://jianghailong-xy.github.io/orbit/appcast.xml>

## Brand and media interface

Stable slots are documented in [site/assets/README.md](../site/assets/README.md):

- assets/brand/logo.svg
- assets/brand/favicon.svg
- assets/social/og-image.svg (1200×630)
- assets/product/hero-preview.svg
- reserved assets/product/screenshot-*.webp and assets/product/demo.gif

The current preview is explicitly labelled illustrative. A future screenshot/GIF must carry an accurate caption
and must not describe a worktree as a security boundary or imply autonomous completion, an SLA, or managed hosting.

## Funnel and UTM rules

The next iteration measures this sequence, without adding a third-party tracking pixel:

visit → Quick Start click → runner online → first task

Use the same lowercase parameters for links that point back to the Pages entrance:

| Parameter | Allowed values / meaning |
| --- | --- |
| utm_source | github, release, community, or the named external channel |
| utm_medium | readme, issue, discussion, video, social, or docs |
| utm_campaign | a stable release/launch slug such as launch or v0-1-0-beta |
| utm_content | the placement, e.g. nav, quick-start, demo, footer |

Do not put repository names, hostnames, tokens, or user identifiers in UTM values. Record aggregate GitHub/Pages
traffic, sanitized install evidence, runner-heartbeat evidence, and first-task evidence against the same campaign slug.
The event names are page_view, quick_start_click, runner_online, and first_task; instrumentation can be
added after a privacy review.

## Verification checklist

From a checkout:

~~~
./scripts/build-pages.sh --output /tmp/orbit-pages
test -f /tmp/orbit-pages/.nojekyll
test -f /tmp/orbit-pages/404.html
~~~

After a successful Pages workflow, check from both a desktop and a narrow/mobile viewport:

- first screen, nav anchors, Quick Start and repository links;
- all external links and the branded 404 route;
- the exact pre-1.0/security-boundary wording;
- curl -I https://jianghailong-xy.github.io/orbit/ returns 200;
- curl -I https://jianghailong-xy.github.io/orbit/appcast.xml returns 200 and application/xml.

A release must continue to seed the current appcast before generate_appcast and publish with keep_files: true.
