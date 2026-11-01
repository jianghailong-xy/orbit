# GitHub Pages build

- source: site/
- source_sha: 1f71c0fb7dba9ce84e68fd66ffa1833bbf5e1d0f
- languages: English at / and Simplified Chinese at /zh/
- entry_points: index.html, 404.html, zh/index.html, zh/404.html
- output: dist/pages
- deployment_branch: gh-pages
- preservation: peaceiris/actions-gh-pages keep_files=true (appcast.xml)
- local_link_check: passed (appcast.xml is preserved by the release workflow)
