# The infra-focus prototype: applied to a copy of the tree (proposal/). Not shipped code.
import sys, re, pathlib, shutil
tree = pathlib.Path(sys.argv[1]); here = pathlib.Path(__file__).parent
web = tree / 'src/web/src'

def edit(rel, pairs):
    p = web / rel; s = p.read_text()
    for old, new in pairs:
        assert s.count(old) == 1, (rel, old[:60], s.count(old))
        s = s.replace(old, new)
    p.write_text(s)

shutil.copy(here / 'ProviderKeyCards.tsx', web / 'components/ProviderKeyCards.tsx')

# ── overview: cards | compact | strip ──
edit('components/InfrastructureOverview.tsx', [
  ("export function EngineOverview({\n  runners,\n  keys,\n  pools,\n}: {", "function EngineCards({\n  runners,\n  keys,\n  pools,\n}: {"),
])
(web / 'components/InfrastructureOverview.tsx').open('a').write('''
/** PROTOTYPE (docs/mocks/infra-focus): the same overview as a compact list at the end of the page, or a
 *  one-line strip under its head. `cards` is today's. */
export function EngineOverview({ runners, keys, pools, variant = 'cards' }: { runners: Runner[]; keys: ProviderRow[]; pools: ProviderPool[]; variant?: 'cards' | 'compact' | 'strip' }) {
  if (variant === 'cards') return <EngineCards runners={runners} keys={keys} pools={pools} />;
  const online = runners.filter((runner) => runner.online);
  const installOn = (engine: AgentProvider) =>
    online.length > 0 ? `?runner=${encodeId(online[0].id)}&engine=${engine}` : '/runners/register';
  const entries = ALL_ENGINES.filter((engine) => webShowsEngine(engine, runners)).map((engine) => {
    const machines =
      engine === AgentProvider.DSH
        ? []
        : online.flatMap((runner) => {
            const logins = loginsOn(runner, engine);
            return logins === 0 ? [] : [logins > 1 ? `${machineName(runner)} ×${logins}` : machineName(runner)];
          });
    const engineKeys = keys.filter((key) => key.enabled && key.engines.includes(engine));
    const enginePools = pools.filter((pool) => !pool.unavailable && (poolRunsCodex(pool) ? 'codex' : 'claude') === engine);
    return { engine, machines, engineKeys, enginePools, ready: machines.length > 0 || engineKeys.length > 0 || enginePools.length > 0 };
  });
  const none = (engine: AgentProvider) =>
    engine === AgentProvider.DSH ? (
      <>No DeepSeek key. <Link to={DSH_CONNECT_HREF}>Connect a DeepSeek key</Link> — it runs on Claude Code and OpenCode too.</>
    ) : (
      <>No machine signed in, no key. <Link to={installOn(engine)}>Install on a machine</Link> or <Link to={engine === AgentProvider.CURSOR ? CURSOR_CONNECT_HREF : '/providers/new'}>connect a key</Link>.</>
    );
  if (variant === 'strip') {
    return (
      <div className="infra-strip">
        {entries.map((e) => (
          <span key={e.engine} className={`infra-strip-pill${e.ready ? '' : ' none'}`}>
            <EngineTile engine={e.engine} size={14} />
            {ENGINE_CLI_NAMES[e.engine]}
            <span className="infra-strip-mark">{e.ready ? '✓' : 'not set up'}</span>
          </span>
        ))}
      </div>
    );
  }
  return (
    <div className="re-sec infra-index-sec">
      <div className="re-sec-head">
        <h3>By engine</h3>
        <span className="re-sec-sub">Which engines can start a session right now, and on what — read from the machines, keys and pools above.</span>
      </div>
      <div className="infra-index">
        {entries.map((e) => {
          const parts = [
            e.machines.length > 0 && <span key="m"><b>{e.engine === AgentProvider.OPENCODE ? 'Own sign-in' : 'Subscription'}</b> · {e.machines.join(', ')}</span>,
            e.engineKeys.length > 0 && <span key="k"><b>API key</b> · {e.engineKeys.map((key) => key.label).join(', ')}</span>,
            e.enginePools.length > 0 && <span key="p"><b>Pool</b> · {e.enginePools.map((pool) => pool.label).join(', ')}</span>,
          ].filter(Boolean);
          return (
            <div key={e.engine} className={`infra-index-row${e.ready ? '' : ' none'}`}>
              <EngineTile engine={e.engine} size={20} />
              <span className="infra-index-name">{ENGINE_CLI_NAMES[e.engine]}</span>
              <span className={`infra-engine-state${e.ready ? ' ready' : ''}`}>{e.ready ? 'Ready' : 'Not set up'}</span>
              <span className="infra-index-src">
                {e.ready
                  ? parts.map((part, index) => (
                      <Fragment key={index}>
                        {index > 0 && <span className="infra-index-sep">·</span>}
                        {part}
                      </Fragment>
                    ))
                  : none(e.engine)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
''')

# ── machine card: chips row in the head, sign-in counts off the summary ──
edit('components/RunnerEngines.tsx', [
  ("import { ProviderTile } from './ProviderGallery';", "import { EngineTile, ProviderTile } from './ProviderGallery';"),
  ("""        {(!runner.online || collapsed) && (
          <div className="re-runner-status">
            {!runner.online && <Badge>Offline</Badge>}
            {collapsed && (
              <span className={`re-summary${failed ? ' warn' : ''}`}>
                {failed && <WarningOutlined aria-hidden />}{summaryOf(runner)}
              </span>
            )}
          </div>
        )}""",
   """        {(!runner.online || (collapsed && machineState(runner))) && (
          <div className="re-runner-status">
            {!runner.online && <Badge>Offline</Badge>}
            {collapsed && machineState(runner) && (
              <span className={`re-summary${failed ? ' warn' : ''}`}>
                {failed && <WarningOutlined aria-hidden />}{machineState(runner)}
              </span>
            )}
          </div>
        )}"""),
  ("""          }
        />
      </div>
      {!collapsed && (
        <MachineEngines""",
   """          }
        />
        <MachineChips
          runner={runner}
          fleet={fleet}
          onSignIn={(engine) => {
            if (collapsed) onToggle();
            setSignIn(ownSignInPanel(runner, engine));
          }}
        />
      </div>
      {!collapsed && (
        <MachineEngines"""),
  ("\nfunction RunnerEngineCard({", '''
/** PROTOTYPE (docs/mocks/infra-focus). The machine-level states the folded head still says at its end:
 *  an install or update in flight or failed, an engine not updating. Who is signed in is the chips'. */
function machineState(runner: Runner): string | null {
  const summary = summaryOf(runner);
  return /signed in$/.test(summary) ? null : summary;
}

/** PROTOTYPE (docs/mocks/infra-focus). What sessions on this machine can run on: a chip per engine
 *  signed in (×N accounts), and the engines signed out — amber, each with its own Sign in, which opens
 *  the card on that engine's sign-in. Engines not installed, and ones whose CLI wouldn't say, are left out. */
function MachineChips({
  runner,
  fleet,
  onSignIn,
}: {
  runner: Runner;
  fleet: readonly CursorRunnerFacts[];
  onSignIn: (engine: LoginEngine) => void;
}) {
  const chips: Array<{ key: string; engine: AgentProvider; count: number; out: boolean }> = [];
  const engines: Array<RowEngine | 'cursor'> = [
    ...rowEnginesOf(runner.engines ?? []),
    ...(webShowsEngine('cursor', fleet) ? (['cursor'] as const) : []),
  ];
  for (const engine of engines) {
    const health = engineHealthOf(runner, engine as RowEngine);
    if (!health?.installed) continue;
    if (engine === 'antigravity' && runner.antigravity?.supported === false) continue;
    if (engine === 'cursor' && cursorRunnerState(runner) !== 'ready') continue;
    const accounts = health.accounts ?? [];
    const count = accounts.length === 0 ? (health.auth === 'yes' ? 1 : 0) : accounts.filter((account) => account.auth === 'yes' || runsOnEnvKey(health, account)).length;
    const out = count === 0 && engine !== 'opencode' && (health.auth === 'no' || accounts.some((account) => account.auth === 'no'));
    if (count === 0 && !out) continue;
    chips.push({ key: engine, engine: engine as AgentProvider, count, out });
  }
  const dsh = runner.engines?.find((e) => e.engine === 'dsh');
  if (dsh?.installed && dsh.dsh?.versionCompatible !== false) chips.push({ key: 'dsh', engine: AgentProvider.DSH, count: 1, out: false });
  if (chips.length === 0) return null;
  return (
    <div className="re-chips">
      {chips.map((chip) => (
        <span className="re-chip-pair" key={chip.key}>
          <span className={`re-chip-eng${chip.out ? ' out' : ''}`}>
            <EngineTile engine={chip.engine} size={14} />
            {ENGINE_CLI_NAMES[chip.engine]}
            {chip.count > 1 && <span className="re-chip-n">×{chip.count}</span>}
            {chip.out && <span className="re-chip-out">signed out</span>}
          </span>
          {chip.out && (
            <Button size="small" variant="primary" className="re-chip-signin" onClick={() => onSignIn(chip.engine as LoginEngine)}>
              Sign in
            </Button>
          )}
        </span>
      ))}
    </div>
  );
}

function RunnerEngineCard({'''),
])

# ── the page: machines, keys (cards), pools, then the engine index ──
page = web / 'pages/InfrastructurePage.tsx'; s = page.read_text()
head, _ = s.split('export function InfrastructurePage() {', 1)
s = head + '''/** PROTOTYPE switches for the board's variant frames (docs/mocks/infra-focus). Not shipped. */
const proto = {
  banner: typeof localStorage !== 'undefined' && localStorage.getItem('proto:banner') === '1',
  strip: typeof localStorage !== 'undefined' && localStorage.getItem('proto:strip') === '1',
};

export function InfrastructurePage() {
  const message = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { hash } = useLocation();
  const [confirm, confirmHolder] = useConfirm();
  const keySection = useRef<HTMLDivElement>(null);
  const poolSection = useRef<HTMLDivElement>(null);
  const runners = useQuery(runnersQuery());
  const machines = (runners.data ?? []) as Runner[];
  const online = machines.filter((runner) => runner.online);
  const busySlots = online.reduce((n, runner) => n + (runner.activeSessions ?? 0), 0);
  const allSlots = online.reduce((n, runner) => n + (runner.maxConcurrent ?? 0), 0);
  const workspaces = (useQuery(workspacesQuery()).data ?? []) as Array<AttentionWorkspace & { runnerId?: string | null }>;
  const latestVersion = latestRunnerVersion(useQuery(publishedRunnerVersionQuery()).data, machines);
  const nowMs = Date.now();
  const attentionOf = (runner: Runner) =>
    runnerAttention({ runner, workspaces: workspaces.filter((workspace) => workspace.runnerId === runner.id), nowMs, latestVersion });
  const providers = useQuery({ queryKey: PROVIDERS_LIST_KEY, queryFn: () => api<ProviderRow[]>(PROVIDERS_BASE) });
  const pools = useQuery({ ...providerPoolsQuery(), refetchInterval: 60_000 });
  const shared = useQuery({ ...sharedPoolsQuery(), refetchInterval: 60_000 });
  const access = useQueries({
    queries: (pools.data ?? []).filter(isLoginPool).map((pool) => ({ ...poolAccessQuery(pool.id), refetchInterval: 60_000 })),
  });
  const accessOf = new Map(access.flatMap((read) => (read.data ? [[routeId(read.data.id), read.data] as const] : [])));
  const poolList = [
    ...(shared.data ?? []).map(sharedPoolAsProviderPool),
    ...(pools.data ?? []).map((pool) => {
      const view = accessOf.get(routeId(pool.id));
      return view ? ownPoolWithAccess(pool, view) : pool;
    }),
  ];
  const rows = providers.data ?? [];
  const eligible = poolEligibleCount(rows);
  const refusals = poolRefusals(rows);
  const [creatingPool, setCreatingPool] = useState(false);
  const settled = !runners.isPending && !providers.isPending && !pools.isPending && !shared.isPending;

  const target = hash === '#keys' ? keySection : hash === '#pools' ? poolSection : null;
  const arrived = target !== null && settled;
  useEffect(() => {
    if (arrived) target?.current?.scrollIntoView({ block: 'start' });
  }, [arrived, target]);

  const deleteMut = useMutation({
    mutationFn: (id: string) => api(`${PROVIDERS_BASE}/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PROVIDERS_LIST_KEY });
      void qc.invalidateQueries({ queryKey: providersQuery().queryKey });
      message.success('Provider deleted');
    },
  });
  const deleteKey = (p: ProviderRow) =>
    void confirm({
      title: `Delete ${p.label}?`,
      description: <KeyImpact row={p} action="delete" />,
      confirmText: 'Delete key',
      danger: true,
      width: 440,
      onConfirm: () => deleteMut.mutateAsync(p.id),
    });

  const addItems: MenuItem[] = [
    { key: 'machine', textValue: 'Register a machine', label: (<span className="infra-add"><b>Register a machine</b><span>Run agents on a computer you own, on its subscriptions</span></span>), onSelect: () => navigate('/runners/register') },
    { key: 'key', textValue: 'Connect an API key', label: (<span className="infra-add"><b>Connect an API key</b><span>Usable from every machine, billed per token</span></span>), onSelect: () => navigate('/providers/new') },
    { key: 'pool', textValue: 'New account pool', label: (<span className="infra-add"><b>New account pool</b><span>Several accounts behind one name</span></span>), onSelect: () => setCreatingPool(true) },
  ];

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <div className="prov-page-head">
        <h1 className="page-title" style={{ marginBottom: 0 }}>
          Infrastructure
        </h1>
        <Menu align="end" items={addItems} trigger={<Button variant="primary">Add <DownOutlined /></Button>} />
        <div className="prov-page-sub">Where your agents run, and whose model quota they spend.</div>
      </div>

      {settled && proto.banner && <NeedsAttention runners={machines} pools={poolList} />}
      {settled && proto.strip && <EngineOverview variant="strip" runners={machines} keys={rows} pools={poolList} />}

      <div id="machines">
        <RunnerEngines
          attentionOf={attentionOf}
          head={
            <div className="re-sec-head">
              <h3>Machines</h3>
              <span className="re-sec-sub">Subscriptions signed in here are spent only by sessions on that machine.</span>
              {machines.length > 0 && (
                <span className="re-sec-count">
                  {machines.length} machine{machines.length === 1 ? '' : 's'} · {busySlots} / {allSlots} slots busy
                </span>
              )}
            </div>
          }
        />
      </div>

      <div ref={keySection} id="keys">
        <div className="re-sec-head" style={{ marginTop: 28 }}>
          <h3>API keys</h3>
          <span className="re-sec-sub">On your account and usable from every machine — billed per token.</span>
          {rows.length > 0 && <span className="re-sec-count">{rows.length} key{rows.length === 1 ? '' : 's'}</span>}
        </div>
        {pools.isSuccess && pools.data.length === 0 && eligible >= 2 && <PoolHint rows={rows} eligible={eligible} />}
        {providers.isLoading ? null : rows.length === 0 ? (
          <div className="provider-empty">
            <h3>No keys yet</h3>
            <p>Pick a provider and paste your API key — or skip it and sign a machine in above.</p>
            <ProviderGallery />
          </div>
        ) : (
          <>
            <ProviderKeyCards rows={rows} nowMs={nowMs} onDelete={deleteKey} />
            <ConnectMore rows={rows} />
          </>
        )}
      </div>

      <div ref={poolSection} id="pools">
        {!pools.isPending && !shared.isPending && <AccountPools pools={poolList} refusals={refusals} rows={rows} />}
      </div>

      {settled && !proto.strip && <EngineOverview variant="compact" runners={machines} keys={rows} pools={poolList} />}

      {creatingPool && <NewPoolModal rows={rows} onClose={() => setCreatingPool(false)} />}
      {confirmHolder}
    </div>
  );
}
'''
s = s.replace("import { EngineTile, ProviderGallery, ProviderTile, vendorName, vendorOf } from '../components/ProviderGallery';",
              "import { ProviderGallery } from '../components/ProviderGallery';\nimport { ConnectMore, ProviderKeyCards } from '../components/ProviderKeyCards';")
page.write_text(s)

(web / 'index.css').open('a').write((here / 'proto.css').read_text())
print('applied')
