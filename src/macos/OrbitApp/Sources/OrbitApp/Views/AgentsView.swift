import SwiftUI
import OrbitKit

// Batch D + Agents-in-sidebar refinement: the agent *list* (grouped by runner) now lives in the
// sidebar source list (see `SectionSidebar`), folding away the old middle column. What remains
// here is the selected agent's detail, split across the two right panes to mirror Open:
//   • content column → the agent's sessions as a plain list; the window toolbar hosts the
//                       Open/Completed/Trash scope switcher (principal), a New-session button
//                       (leading), and a gear that opens the agent's Settings sheet (trailing)
//   • detail column  → the live console for the session picked in the content column
// Grouping comes from the verified OrbitKit `AgentListLogic`; Runtime/model pickers reuse
// `AgentDefaults`. SwiftUI here is parse-checked only — verify on a Mac.
//
// IA note: the web edits agents *inside* the Runner detail page (an agent belongs to a runner);
// this surfaces a flatter Agents nav whose items are the agents themselves.

/// A row for an agent in the sidebar disclosure: name (+ disabled pill) over runtime · workDir.
/// `shortcutIndex`, when set (the first nine agents), shows a faint "⌘N" hint for the switch
/// shortcut so it's learnable.
struct AgentRowView: View {
    let agent: Agent
    var shortcutIndex: Int? = nil
    var configuredProviders: [ConfiguredProvider] = []
    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(agent.name).lineLimit(1)
                    if agent.enabled == false {
                        Text("disabled").font(.orbitMeta)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(.quaternary, in: Capsule())
                    }
                }
                Text(AgentDefaults.providerName(agent.defaultProvider, configured: configuredProviders)
                     + (agent.workDir.map { " · \($0)" } ?? ""))
                    .font(.orbitListSubtitle).foregroundStyle(.secondary).lineLimit(1)
            }
            if let shortcutIndex {
                Spacer(minLength: 4)
                Text("⌘\(shortcutIndex + 1)")
                    .font(.orbitMeta).monospacedDigit()
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
    }
}

/// Content (middle) column for the Agents section: the selected agent's sessions, with a toolbar
/// gear to edit the agent. Selecting a session drives the console in the detail column.
struct AgentContentColumn: View {
    @Environment(AppModel.self) private var app
    var body: some View {
        @Bindable var app = app
        if let agents = app.agents, let id = app.selectedAgentID, let a = agents.agent(id) {
            AgentPanes(agents: agents, agent: a, selectedSessionID: $app.selectedAgentSessionID)
                .id(a.id)
                .navigationTitle(a.name)
        } else {
            ContentUnavailableView("Select an agent", systemImage: "person.2",
                                   description: Text("Pick an agent in the sidebar to see its sessions and settings."))
        }
    }
}

struct AgentPanes: View {
    @Environment(AppModel.self) private var app
    let agents: AgentsModel
    let agent: Agent
    @Binding var selectedSessionID: String?
    @State private var view: SessionView = .open
    @State private var showSettings = false
    /// The row whose "Tags…" action was tapped — drives the tag picker sheet. Owned by the list (not
    /// the row's context menu) so the sheet presents reliably.
    @State private var taggingSession: Session?
    /// The tag filter chip selection (a tag id), or nil for "All" (iOS list only).
    @State private var tagFilter: String?
    /// Whether the iOS list is grouped by tag instead of by recency (iOS list only).
    @State private var groupByTag = false
    #if os(iOS)
    /// The inline search field's text, and what came back for it. The list searches in place —
    /// results replace its sections — rather than opening the palette sheet over the very list
    /// you're looking at.
    @State private var searchQuery = ""
    @State private var hits: [SessionSearchHit] = []
    /// The query `hits` came from — what their snippets are highlighted against, so highlighting
    /// can't run ahead of the results while typing.
    @State private var hitsQuery = ""
    @State private var contentSearched = true
    @State private var searching = false
    #endif
    // Set true when the composer hands ↑/↓ back on Escape, so the session list can be arrow-navigated
    // without a click; the binding also tracks click-to-focus.
    @FocusState private var listFocused: Bool

    var body: some View {
        // Option B: the column is just the session list. The scope switcher and New-session action
        // live in the window toolbar (below) — like Finder/Mail hosting view controls in the toolbar
        // rather than stacking chrome bands above the list.
        List(selection: $selectedSessionID) {
            #if os(iOS)
            // ChatGPT-style recency sections (Pinned / Today / Yesterday / Previous 7 Days / …) — a
            // deliberate divergence from web's flat list, grouping the tall single-column iPhone list
            // by last activity. Bucketing is the pure, tested `SessionTimeGrouping`. macOS keeps the
            // flat list (its 3-pane window reads fine without sections).
            // Optional "By Tag" grouping (one Section per tag + Untagged) or the default recency
            // sections; the tag filter chip narrows either. Both are the pure, tested OrbitKit
            // groupers over the same console-sorted, tag-filtered list (`shownSessions`).
            if isSearching {
                searchResults
            } else if groupByTag {
                ForEach(SessionTagGrouping.sections(shownSessions)) { section in
                    Section {
                        ForEach(section.sessions) { sessionRow($0) }
                    } header: {
                        tagSectionHeader(section.tag)
                    }
                }
            } else {
                ForEach(SessionTimeGrouping.sections(shownSessions, pinnedFirst: view == .open && tagFilter == nil)) { section in
                    Section {
                        ForEach(section.sessions) { sessionRow($0) }
                    } header: {
                        Text(section.title).textCase(nil)
                    }
                }
            }
            #else
            ForEach(agents.agentSessions) { s in
                AgentSessionRow(session: s, deleted: view == .trash,
                                showsPin: view == .open).tag(s.id)
                    .sessionRowActions(s, scope: view, onTag: { taggingSession = s })
            }
            #endif
        }
        .orbitRevealSurface()   // macOS: reveal the unified `orbitSurface`
        #if os(iOS)
        // Plain style so the sections read as light headers over full-width rows (matching the
        // current list), not boxed inset-grouped cards.
        .listStyle(.plain)
        #endif
        .focused($listFocused)
        .onChange(of: app.sessionListFocusRequest) { _, _ in listFocused = true }
        .overlay {
            if isSearching {
                #if os(iOS)
                // Only once a search has actually answered: `hitsQuery` is empty until the first
                // response lands, and holding the empty state back over that gap (and over every
                // later keystroke, via `searching`) keeps "No matches" from flashing at someone
                // who is still typing.
                if hits.isEmpty && !searching && !hitsQuery.isEmpty {
                    ContentUnavailableView("No matches", systemImage: "magnifyingglass",
                                           description: Text("Nothing matches \u{201C}\(hitsQuery)\u{201D}."))
                }
                #endif
            } else if agents.agentSessions.isEmpty {
                ContentUnavailableView(
                    agents.sessionsLoading ? "Loading…" : "No \(view.title.lowercased()) sessions",
                    systemImage: "bubble.left.and.bubble.right")
            }
        }
        // Picking a session leaves the compose state (the console takes over the detail pane).
        .onChange(of: selectedSessionID) { _, new in
            if new != nil { app.composingAgentSession = false }
        }
        #if os(iOS)
        // Pull-to-refresh reloads the current agent + scope's sessions on demand (matching the
        // Open/Tasks/Runners lists). The pull control shows its own spinner, so reload *without*
        // `reset:` to update the rows in place rather than blanking the list mid-gesture.
        .refreshable { await agents.loadSessions(agentID: agent.id, view: view) }
        // Search, in the list rather than over it. Until now it was only reachable from inside the
        // drawer (or ⌘K, which needs a keyboard), so the list itself looked like it had none.
        // `.navigationBarDrawer` is what keeps the field *below* the agent title instead of over
        // it — the system owns that layout, which a hand-placed bar can't do — and `.always` keeps
        // it visible rather than hidden until you pull down, since not being able to find it is
        // what started this. Typing searches the server (every agent, scope and message text) and
        // shows the hits here; clearing the field restores the sections.
        .searchable(text: $searchQuery,
                    placement: .navigationBarDrawer(displayMode: .always),
                    prompt: "Search sessions")
        .task(id: searchQuery) { await runSearch() }
        #endif
        // Reload when either the agent or the view changes (one key so a fast switch coalesces), so
        // external changes (new sessions, status transitions made from the web) show up without
        // reopening the agent. The task is bound to this pane's lifetime: switching agent/view
        // cancels and restarts it.
        //
        // Only Completed / Trash poll for themselves. Open is served by `AppModel`'s shared snapshot
        // (`AgentsModel.applyOpenSnapshot`), which the control-plane stream updates per event and a
        // 4s tick backstops — the same freshness this loop provided, minus a second full fetch of
        // the identical payload on an independent timer. That duplicate mattered most exactly when
        // the list was busiest: with several sessions running, the two cadences interleaved into a
        // near-continuous stream of whole-list decodes and list diffs.
        .task(id: "\(agent.id)|\(view.rawValue)") {
            await agents.loadSessions(agentID: agent.id, view: view, reset: true)
            guard view != .open else { return }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                if Task.isCancelled { break }
                await agents.loadSessions(agentID: agent.id, view: view)
            }
        }
        .toolbar {
            #if os(iOS)
            // Compact: both actions sit at the trailing edge. The scope switcher collapses to a
            // pure filter-icon menu (no text) — Open/Completed/Trash as checkmarked options plus
            // the agent-settings gear folded in — and New Session is the rightmost primary action.
            // Declared scope-first so New Session lands at the trailing edge (SwiftUI lays trailing
            // items out in declaration order, leading→trailing; verify the order on device).
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    ForEach(SessionView.pickerCases) { v in
                        Button { view = v } label: {
                            if v == view { Label(v.title, systemImage: "checkmark") }
                            else { Text(v.title) }
                        }
                    }
                    if !app.sessionTags.isEmpty {
                        Divider()
                        // Filter by tag lives here (a submenu) rather than a persistent chip row above
                        // the list — the row read as clutter. A checkmark marks the active tag; "All"
                        // clears it, and the toolbar icon fills below to signal an active filter.
                        Menu {
                            Button { tagFilter = nil } label: {
                                if tagFilter == nil { Label("All", systemImage: "checkmark") } else { Text("All") }
                            }
                            ForEach(app.sessionTags) { t in
                                Button { tagFilter = (tagFilter == t.id ? nil : t.id) } label: {
                                    if tagFilter == t.id { Label(t.name, systemImage: "checkmark") } else { Text(t.name) }
                                }
                            }
                        } label: {
                            Label("Filter by Tag", systemImage: "tag")
                        }
                        Button { groupByTag.toggle() } label: {
                            if groupByTag { Label("Group by Tag", systemImage: "checkmark") }
                            else { Text("Group by Tag") }
                        }
                    }
                    Divider()
                    Button { showSettings = true } label: {
                        Label("Settings", systemImage: "gearshape")
                    }
                } label: {
                    // Filled variant when a tag filter is active, so the (now chip-less) filter state
                    // stays visible at a glance.
                    Image(systemName: tagFilter == nil ? "line.3.horizontal.decrease" : "line.3.horizontal.decrease.circle.fill")
                }
                .accessibilityLabel("Session scope, \(view.title)")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    app.startComposingSession()
                } label: {
                    Label("New session", systemImage: "square.and.pencil")
                }
                .accessibilityLabel("Start a new session with \(agent.name)")
            }
            #else
            // macOS: the wide window toolbar keeps the platform-idiomatic layout — New Session
            // (leading), a compact centered segmented scope switcher (principal), and a settings gear.
            ToolbarItem(placement: .navigation) {
                Button {
                    app.startComposingSession()
                } label: {
                    Label("New session", systemImage: "square.and.pencil")
                }
                .help("Start a new session with \(agent.name)")
            }
            ToolbarItem(placement: .principal) {
                Picker("View", selection: $view) {
                    ForEach(SessionView.pickerCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
            }
            ToolbarItem(placement: .primaryAction) {
                Button { showSettings = true } label: {
                    Label("Settings", systemImage: "gearshape")
                }
                .help("Edit this agent")
            }
            #endif
        }
        .sheet(isPresented: $showSettings) {
            AgentSettingsSheet(agents: agents, agent: agent)
        }
        // The tag picker for the row whose "Tags…" action was tapped (list-owned for reliable
        // presentation). Works on both platforms; the filter chips / grouping above are iOS-only.
        .sheet(item: $taggingSession) { s in
            SessionTagSheet(session: s).environment(app)
        }
        // Load the owner's tag library when the pane appears so the picker + chips are populated.
        .task { await app.loadSessionTags() }
    }

    // The sessions to show: the agent list, narrowed to the tag filter chip when one is active.
    private var shownSessions: [Session] {
        guard let f = tagFilter else { return agents.agentSessions }
        return SessionFilter.withTag(agents.agentSessions, tagID: f)
    }

    /// True while the list is showing search results in place of its sections. Always false on
    /// macOS, whose window searches from the ⌘K palette instead.
    private var isSearching: Bool {
        #if os(iOS)
        return !searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        #else
        return false
        #endif
    }

    #if os(iOS)
    /// Search results, standing in for the session sections while the field has text. They're the
    /// palette's rows (agent · what matched · snippet, with a Completed/Trash badge), not session
    /// rows: the search spans every agent and scope, so a hit has to say where it lives rather than
    /// pose as a row of *this* agent's list. Tapping one opens it, switching agent if it belongs to
    /// another.
    @ViewBuilder private var searchResults: some View {
        Section {
            ForEach(hits) { hit in
                Button { app.route(to: .session(hit.id)) } label: {
                    SessionSearchRow(hit: hit, query: hitsQuery)
                }
                .buttonStyle(.plain)
            }
        } header: {
            // Doubles as the short-query notice the palette keeps in its footer: below the
            // server's content threshold only names are matched, which is worth saying before
            // "no matches" reads as "this doesn't exist".
            Text(contentSearched
                 ? "All sessions"
                 : "Matching names only — type more to search message text.")
                .textCase(nil)
        }
    }

    /// Debounced server-side search behind the field. `.task(id:)` cancels the previous run on each
    /// keystroke, so the sleep *is* the debounce — a cancelled run never reaches the request.
    private func runSearch() async {
        let q = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else {
            hits = []
            hitsQuery = ""
            return
        }
        try? await Task.sleep(for: sessionSearchDebounce)
        if Task.isCancelled { return }
        searching = true
        defer { searching = false }
        guard let res = await app.searchSessions(q), !Task.isCancelled else { return }
        hits = res.hits
        contentSearched = res.contentSearched
        hitsQuery = res.q
    }
    #endif

    @ViewBuilder private func sessionRow(_ s: Session) -> some View {
        AgentSessionRow(session: s, deleted: view == .trash, showsPin: view == .open).tag(s.id)
            .sessionRowActions(s, scope: view, onTag: { taggingSession = s })
    }

    @ViewBuilder private func tagSectionHeader(_ tag: SessionTag?) -> some View {
        if let tag {
            HStack(spacing: 6) {
                Circle().fill(Color(tagHex: tag.color)).frame(width: 8, height: 8)
                Text(tag.name).textCase(nil)
            }
        } else {
            Text("Untagged").textCase(nil)
        }
    }
}

/// The agent edit form, presented as a sheet from the content column's toolbar gear (it used to be
/// the "Settings" half of a Sessions/Settings segmented switch).
struct AgentSettingsSheet: View {
    let agents: AgentsModel
    let agent: Agent

    var body: some View {
        NavigationStack {
            AgentFormContent(agents: agents, agent: agent)
                .navigationTitle("\(agent.name) settings")
        }
        // A sizing hint for the macOS sheet only. On iOS a sheet is bound to the screen width, so
        // forcing a 480pt minimum overflows an iPhone (~390pt) — the form then centres wider than
        // the viewport and clips both edges (title/leading labels cut off). Let iOS size natively.
        #if os(macOS)
        .frame(minWidth: 480, minHeight: 520)
        #endif
    }
}

/// Detail (right) column for the Agents section: the live console for the session selected in the
/// content column — mirroring how Open renders ConsoleView in its detail pane.
func newSessionDraftIdentity(_ agent: Agent) -> String {
    [
        agent.id, agent.defaultProvider, agent.permissionMode ?? "dontAsk",
        agent.effort ?? "", agent.runnerId ?? "host",
    ].joined(separator: "|")
}

struct AgentConsoleDetail: View {
    @Environment(AppModel.self) private var app
    var body: some View {
        if app.composingAgentSession, let registry = app.consoleRegistry, let agents = app.agents,
           let id = app.selectedAgentID, let agent = agents.agent(id) {
            // Draft compose state: the same ComposerView a live console uses, but its send creates a
            // new session, after which we open that session's console.
            NewSessionView(agent: agent, registry: registry,
                           defaultModel: agents.effectiveDefaultModel(for: agent),
                           configuredProviders: agents.configuredProviders,
                           configuredProvidersLoaded: agents.configuredProvidersLoaded,
                           defaultEffort: app.user?.preferences?.defaultEffort) { session in
                app.openCreatedAgentSession(session)
            }
            // Rebuild when settings change the selected Agent's execution identity/defaults too;
            // @State would otherwise retain the old provider after an in-place Agent edit.
            .id(newSessionDraftIdentity(agent))
        } else if let sid = app.selectedAgentSessionID, let registry = app.consoleRegistry {
            // No `.id(sid)`: reuse the warm cached console and swap streams via `.task(id:)`.
            // A just-created session isn't in the Open list yet, so fall back to the agent
            // we're viewing for `/` autocomplete scoping.
            ConsoleView(sessionID: sid, agentID: app.agentID(for: sid) ?? app.selectedAgentID, registry: registry)
        } else {
            ContentUnavailableView("Select a session", systemImage: "bubble.left.and.bubble.right",
                                   description: Text("The agent's live transcript appears here."))
        }
    }
}

/// The draft composer shown in the Agents detail pane while composing a new session. Mirrors the
/// web "new session" state: an empty-transcript hint over the *same* `ComposerView` a live console
/// uses, backed by a draft `ConsoleModel` whose send calls `createSession` (not `sendTurn`) and then
/// hands the new session back so the console takes over. Reusing `ComposerView` keeps the new-session
/// input at full parity — the `+` menu, `!`-shell, slash autocomplete, attachments, and the
/// model/permission/effort footer — instead of the simplified field it used to carry.
struct NewSessionView: View {
    let agent: Agent
    /// Runtime-reported default resolved before this draft is constructed.
    let defaultModel: String
    /// Already-loaded configured-provider identities, needed to resolve the Runtime capability of
    /// a custom model alias before the draft's first asynchronous refresh.
    let configuredProviders: [ConfiguredProvider]
    let configuredProvidersLoaded: Bool
    /// The account's synced default reasoning effort (`user.preferences.defaultEffort`), used to
    /// seed the effort pill so a value picked on web/another device carries here. Optional because
    /// a restored-token launch primes `user` asynchronously — the seed below reacts to it arriving.
    let defaultEffort: String?
    @State private var draft: ConsoleModel
    @Environment(AppModel.self) private var app
    @State private var showSwitcher = false
    @State private var showProviderPicker = false

    init(agent: Agent, registry: ConsoleRegistry, defaultModel: String,
         configuredProviders: [ConfiguredProvider] = [],
         configuredProvidersLoaded: Bool = false,
         defaultEffort: String? = nil,
         onCreated: @escaping (Session) -> Void) {
        self.agent = agent
        self.defaultModel = defaultModel
        self.configuredProviders = configuredProviders
        self.configuredProvidersLoaded = configuredProvidersLoaded
        self.defaultEffort = defaultEffort
        _draft = State(initialValue: registry.draftModel(
            for: agent, defaultModel: defaultModel,
            configuredProviders: configuredProviders,
            configuredProvidersLoaded: configuredProvidersLoaded, onCreated: onCreated))
    }

    var body: some View {
        VStack(spacing: 0) {
            if draft.localStatusCards.isEmpty {
                VStack(spacing: 18) {
                    // Identity cluster — avatar, agent name, provider — reads as one unit: the mark's
                    // colour, the agent it's under, and who runs it, top to bottom.
                    VStack(spacing: 12) {
                        // The mark is the provider's, so it re-colours when the provider row below is
                        // switched — "who is running this" reads from the colour before the text.
                        AgentAvatar(provider: draft.provider, size: 64,
                                    brandKey: currentProviderChoice.brandKey)
                        // The agent identity is the hero — a cold launch lands here, so the screen
                        // answers "which agent am I about to task?" at a glance. A bare bold title
                        // (not a boxed pill) so it reads as the hero it is; the chevron carries the
                        // tap-to-switch affordance, matching the web new-session hero.
                        Button { showSwitcher = true } label: {
                            HStack(spacing: 6) {
                                Text(agent.name).font(.title.weight(.bold)).foregroundStyle(.primary).lineLimit(1)
                                Image(systemName: "chevron.down").font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.secondary)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        // Agent answers "where it runs"; this answers "who runs it". Separate control
                        // because they're separate decisions — and the agent name must stay tappable.
                        Button { showProviderPicker = true } label: {
                            HStack(spacing: 5) {
                                Text(currentProviderChoice.label)
                                    .font(.subheadline.weight(.semibold)).foregroundStyle(.primary).lineLimit(1)
                                Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.horizontal, 11).padding(.vertical, 5)
                            .background(Color.primary.opacity(0.06), in: Capsule())
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                    // Helper: the call to action, then the one config detail the composer footer
                    // doesn't already carry (who's paying) — muted so it stays reference, not noise.
                    VStack(spacing: 4) {
                        Text("Send a task to get started.").font(.callout).foregroundStyle(.secondary)
                        Text(heroSubtitle).font(.footnote).foregroundStyle(.tertiary).lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(.horizontal, 24)
            } else {
                // Once a local command has produced output this is no longer an empty state. Replace
                // the hero instead of showing both, and stack repeated commands vertically.
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            ForEach(draft.localStatusCards) { card in
                                SessionStatusCardView(card: card).id(card.id)
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding(16)
                    }
                    .defaultScrollAnchor(.center)
                    .onChange(of: draft.localStatusCards.count) {
                        if let last = draft.localStatusCards.last {
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    }
                }
            }

            Divider()
            // createSession failures surface on the draft's statusMessage (mirrors ConsoleView).
            if let msg = draft.statusMessage {
                HStack {
                    Text(msg).font(.orbitLabel).foregroundStyle(.secondary).lineLimit(2)
                    Spacer()
                    Button { draft.statusMessage = nil } label: { Image(systemName: "xmark") }
                        .buttonStyle(.plain).foregroundStyle(.secondary)
                }
                .padding(.horizontal, 12).padding(.vertical, 4)
                .background(.bar)
            }
            ComposerView(console: draft, autoFocus: true)
        }
        .task { await draft.prepareDraft() }
        // @State keeps this ConsoleModel alive while the parent AgentsModel finishes its
        // best-effort provider/runner requests. Push those later snapshots into the draft so a
        // custom provider adopts its real default even if the draft's own request failed.
        .onChange(of: configuredProviders, initial: true) { _, providers in
            draft.adoptDraftProviderContext(
                providers, loaded: configuredProvidersLoaded, defaultModel: defaultModel)
        }
        .onChange(of: configuredProvidersLoaded, initial: true) { _, loaded in
            draft.adoptDraftProviderContext(
                configuredProviders, loaded: loaded, defaultModel: defaultModel)
        }
        .onChange(of: defaultModel, initial: true) { _, model in
            draft.adoptDraftProviderContext(
                configuredProviders, loaded: configuredProvidersLoaded, defaultModel: model)
        }
        // Seed the effort pill from the account default. Reactive on `defaultEffort` so a value
        // that lands after the draft was built (async `user` prime on a restored-token launch) is
        // still adopted. Wait for the runner catalog first so an OpenCode model-specific variant
        // cannot leak into a different model/runtime. An explicit agent effort — including "" —
        // is authoritative and never falls through to this account preference (web parity).
        .task(id: defaultEffort) {
            if draft.effort == .default, let raw = defaultEffort, let e = Effort(rawValue: raw) {
                draft.effort = AgentDefaults.normalizeEffort(e, for: draft.provider)
            }
        }
        .sheet(isPresented: $showSwitcher) {
            AgentSwitchSheet(agents: app.orderedAgents, currentID: agent.id,
                             configuredProviders: app.agents?.configuredProviders ?? []) { id in
                app.composeWithAgent(id)
            }
        }
        .sheet(isPresented: $showProviderPicker) {
            ProviderSwitchSheet(choices: providerChoices, currentSlug: draft.provider,
                                agentName: agent.name) { slug in
                draft.pickDraftProvider(slug)
            }
        }
    }

    /// Engines first, then this account's configured providers. Built from the draft's own
    /// snapshot so the list matches the model space the pills are already resolving against.
    private var providerChoices: [ProviderChoice] {
        SessionProviderChoices.choices(configured: draft.configuredProviders,
                                       catalog: draft.modelCatalog,
                                       engines: draft.runnerEngines)
    }

    private var currentProviderChoice: ProviderChoice {
        SessionProviderChoices.current(draft.provider, in: providerChoices,
                                       configured: draft.configuredProviders,
                                       catalog: draft.modelCatalog)
    }

    /// The full model name (the composer footer only carries a truncated one). No funding label:
    /// for a configured provider it's a constant the user already set and isn't actionable here, so
    /// the credential earns a line only when it's broken — matching web, where it surfaces solely as
    /// the provider's `unavailable` warning (not yet modelled on the native ProviderChoice).
    private var heroSubtitle: String {
        draft.providerCapabilitiesResolved
            ? AgentDefaults.friendlyName(draft.modelID, catalog: draft.modelCatalog,
                                         configured: draft.configuredProviders)
            : "Runtime default"
    }
}

struct AgentSessionRow: View {
    let session: Session
    /// True when the Trash tab is showing this row; the preview goes static because nothing in
    /// Trash is directly resumable. The status glyph remains the run's actual outcome.
    var deleted: Bool = false
    /// True in Open, where pinning applies. Completed/Trash rows never show the bar.
    var showsPin: Bool = false
    private var isPinned: Bool { showsPin && session.pinnedAt != nil }
    // Second line: the last-reply / live-state preview (mirrors the web Agent console). `live` mirrors
    // web's `openable` — false on the Trash tab (a deleted session isn't live), true elsewhere.
    private var line: SessionLine { SessionLine.make(for: session, live: !deleted) }

    var body: some View {
        #if os(iOS)
        compactRow
        #else
        HStack(spacing: 0) {
            // A pinned session is marked at rest by a full-height leading accent bar, flush to the
            // row's leading edge — the native port of web's `.session-row.pinned` inset bar
            // (deliberately not a floating pushpin). It sits *outside* the content padding, with the
            // cell's `listRowInsets` zeroed below, so it bleeds to the top/bottom/leading edges like
            // web instead of floating short and inset. A clear bar of the same width keeps unpinned
            // rows aligned.
            Rectangle()
                .fill(isPinned ? Color.accentColor : .clear)
                .frame(width: 3)
            HStack(spacing: 8) {
                StatusGlyphView(glyph: .make(for: session))
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(session.title ?? "Untitled session").lineLimit(1)
                        SessionTagDots(tags: session.tags ?? [])
                    }
                    Text(line.text).font(.orbitListSubtitle).foregroundStyle(lineColor(line.tone)).lineLimit(1)
                }
                Spacer()
                if let n = session.pendingApprovals, n > 0 {
                    Text("\(n)").font(.orbitMeta.bold())
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(.orange, in: Capsule()).foregroundStyle(.white)
                }
            }
            // Re-add the standard cell insets the zeroed `listRowInsets` removed: 3 (bar) + 13 = the
            // usual 16pt leading so the glyph stays put; 16 trailing; 10 vertical for a comfortable row.
            .padding(.leading, 13)
            .padding(.trailing, 16)
            .padding(.vertical, 10)
        }
        .listRowInsets(EdgeInsets())
        // Keep the separator aligned under the title now that the cell insets are zeroed, rather than
        // letting it run full-bleed: bar(3) + leading pad(13) + glyph(20) + spacing(8) = 44.
        .alignmentGuide(.listRowSeparatorLeading) { _ in 44 }
        #endif
    }

    #if os(iOS)
    /// The compact (iPhone) row for the ChatGPT-style grouped list: a flush-left title with a
    /// trailing relative time, a slim live cue (spinner while working / amber dot when it needs you /
    /// red dot on failure), over the preview line. No leading status glyph or pin accent bar — the
    /// recency sections carry pinning, and the preview line already states the live status in words +
    /// colour, so the heavy per-row glyph column is dropped for a calmer, more scannable list.
    private var compactRow: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Text(session.title ?? "Untitled session").lineLimit(1)
                SessionTagDots(tags: session.tags ?? [])
                Spacer(minLength: 8)
                liveIndicator
                if let rel = relTime {
                    Text(rel).font(.orbitMeta).foregroundStyle(.secondary)
                }
            }
            Text(line.text).font(.orbitListSubtitle).foregroundStyle(lineColor(line.tone)).lineLimit(1)
        }
        .padding(.vertical, 2)
        // Combine the row's text into one VoiceOver element and speak the session's state as its
        // value — the visible cue only covers working/needs-you/failed, so the calm states (dormant,
        // done, queued) would otherwise no longer announce their status the way the dropped leading
        // glyph did. `statusWord` is the shared, tested port of web's `statusLabel`.
        .accessibilityElement(children: .combine)
        .accessibilityValue(SessionHeader.statusWord(for: session))
    }

    /// The slim trailing status cue for the compact row — the shared `SessionLiveIndicator` (spinner
    /// while working / amber dot when it needs you / red dot on failure; calm states stay quiet).
    private var liveIndicator: some View {
        SessionLiveIndicator(session: session)
    }

    /// Relative last-activity time ("just now", "3m ago", "2d ago", "7/8") — the parity with web's
    /// `session-time` that the native list was missing. Reuses OrbitKit's `RelativeTime` (also used
    /// by the session-header subtitle).
    private var relTime: String? {
        guard let ts = session.lastTurnAt ?? session.createdAt else { return nil }
        return RelativeTime.format(ts)
    }
    #endif

    private func lineColor(_ tone: SessionLine.Tone) -> Color {
        switch tone {
        case .preview, .queued, .background: return .secondary
        case .running:                       return .blue
        case .approval:                      return .orange
        }
    }
}

/// Renders a `SessionStatusGlyph` at the leading edge of a session row — the shared port of web's
/// `StatusIcon`. A working session shows an animated spinner (web's `LoadingOutlined spin`);
/// everything else is an SF Symbol, tinted by the glyph's semantic tone. Fixed frame so titles
/// line up whether the glyph is a spinner or a symbol.
struct StatusGlyphView: View {
    let glyph: SessionStatusGlyph
    // Box scales with the glyph's own token so a Dynamic-Type-grown symbol isn't clipped.
    @ScaledMetric(relativeTo: .subheadline) private var box: CGFloat = 20
    var body: some View {
        Group {
            switch glyph.shape {
            case .spinner:
                SpinnerGlyph(color: color)
            case .symbol(let name):
                Image(systemName: name).font(.orbitGlyph).foregroundStyle(color)
            }
        }
        .frame(width: box, height: box)
        .help(glyph.label)
        .accessibilityLabel(glyph.label)
    }
    private var color: Color {
        switch glyph.tone {
        case .brand:   return .blue
        case .success: return .green
        case .warning: return .orange
        case .error:   return .red
        case .neutral: return .secondary
        }
    }
}

/// The slim status cue used by the compact (iPhone) lists — the essence of the leading
/// `StatusGlyphView`, distilled to what must never go silent: a spinner while working, an amber dot
/// when it needs you (approval), a red dot on failure. The calm states (dormant / done / queued)
/// show nothing — the surrounding row states them in words + colour and in its VoiceOver value — so
/// the jump-back lists (the grouped session list and the drawer's Recents) stay light. Shared so
/// both show the exact same cue.
struct SessionLiveIndicator: View {
    let session: Session
    @ViewBuilder var body: some View {
        let glyph = SessionStatusGlyph.make(for: session)
        switch (glyph.shape, glyph.tone) {
        case (.spinner, _): SpinnerGlyph(color: .blue)
        case (_, .warning): Circle().fill(.orange).frame(width: 7, height: 7)
        case (_, .error):   Circle().fill(.red).frame(width: 7, height: 7)
        default:            EmptyView()
        }
    }
}

/// A self-drawn indeterminate spinner (a rotating ¾ arc) for the "working" glyph. SwiftUI's
/// `ProgressView` bridges to a UIKit activity indicator that renders *blank* after a `List` row is
/// detached and reattached — open a session and navigate back and the spinner vanishes (while the
/// static SF Symbols survive). The angle is derived from `TimelineView(.animation)` rather than a
/// `repeatForever` implicit animation: this re-animates reliably on reappear *and* holds a constant
/// speed. A `repeatForever` animation gets re-applied every time the host row re-renders, and while
/// an agent streams output the running row re-renders many times a second — those repeats stack on
/// the `rotationEffect` and the arc visibly accelerates. A time-derived angle is a pure function of
/// wall-clock time, so no amount of re-rendering can change how fast it spins.
private struct SpinnerGlyph: View {
    let color: Color
    private let period: Double = 0.85   // seconds per rotation; the steady "normal" cadence
    /// One of these exists per *running* session row — and a session list, plus the drawer's Recents
    /// behind it, can show many at once. A bare `TimelineView(.animation)` redraws every one of them
    /// at the display's full rate (120Hz on ProMotion), so the cost of the list scaled with how many
    /// sessions were running, and it landed on the main thread exactly while scrolling. At 30Hz the
    /// arc still turns ~12° per frame — indistinguishable from smooth for a 0.85s rotation — for a
    /// quarter of the redraws. The angle stays a pure function of wall-clock time, so the rate has no
    /// effect on how fast it appears to spin.
    private let frameInterval: Double = 1.0 / 30.0
    var body: some View {
        TimelineView(.animation(minimumInterval: frameInterval)) { context in
            let angle = context.date.timeIntervalSinceReferenceDate
                .truncatingRemainder(dividingBy: period) / period * 360
            Circle()
                .trim(from: 0, to: 0.7)
                .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .frame(width: 13, height: 13)
                .rotationEffect(.degrees(angle))
        }
    }
}

/// The edit form. Fields mirror the web RunnerDetailPage agent form: name, permission mode,
/// Instructions (appendSystemPrompt), working directory, enabled. There is no runtime field — an
/// agent holds no provider; that is picked per session in the composer. Empty Instructions /
/// workDir omit the key (no change) — matching the web, which sends `undefined` when blank.
struct AgentFormContent: View {
    let agents: AgentsModel
    let agent: Agent
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var mode: PermissionMode = .dontAsk
    @State private var effort: Effort = .default
    @State private var instructions = ""
    @State private var workDir = ""
    @State private var enabled = true
    @State private var confirmingDelete = false

    /// Not an editable field: an agent holds no provider. This is what the project last ran on,
    /// and it is here only because the effort vocabulary and the permission modes below genuinely
    /// differ by runtime. The choice itself lives in the composer, per session.
    private var provider: String { agent.defaultProvider }

    private var effortOptions: [Effort] {
        // `model` / `modelCatalog` were dropped when agents stopped storing a model default; the
        // Runtime-resolved `effectiveModel` and the runner's own catalog replace them (same pair the
        // permission picker below already uses).
        let catalog = agents.modelCatalog(for: agent.runnerId)
        let options = AgentDefaults.efforts(for: provider, model: effectiveModel, catalog: catalog)
        let current = AgentDefaults.normalizedEffort(
            effort, for: provider, model: effectiveModel, catalog: catalog)
        return options.contains(current) ? options : [current] + options
    }

    /// Agents no longer store a model default. Resolve the model this Runtime will provide so the
    /// permission picker never offers Auto for an incompatible model.
    private var effectiveModel: String {
        agents.effectiveDefaultModel(for: provider, runnerId: agent.runnerId)
    }

    private var permissionModeOptions: [PermissionMode] {
        AgentDefaults.permissionModes.filter {
            $0 != .auto || !providerResolved || AgentDefaults.supportsAuto(
                effectiveModel, provider: provider, configured: agents.configuredProviders)
        }
    }

    private var providerResolved: Bool {
        AgentDefaults.isBuiltInProvider(provider) || agents.configuredProvidersLoaded
    }

    var body: some View {
        Form {
            Section {
                TextField("Name", text: $name, prompt: Text("e.g. tea-cli builder"))

                Picker("Permission mode", selection: $mode) {
                    ForEach(permissionModeOptions, id: \.self) {
                        Text(AgentDefaults.label($0)).tag($0)
                    }
                }

                // A new session with this agent seeds its reasoning effort from here (like
                // permission mode); "Default" (the empty value) leaves it to the model's default.
                Picker("Effort", selection: $effort) {
                    ForEach(effortOptions) {
                        Text($0.label).tag($0)
                    }
                }

                Toggle("Enabled", isOn: $enabled)
            }

            Section("Instructions") {
                TextEditor(text: $instructions)
                    .frame(minHeight: 90)
                    .font(.body)
                Text("Added to this agent's system prompt on every run (optional).")
                    .font(.orbitLabel).foregroundStyle(.secondary)
            }

            Section("Working directory") {
                TextField("Path", text: $workDir,
                          prompt: Text("/path/to/project on the runner (optional)"))
            }

            if let env = agent.env, !env.isEmpty {
                Section("Environment") {
                    ForEach(env.sorted(by: { $0.key < $1.key }), id: \.key) { k, v in
                        LabeledContent(k, value: v)
                    }
                    Text("Env editing is coming in a follow-up.")
                        .font(.orbitLabel).foregroundStyle(.secondary)
                }
            }

            Section {
                Button("Delete agent", role: .destructive) { confirmingDelete = true }
            }
        }
        .formStyle(.grouped)
        .onAppear(perform: prefill)
        .onChange(of: effectiveModel) { _, model in
            if providerResolved {
                mode = AgentDefaults.clampPermissionMode(
                    mode, for: model, provider: provider, configured: agents.configuredProviders)
            }
        }
        .onChange(of: agents.configuredProvidersLoaded) { _, loaded in
            if loaded {
                mode = AgentDefaults.clampPermissionMode(
                    mode, for: effectiveModel, provider: provider,
                    configured: agents.configuredProviders)
            }
        }
        // Cancel/Done pair (the iOS editing-sheet idiom, e.g. Contacts): "Done" commits the working
        // copy and closes, "Cancel" discards and closes — a discoverable exit that also works on
        // macOS, where the sheet has no swipe-to-dismiss (Cancel binds to Esc, Done to Return). Done
        // only PATCHes when something actually changed and the name is still non-empty, so opening
        // settings to look and closing writes nothing.
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { commitAndDismiss() }
            }
        }
        // Delete is destructive and drops the agent from the list, so gate it behind an explicit
        // confirmation. The server soft-deletes (its sessions are kept and stay linked); close the
        // sheet afterward since the agent is gone from here.
        .confirmationDialog("Delete \(agent.name)?", isPresented: $confirmingDelete,
                            titleVisibility: .visible) {
            Button("Delete agent", role: .destructive) {
                dismiss()
                Task { await agents.delete(agent.id) }
            }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("This removes the agent from your Agents list. Its sessions are kept.")
        }
    }

    private func prefill() {
        name = agent.name
        let savedMode = PermissionMode(rawValue: agent.permissionMode ?? "dontAsk") ?? .dontAsk
        mode = providerResolved
            ? AgentDefaults.clampPermissionMode(
                savedMode, for: effectiveModel, provider: provider,
                configured: agents.configuredProviders)
            : savedMode
        effort = prefilledEffort
        instructions = agent.appendSystemPrompt ?? ""
        workDir = agent.workDir ?? ""
        enabled = agent.enabled ?? true
    }

    /// True when the working copy diverges from the agent as prefilled — mirrors `prefill()` field
    /// for field so a look-and-close never fires a needless PATCH.
    private var prefilledEffort: Effort {
        let saved = Effort(rawValue: agent.effort ?? "") ?? .default
        return AgentDefaults.normalizeEffort(saved, for: provider)
    }

    private var isDirty: Bool {
        name != agent.name
        || mode != (PermissionMode(rawValue: agent.permissionMode ?? "dontAsk") ?? .dontAsk)
        || effort != prefilledEffort
        || instructions != (agent.appendSystemPrompt ?? "")
        || workDir != (agent.workDir ?? "")
        || enabled != (agent.enabled ?? true)
    }

    /// Save (only if changed and still valid) then close. An emptied name is invalid — the form was
    /// seeded from a real name — so we discard rather than persist it.
    private func commitAndDismiss() {
        if isDirty && !name.trimmingCharacters(in: .whitespaces).isEmpty {
            save()
        }
        dismiss()
    }

    private func save() {
        let req = UpdateAgentRequest(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            appendSystemPrompt: instructions.isEmpty ? nil : instructions,
            permissionMode: mode.rawValue,
            // Always send the raw value ("" for Default) so picking Default actually clears a
            // previously-set effort — omitting (nil) would leave the old value unchanged.
            effort: effort.rawValue,
            workDir: workDir.isEmpty ? nil : workDir,
            enabled: enabled
        )
        Task { await agents.save(agent.id, req) }
    }
}
