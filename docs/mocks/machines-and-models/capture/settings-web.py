# Board prototype (docs/mocks/machines-and-models, 02): on top of rename-web.py, Machines & models leaves the
# sidebar and is reached from Settings — a card on the Settings page, a row in the account menu, and a
# "‹ Settings" link at the top of the page. Only what the shots show. Not shipped code.
import pathlib, sys
web = pathlib.Path(sys.argv[1]) / 'src/web/src'
def edit(rel, pairs):
    p = web / rel; s = p.read_text()
    for old, new, n in pairs:
        assert s.count(old) == n, (rel, old, s.count(old))
        s = s.replace(old, new)
    p.write_text(s)

edit('components/TasksSidePanel.tsx', [
    ("  { key: 'infrastructure', icon: <SidebarNavIcon name=\"runners\" />, label: 'Machines & models' },\n", '', 1),
    ("""            {
              key: 'settings',
              icon: <SettingOutlined />,""", """            {
              key: 'machines',
              icon: <SidebarNavIcon name="runners" />,
              label: 'Machines & models',
              onSelect: () => navigate('/infrastructure'),
            },
            {
              key: 'settings',
              icon: <SettingOutlined />,""", 1),
])

edit('pages/SettingsPage.tsx', [
    ("import { meQuery, type Me, type UserPreferences } from '../lib/queries';",
     """import { meQuery, runnersQuery, type Me, type UserPreferences } from '../lib/queries';
import { providerPoolsQuery } from '../lib/providerPools';
import { machineChipsOf } from '../components/RunnerEngines';
import type { Runner } from '../components/TasksSidePanel';""", 1),
    ("""// Personal preferences.""", """// The phone's Settings row, on the web: what needs you there (an engine signed out on a machine that is
// online, a machine offline, a pool nothing can start on), or with nothing how many machines are online.
function MachinesAndModels() {
  const navigate = useNavigate();
  const runners = useQuery(runnersQuery());
  const pools = useQuery(providerPoolsQuery());
  const machines = (runners.data ?? []) as Runner[];
  const online = machines.filter((runner) => runner.online);
  const needsYou =
    online.reduce((n, runner) => n + machineChipsOf(runner).filter((chip) => chip.signedOut).length, 0) +
    (machines.length - online.length) +
    (pools.data ?? []).filter((pool) => pool.unavailable).length;
  const value = !runners.data
    ? null
    : needsYou > 0
      ? needsYou === 1 ? '1 needs you' : `${needsYou} need you`
      : machines.length === 0 ? 'None' : `${online.length} of ${machines.length} online`;
  return (
    <Card title="Machines & models" style={{ marginBottom: 16 }}>
      {/* Laid out as Sharing and Access tokens are: what it is on the left, Manage on the right; under
          the line the page opens with, what the phone's row says. */}
      <Field
        label="Machines, API keys and account pools"
        hint={
          <>
            Where your agents run, and whose model quota they spend.
            {value && <div className="mm-value" style={{ marginTop: 4, fontSize: 13, color: needsYou > 0 ? 'var(--warning)' : 'var(--text-2)' }}>{value}</div>}
          </>
        }
      >
        <Button onClick={() => navigate('/infrastructure')}>Manage</Button>
      </Field>
    </Card>
  );
}

// Personal preferences.""", 1),
    ("""      <Card title="Notifications" style={{ marginBottom: 16 }}>""", """      <MachinesAndModels />
      <Card title="Notifications" style={{ marginBottom: 16 }}>""", 1),
])

edit('pages/InfrastructurePage.tsx', [
    ("import { useLocation, useNavigate } from 'react-router-dom';", "import { Link, useLocation, useNavigate } from 'react-router-dom';", 1),
    ("""    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <div className="prov-page-head">""", """    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <Link className="provider-back" to="/settings" style={{ marginBottom: 8 }}>
        ‹ Settings
      </Link>
      <div className="prov-page-head">""", 1),
])
print('moved into Settings')
