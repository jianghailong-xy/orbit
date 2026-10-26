# Board prototype (docs/mocks/machines-and-models): the web's chrome names the page "Machines & models".
# Only what the shots show: the sidebar label, the page heading and the back links. Not shipped code.
import pathlib, sys
web = pathlib.Path(sys.argv[1]) / 'src/web/src'
def edit(rel, pairs):
    p = web / rel; s = p.read_text()
    for old, new, n in pairs:
        assert s.count(old) == n, (rel, old, s.count(old))
        s = s.replace(old, new)
    p.write_text(s)
edit('components/TasksSidePanel.tsx', [("label: 'Infrastructure' }", "label: 'Machines & models' }", 1)])
edit('pages/InfrastructurePage.tsx', [("""<h1 className="page-title" style={{ marginBottom: 0 }}>
          Infrastructure
        </h1>""", """<h1 className="page-title" style={{ marginBottom: 0 }}>
          Machines &amp; models
        </h1>""", 1)])
edit('pages/ProviderConnectPage.tsx', [("‹ Infrastructure", "‹ Machines & models", 3)])
edit('pages/ProviderPoolPage.tsx', [("‹ Infrastructure", "‹ Machines & models", 3)])
print('renamed')
