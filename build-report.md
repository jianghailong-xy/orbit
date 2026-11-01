# GitHub Pages build

- source: site/
- source_sha: 1f3a7abf81f08c9478ca1eaa7e3b50e2ea85e03e
- languages: English at / and Simplified Chinese at /zh/
- entry_points: index.html, 404.html, zh/index.html, zh/404.html
- output: dist/pages
- deployment_branch: gh-pages
- preservation: peaceiris/actions-gh-pages keep_files=true (appcast.xml)
- local_link_check: passed (appcast.xml is preserved by the release workflow)
