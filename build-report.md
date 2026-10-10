# GitHub Pages build

- source: site/
- source_sha: 8e3ed0e4e34cbc288b4b1eb4c534ae21d4b1ee86
- languages: English at / and Simplified Chinese at /zh/
- entry_points: index.html, 404.html, zh/index.html, zh/404.html
- output: dist/pages
- deployment_branch: gh-pages
- preservation: peaceiris/actions-gh-pages keep_files=true (appcast.xml)
- local_link_check: passed (appcast.xml is preserved by the release workflow)
