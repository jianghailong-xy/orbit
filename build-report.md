# GitHub Pages build

- source: site/
- source_sha: 11a5c3cd8c3dbdf9bfab409b442a816b8a8e5c2f
- languages: English at / and Simplified Chinese at /zh/
- entry_points: index.html, 404.html, zh/index.html, zh/404.html
- output: dist/pages
- deployment_branch: gh-pages
- preservation: peaceiris/actions-gh-pages keep_files=true (appcast.xml)
- local_link_check: passed (appcast.xml is preserved by the release workflow)
