# GitHub Pages launch evidence (2026-09-29)

This record accompanies the public entrance work. It captures the deployed artifact and the checks that can be
repeated from a clean checkout.

## Deployed artifact

- Public entrance: <https://jianghailong-xy.github.io/orbit/>
- Branded 404 check: a missing route returns HTTP 404 and the branded “That route drifted out of orbit.” page.
- Sparkle feed: <https://jianghailong-xy.github.io/orbit/appcast.xml>
- Pages source branch: gh-pages
- Pages deployment commit: b61eb07a807cccee0ab01346c217747f28d8c92c
- GitHub Pages deployment run: <https://github.com/jianghailong-xy/orbit/actions/runs/36597759343> (success)
- Build source SHA recorded in the deployed build-report.md:
  9b28779020644509214dc05a34c00057dedb8e9f

The bootstrap publish copied the generated static tree into the existing gh-pages branch while excluding
appcast.xml. The committed release workflow and pages.yml both use keep_files: true; after the source
change is merged to main, pages.yml will reproduce the same publish path.

## Reproducible checks

Local build and content/link validation:

~~~
./scripts/build-pages.sh --output /tmp/orbit-pages
~~~

Result: required files, .nojekyll, HTML fragments, canonical launch copy, and local links passed. The only
expected note is that appcast.xml is supplied by the release workflow and preserved during deployment.

The generated site was rendered with Chromium at 1440×1000 (desktop) and 390×844 (mobile). The first screen,
nav, CTA, brand asset, responsive layout, and architecture preview rendered without a missing local asset. The
same mobile viewport rendered 404.html with the expected branded recovery links.

The following repository links returned HTTP 200 in an external-link sweep: repository, messaging brief,
90-second storyboard, self-hosting, SECURITY.md, architecture, Discussions, Issues, CONTRIBUTING.md, Security,
Releases, ROADMAP.md, and project maturity.

## Online HTTP checks

On the deployed URL:

- GET / → 200 text/html
- GET /assets/site.css → 200 text/css
- GET /assets/brand/favicon.svg → 200 image/svg+xml
- GET /appcast.xml → 200 application/xml
- GET /does-not-exist → 404 text/html, branded body present

The appcast SHA-256 before the site publish and after it was
e37c2c71c0e07400b62298d1084641a8be2bef7503fc6138b499993bc55596bd, demonstrating that the existing feed was
not overwritten.

## Follow-up funnel

The page and Pages operations guide (../github-pages.md) reserve the sequence
visit → Quick Start click → runner online → first task, with lowercase utm_source, utm_medium,
utm_campaign, and utm_content values. No third-party tracking pixel is shipped; future instrumentation
requires a privacy review.
