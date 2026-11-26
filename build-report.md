# GitHub Pages build

- source: site/
- source_sha: f31929b4dcb6929ffd6823f6bc8d37f7b4b25717
- languages: English at / and Simplified Chinese at /zh/
- entry_points: index.html, 404.html, zh/index.html, zh/404.html
- output: dist/pages
- deployment_branch: gh-pages
- preservation: peaceiris/actions-gh-pages keep_files=true (appcast.xml)
- local_link_check: passed (appcast.xml is preserved by the release workflow)
- media_check: passed (screenshots match the onboarding evidence set)
- browser_layout_check: run separately with scripts/check-pages-layout.mjs
- external_link_check: run separately with scripts/check-pages-external-links.mjs
