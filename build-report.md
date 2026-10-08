# GitHub Pages build

- source: site/
- source_sha: 5f7853399c39511e3e2ed6a51c3d67f5b3d80c11
- languages: English at / and Simplified Chinese at /zh/
- entry_points: index.html, 404.html, zh/index.html, zh/404.html
- output: dist/pages
- deployment_branch: gh-pages
- preservation: peaceiris/actions-gh-pages keep_files=true (appcast.xml)
- local_link_check: passed (appcast.xml is preserved by the release workflow)
