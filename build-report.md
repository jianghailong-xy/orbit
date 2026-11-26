# GitHub Pages build

- source: site/
- source_sha: 2807f998b66d74cde8042ade86a860585a5e3b5d
- languages: English at / and Simplified Chinese at /zh/
- entry_points: index.html, 404.html, zh/index.html, zh/404.html
- output: dist/pages
- deployment_branch: gh-pages
- preservation: peaceiris/actions-gh-pages keep_files=true (appcast.xml)
- local_link_check: passed (appcast.xml is preserved by the release workflow)
- media_check: passed (screenshots match the onboarding evidence set)
- browser_layout_check: run separately with scripts/check-pages-layout.mjs
- external_link_check: run separately with scripts/check-pages-external-links.mjs
