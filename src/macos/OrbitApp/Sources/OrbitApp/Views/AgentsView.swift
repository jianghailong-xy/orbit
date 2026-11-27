import SwiftUI
import OrbitKit
#if os(iOS)
import UIKit
#endif

// Batch D + Agents-in-sidebar refinement: the Workspace list now lives in the sidebar, folding away
// the old middle column. iOS renders first-level Workspaces in the drawer (iPad's sidebar is the
// same drawer); macOS's `SectionSidebar` draws the same rows. What remains
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

/// The Workspace identity glyph shared by the iPhone drawer, the iPad sidebar and the Mac sidebar. Online/unknown is the
/// calm native folder and stays decorative; an explicitly-offline Runner adds a small muted
/// `wifi.slash` corner badge and exposes that state to VoiceOver. A workspace on Orbit Cloud wears its cloud in the
/// folder's place: hosted, apart from your own machines' tools and keys (board docs/mocks/workspace-machine-icon, B).
struct WorkspaceFolderIcon: View {
    let selected: Bool
    let offline: Bool
    var cloud: Bool = false
    /// The account's managed runner, when this workspace runs on it (D4): Asleep is a moon, never the
    /// heartbeat's "Runner offline" slash.
    var managed: ManagedRunnerRow? = nil

    var body: some View {
        Image(systemName: cloud ? "cloud" : "folder")
            .frame(width: 24)
            .foregroundStyle(selected ? Color.accentColor : .primary)
            .overlay(alignment: .bottomTrailing) {
                if let managed, managed.kind != .available {
                    if managed.tone == .progress {
                        ProgressView()
                            .controlSize(.mini)
                            .padding(1)
                            .background(.background, in: Circle())
                            .offset(x: 4, y: 4)
                    } else {
                        Image(systemName: managed.asleep ? "moon.zzz.fill" : "exclamationmark.circle.fill")
                            .font(.orbitMeta.weight(.bold))
                            .foregroundStyle(managed.ink)
                            .padding(1)
                            .background(.background, in: Circle())
                            .offset(x: 4, y: 4)
                    }
                } else if offline {
                    Image(systemName: "wifi.slash")
                        .font(.orbitMeta.weight(.bold))
                        .foregroundStyle(.secondary)
                        .padding(1)
                        .background(.background, in: Circle())
                        .offset(x: 4, y: 4)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(managed?.label ?? "Runner offline")
            .accessibilityHidden(managed == nil && !offline)
    }
}

/// The shared first-level Workspace row used by iPhone, iPad and Mac navigation. Runner is
/// descriptive metadata, never a disclosure parent; the trailing slot carries at most one live
/// state, with user attention taking precedence over background work. On the Mac a row with no
/// state shows its faint ⌘1…⌘9 shortcut there while ⌘ is held (`shortcut`, 0-based; nil otherwise).
/// An empty `runnerLabel` leaves the runner off the row. With `runnerOnHover` it shows only while
/// the pointer is on the row, and whole, the name giving way (the Mac's sidebar, board
/// docs/mocks/workspace-runner-label E1); off the Mac nothing hovers, so such a row never names it.
struct WorkspaceNavigationRow: View {
    let agent: Agent
    let runnerLabel: String
    let selected: Bool
    let offline: Bool
    let running: Bool
    /// Background work in flight in this Workspace (`AppModel.jobWorkspaceIDs`). Drawn below
    /// `running` and never as the spinner: nobody is generating, something is happening anyway.
    var jobs: Bool = false
    let waiting: Int
    var shortcut: Int? = nil
    var runnerOnHover: Bool = false
    @Environment(AppModel.self) private var app
    @State private var hovering = false

    /// This workspace's managed runner, when it runs on it: the shared short state (Asleep, Waking
    /// up…, Ready…) in place of the heartbeat's Offline (D4).
    private var managed: ManagedRunnerRow? {
        ManagedRunnerLogic.row(runnerID: agent.runnerId, status: app.managedRunner?.status)
    }

    var body: some View {
        let managedRow = managed
        // The heartbeat's offline reading is not said of a managed runner: its shared state is.
        let offlineNow = offline && managedRow == nil
        let status = WorkspaceNavigationStatusLogic.resolve(
            waiting: waiting, running: running, jobs: jobs, runnerOffline: offlineNow)
        HStack(spacing: 12) {
            WorkspaceFolderIcon(selected: selected, offline: offlineNow,
                                cloud: RunnerPageFormat.isManaged(agent.runnerId, managedRunnerID: app.managedRunner?.status?.runnerId),
                                managed: managedRow)
            HStack(spacing: 0) {
                workspaceName
                disabledBadge
                if !runnerLabel.isEmpty && (!runnerOnHover || hovering) {
                    Text(" · \(runnerLabel)")
                        .lineLimit(1)
                        .foregroundStyle(.secondary)
                        .layoutPriority(runnerOnHover ? 3 : 0)
                }
            }
            Spacer(minLength: 6)
            if case .needsYou(let count) = status {
                NeedsYouCountCapsule(count: count)
            } else if status == .running {
                // Same reading as the session row's cue: background work stays neutral so the
                // amber count above is the only thing in this column asking for you.
                SpinnerGlyph(color: .secondary)
                    .accessibilityLabel("Session running")
            } else if status == .jobs {
                // The session row's own mark for the same fact, in the same slot: a background job
                // in flight, with nobody generating. Breathing rather than turning, so it can never
                // be read as the spinner above it.
                BreathingGlyph(systemImage: "terminal")
                    .accessibilityLabel("Background job running")
            } else if let managedRow, managedRow.kind != .available {
                Text(managedRow.label)
                    .font(.orbitMeta)
                    .foregroundStyle(managedRow.ink)
                    .lineLimit(1)
                    .accessibilityLabel(managedRow.detail.map { "\(managedRow.label) — \($0)" } ?? managedRow.label)
            } else if let shortcut {
                Text("⌘\(shortcut + 1)")
                    .font(.orbitMeta).monospacedDigit()
                    .foregroundStyle(.tertiary)
            }
        }
        #if os(macOS)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        #endif
    }

    private var workspaceName: some View {
        Text(agent.name)
            .lineLimit(1)
            .foregroundStyle(.primary)
            .layoutPriority(2)
    }

    @ViewBuilder
    private var disabledBadge: some View {
        if agent.enabled == false {
            Text("disabled")
                .font(.orbitMeta)
                .padding(.horizontal, 5)
                .padding(.vertical, 1)
                .background(.quaternary, in: Capsule())
                .padding(.leading, 6)
                .fixedSize()
        }
    }
}

/// The amber count in a drawer row's trailing slot: how many things under the row wait on you — a
/// Workspace's sessions, a project's owner items. One view, so the two lists draw it alike.
struct NeedsYouCountCapsule: View {
    let count: Int

    var body: some View {
        Text("\(count)")
            .font(.orbitMeta.weight(.semibold))
            .monospacedDigit()
            .foregroundStyle(.orange)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Color.orange.opacity(0.15), in: Capsule())
            .accessibilityLabel("\(count) waiting for you")
    }
}

/// How this list's rows navigate — a fact about the container the list is in, not about the rows
/// (they are the same rows in both shells; see `SessionListRow`).
enum SessionRowNavigation {
    /// Three-column (macOS / iPad regular): `.tag(id)`, and the `List`'s selection — a projection of
    /// the section's stack — fills the detail pane that is always on screen.
    case selection
    /// Compact (iPhone): the row is a `Button` that pushes its own destination (`AppModel.push`) —
    /// the frame the three-column shell would have selected. A plain `List` in a `NavigationStack`
    /// doesn't take selection taps at all in non-edit mode, so a `.tag`-only row there is a row
    /// that cannot be opened.
    case push
}

/// Content (middle) column for the Agents section: the selected agent's sessions, with a toolbar
/// gear to edit the agent. Selecting a session drives the console in the detail column.
struct AgentContentColumn: View {
    @Environment(AppModel.self) private var app
    /// How this column's rows navigate. Defaults to the three-column shape, which is what the
    /// split shells want; the compact shell (whose stack knows its own pushes) passes `.push`.
    var rowNavigation: SessionRowNavigation = .selection
    /// The session-list search field's text — owned by the column because the field is declared on
    /// the column root (see `body`). macOS carries it too but never shows a field: its window
    /// searches from the ⌘K palette instead.
    @State private var searchQuery = ""
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif
    var body: some View {
        @Bindable var app = app
        // Both branches in one `Group` so the search field below can be declared on the column root
        // *unconditionally*. It used to hang off `AgentPanes`' list — inside the `if let` — which
        // left it missing on any column born on the placeholder branch: at cold launch the workspace
        // list is still loading (`AppModel.loadAgentsThenLand` resolves the landing agent only after
        // the fetch), so this column first appears on its placeholder branch, and the search bar UIKit
        // installs on the column's navigation item at that first configuration simply wasn't there to
        // install. Swapping the branch in afterwards doesn't add one — which is why the field stayed
        // gone (scrolling to the top didn't bring it back) until you left the section and came back,
        // rebuilding the column with the workspace already resolved. Declared here it exists from the
        // column's first breath, in either branch.
        Group {
            #if os(iOS)
            // A wide shell's session column has no stack of its own (§3.3), so a folder is the page
            // this *column* draws: entering one replaces the workspace's list here, with the
            // folder's page carrying the column's own back button, while the detail pane beside it
            // goes on following the selected session. A phone never reads this — its folder page is
            // a frame the compact stack pushes (`CompactSections`).
            if let address = app.projectSessionsColumn, rowNavigation == .selection {
                SessionProjectPage(address: address, rowNavigation: rowNavigation)
            } else {
                if let address = app.folderColumn {
                    SessionFolderPage(address: address, rowNavigation: rowNavigation, searchQuery: $searchQuery)
                } else {
                    workspaceList
                }
            }
            #else
            // A project's sessions page takes the column, as on the iPad: the sidebar's project row
            // opens it (docs/mocks/macos-sidebar, owner 2026-11-12), the detail beside it following
            // the member picked.
            if let address = app.projectSessionsColumn, rowNavigation == .selection {
                SessionProjectPage(address: address, rowNavigation: rowNavigation)
            } else if let address = app.folderColumn {
                // A folder's page takes the column as on the iPad, with its own back button; the
                // Mac has no search field over it (⌘K searches), so it is given none.
                SessionFolderPage(address: address, rowNavigation: rowNavigation)
            } else {
                workspaceList
            }
            #endif
        }
        #if os(iOS)
        // Search, in the list rather than over it. Until it existed the list was only searchable from
        // inside the drawer (or ⌘K, which needs a keyboard), so it looked like it had none.
        //
        // On the phone (iOS 26) the field sits in the bottom toolbar, where a thumb reaches it, and
        // gets out of the way while the list is read downward: `revealsBottomSearchOnScroll` on
        // `AgentPanes`' list hides it on the way down and brings it back on the way up, at the top
        // and at the end (`BottomSearchReveal`). The owner picked that over the drawer below, which
        // spent 60pt of the phone's header on a field that never left; New session stays in the bar.
        //
        // The iPad's column, and phones before iOS 26 (which draw no bottom search field), keep the
        // drawer. `.navigationBarDrawer` is what keeps the field *below* the bar's own content instead
        // of over it — the system owns that layout, which a hand-placed bar can't do. `.always`, and
        // this is the second time it has won: the list below carries `.refreshable`, and on iOS 26
        // the two disagree about where the drawer's 60pt goes.
        //
        // Measured on an iOS 26.2 simulator (the `.ios-probe/` probe on the
        // `orbit/loading-c855b1-shots` branch; frames in window coordinates). Every bottom edge here
        // was taken while the page still drew an inline title above the field, so with that title
        // gone the whole arrangement sits a title-line higher; what the numbers decide is the
        // *relative* order (field inside the bar, control below it), which is unchanged. Under
        // `.automatic` the navigation bar grows to 62–236 and the field is drawn at its bottom
        // (176–236), while the
        // refresh control still takes the band above it (116–176) — so the pull that reveals the
        // field draws the spinner *in the bar*, which on the phone that reported this is the field
        // itself. Under `.always` the bar is 62–176, the field 116–176 *inside* it, and the control
        // 176–236: below both, like Mail's. Every other spelling measures identically —
        // `.searchable` on the list instead of here, `.searchPresentationToolbarBehavior
        // (.avoidHidingContent)`, `.refreshable` hoisted to the column root, the list's top
        // safe-area inset removed.
        //
        // β96 also tried keeping `.automatic` and moving the *spinner* instead: clearing the
        // control's tint (which does hide the glyph — it hangs off a zero-height row inside the
        // list, since a `.background` is attached outside the collection view and reaches no scroll
        // view at all) and drawing an indicator of our own in the band below the field. It works,
        // and it leaves the header with a void: that band is the refresh control's own 60pt, which
        // `.refreshable` reserves whether or not a search field exists (`bare` 116 → `bareRefresh`
        // 176), while a drawer with no refresh control reserves nothing (`.automatic` and `.always`
        // both 176 without it). A resident field below that band reads as chrome; a field floating
        // above it reads as a hole under the field — which is how it was reported. So: `.always`,
        // and the 56pt a scrolling-away field would give back is what the header pays to read right.
        // (The field is declared on the column root, so it also exists from that column's first
        // breath in either mode.) Typing searches the server (every workspace, scope and message
        // text); the hits replace the list's sections until the field is cleared (see `AgentPanes`).
        .sessionListSearch(text: $searchQuery,
                           fromBottom: SessionListPresentation.resolve(
                               isCompactWidth: horizontalSizeClass == .compact).searchesFromBottom,
                           isEnabled: rowNavigation != .selection ||
                               (app.projectSessionsColumn == nil && app.folderColumn?.isScheduledRuns != true))
        // The query outlives `AgentPanes`' rebuild on a workspace switch (`.id(a.id)`), and a switch
        // keeps it: search mode ends only at the field's close button, and the hits span every
        // workspace anyway.
        #endif
    }

    /// The workspace's session list — or the placeholder that stands in for it while the workspace
    /// list loads, fails, or nobody has picked one. Split out of `body` so the iOS branch can put a
    /// folder's page in front of it without repeating either (see `body`).
    @ViewBuilder private var workspaceList: some View {
        @Bindable var app = app
        if let agents = app.agents, let id = app.selectedAgentID, let a = agents.agent(id) {
            AgentPanes(agents: agents, agent: a, selectedSessionID: $app.selectedAgentSessionID,
                       searchQuery: $searchQuery, rowNavigation: rowNavigation)
                .id(a.id)
                #if os(iOS)
                // No title, on either width: the bar's workspace switcher (see the toolbar
                // below) moved out of the title slot and into the leading one, and a title left
                // behind would draw a second copy of the same name in the centre. `.inline`
                // stays even with nothing to draw — a page with no title still reserves the
                // *large* title band without it, the trap `ConsoleView` documents on its own
                // page. One deliberate cost: a pushed page's back label is the previous page's
                // title, so the console and the draft now read "Back" instead of the workspace
                // name. (macOS keeps its title: its toolbar is its own layout and nothing there
                // moved.)
                .navigationBarTitleDisplayMode(.inline)
                #else
                .navigationTitle(a.name)
                #endif
        } else {
            switch app.agents?.listPresentation {
            case .loading?:
                ProgressView()
            case .failed?:
                // Offline the sidebar has nothing to pick and the launch landing is still waiting
                // on a list that answers, so say the fetch failed rather than "Select a workspace".
                VStack(spacing: 10) {
                    ContentUnavailableView("Workspaces couldn't be loaded", systemImage: "wifi.exclamationmark",
                                           description: Text(app.agents?.errorText ?? "Request failed — check your connection."))
                    Button("Retry") { Task { await app.loadAgentsThenLand() } }
                }
            case .content? where app.launchLandingPending, .empty? where app.launchLandingPending:
                // The workspaces are in but the landing isn't: it waits for the rest of the
                // workspace fetch (runners, providers, pools), and asking for a pick it is about
                // to make is the "Select a workspace" a cold launch used to flash.
                ProgressView()
            case .empty?:
                // Nothing to pick: a workspace is made by the session that needs one (board rule 11).
                ContentUnavailableView {
                    Label(MachineSetupCopy.NO_WORKSPACES_YET, systemImage: "folder")
                } description: {
                    Text(MachineSetupCopy.NO_WORKSPACES_DETAIL)
                } actions: {
                    // Not beside a machine's new session page, which is that session already.
                    if app.machineDraftRunnerID == nil {
                        Button(MachineSetupCopy.START_A_SESSION) { app.newSessionInCurrentAgent() }
                            .buttonStyle(.bordered)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            default:
                ContentUnavailableView("Select a workspace", systemImage: "folder",
                                       description: Text("Pick a workspace in the sidebar to see its sessions and settings."))
            }
        }
    }
}

struct AgentPanes: View {
    @Environment(AppModel.self) private var app
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif
    let agents: AgentsModel
    let agent: Agent
    @Binding var selectedSessionID: String?
    /// The search field's text. The field itself lives on `AgentContentColumn` (which is why this is
    /// a binding and not local state — see the comment on that column's `body`).
    @Binding var searchQuery: String
    /// How the rows navigate — see `SessionRowNavigation`. Passed down from the column, which got it
    /// from the shell that put this list in a container.
    let rowNavigation: SessionRowNavigation
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
    /// What came back for the current query. The list searches in place — the hits replace its
    /// sections — rather than opening the palette sheet over the very list you're looking at.
    @State private var hits: [SessionSearchHit] = []
    /// The query `hits` came from — what their snippets are highlighted against, so highlighting
    /// can't run ahead of the results while typing.
    @State private var hitsQuery = ""
    @State private var contentSearched = true
    @State private var searching = false
    /// Which row's circle swipe actions are out (iOS 26 — see `RowSwipeState`).
    @State private var rowSwipe = RowSwipeState()
    #endif
    /// The row whose Share was tapped — drives the share panel, owned by the list for the same
    /// reason as `taggingSession`. Share is iOS's row action (`SessionRow`), so on the Mac it is
    /// never set and has no panel.
    @State private var sharingSession: Session?
    /// The row whose Move was tapped — drives the Move panel, list-owned like the two above.
    @State private var movingSession: Session?
    /// A row being dragged onto one of the folder rows (the Mac's shortcut for Move, see `SessionFolderDrop`).
    @State private var drag = SessionDragState()
    /// The folder whose Rename… was tapped — on a folder row's long-press menu (the folder page's
    /// ⋯ raises the same question through the same modifier). List-owned like the sheets above.
    @State private var renamingFolder: SessionFolder?
    /// The folder whose Delete Folder… was tapped, held the same way.
    @State private var deletingFolder: SessionFolderDeletion?
    /// New Folder… (§3.4) — in the ≡ menu on iOS, the window toolbar on the Mac — and the prompt it
    /// opens: its draft, and why the last one failed (a name the workspace already has, in words).
    @State private var namingFolder = false
    @State private var newFolderDraft = ""
    @State private var newFolderFailure: String?
    /// Whether the Pinned section is folded to its header. Stored rather than view
    /// state: this pane is rebuilt per workspace (`.id(a.id)`), so @State would unfold it on every
    /// switch, and on every launch.
    @AppStorage("sessionList.pinnedCollapsed") private var pinnedCollapsed = false
    /// Whether the Needs you section is folded to its header, stored for the same reason.
    @AppStorage("sessionList.needsYouCollapsed") private var needsYouCollapsed = false
    /// The last grouping drawn and its inputs (see `body`).
    @State private var listingMemo = SessionListingMemo<SessionListGrouping>()
    /// The clock the session list's terminal line is filtered against.
    @State private var terminalNow = Date()
    // Set true when the composer hands ↑/↓ back on Escape, so the session list can be arrow-navigated
    // without a click; the binding also tracks click-to-focus.
    @FocusState private var listFocused: Bool

    private var scheduledRunsAddress: SessionFolderAddress? {
        let byTag = tagFilter != nil || groupByTag
        guard !isSearching, SessionFolderGrouping.listShowsFolders(view: view, byTag: byTag) else { return nil }
        return .scheduledRuns(agentID: agent.id, view: view)
    }

    var body: some View {
        // The column is the session list with its Open / Completed / Trash scope over it (macOS: a
        // top inset; regular iPad: the same picker in its refresh-safe top inset). The scope used to
        // ride the window toolbar's centre on the Mac, where it sat over the detail pane and read as
        // a control of the conversation rather than of this list. New session stays in the toolbar.
        //
        // The selection is for the three-column shape only: it is what fills the detail pane beside
        // this column. Compact's rows push their own pages onto the section's `NavigationStack`, so
        // there the List has nothing to select (and in a plain stack wouldn't respond to a tap).
        // The grouping runs only when what it is computed from changed (`SessionListingMemo`): the
        // body re-runs on a selection, a pop back to the list or a focus request, none of which
        // moves a row. The list's closures, which SwiftUI also runs on its own as rows scroll in,
        // read these rather than regrouping the account's sessions each time.
        let grouping = listingMemo.value(for: listInputs, compute: Self.grouping)
        let folderListing = grouping.folderListing
        let timeSections = grouping.timeSections
        let projectRows = grouping.projectRows
        let projectMarks = grouping.projectListing.marks
        let scheduledAddress = scheduledRunsAddress
        let scheduledRuns = scheduledAddress.flatMap {
            ScheduledRunsFolder.summary(agents.scheduledRuns(in: $0) ?? [], view: view, byTag: false)
        }
        List(selection: listSelection) {
            #if os(macOS)
            // The Mac has no capsule, so the waiting terminals are a Needs you section at the top
            // of the list, in the capsule's own words and mark (board ③, choice 6 A).
            if let terminal = app.terminalNeedsYou(now: terminalNow) {
                TitledListSection {
                    TerminalNeedsYouRow(line: terminal) { app.openTerminalNeedsYou(terminal) }
                } title: {
                    Text(MachinesAndModels.needsYou).textCase(nil)
                }
            }
            #endif
            // Recency sections (Pinned / Today / Yesterday / 2–7 days ago / …), as web's list draws
            // them, on every platform. Bucketing is the pure, tested `SessionTimeGrouping`.
            // Optional "By Tag" grouping (one Section per tag + Untagged) or the default recency
            // sections; the tag filter chip narrows either. Both are the pure, tested OrbitKit
            // groupers over the same console-sorted, tag-filtered list (`shownSessions`).
            #if os(iOS)
            if isSearching {
                searchResults
            } else if groupByTag {
                ForEach(SessionTagGrouping.sections(shownSessions)) { section in
                    tagGroupSection(section)
                }
            } else {
                groupedSections(folderListing: folderListing, timeSections: timeSections,
                                projectRows: projectRows, projectMarks: projectMarks,
                                scheduledAddress: scheduledAddress, scheduledRuns: scheduledRuns)
            }
            #else
            groupedSections(folderListing: folderListing, timeSections: timeSections,
                            projectRows: projectRows, projectMarks: projectMarks,
                            scheduledAddress: scheduledAddress, scheduledRuns: scheduledRuns)
            #endif
        }
        .orbitRevealSurface()   // macOS: reveal the unified `orbitSurface`
        #if os(iOS)
        // Plain style so the sections read as light headers over full-width rows (matching the
        // current list), not boxed inset-grouped cards.
        .listStyle(.plain)
        .softTopEdgeEffect()
        .rowSwipeList(rowSwipe)
        // The phone's search field, in the bottom toolbar, gets out of the way while the list is read
        // downward (see the column's `sessionListSearch`).
        .revealsBottomSearchOnScroll(query: searchQuery, enabled: listPresentation.searchesFromBottom)
        #endif
        .focused($listFocused)
        .onChange(of: app.sessionListFocusRequest) { _, _ in listFocused = true }
        // A session opened by id puts this list on its folder's page only where this list would
        // draw the folder's row; the model asks (`AppModel.folderForOpening`).
        .onChange(of: listShowsFolders, initial: true) { _, shows in app.sessionListShowsFolders = shows }
        #if os(macOS)
        .modifier(TerminalRequestsCurrent(now: $terminalNow))
        #endif
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
            } else if agents.agentSessions.isEmpty && scheduledRuns == nil {
                #if os(iOS)
                // No list saved yet (a fresh install, a new account): grey rows where the sessions
                // will be, while the title's line says "Loading sessions…" (board 02 ④).
                if agents.sessionsLoading && view == .open {
                    SessionListPlaceholder()
                } else {
                    emptyList
                }
                #else
                emptyList
                #endif
            }
        }
        #if os(iOS)
        // Pull-to-refresh reloads the current agent + scope's sessions on demand (matching the
        // Open/Tasks/Runners lists). The pull control shows its own spinner, so reload *without*
        // `reset:` to update the rows in place rather than blanking the list mid-gesture.
        .refreshable {
            await agents.loadSessions(agentID: agent.id, view: view)
            if let scheduledAddress { await agents.loadScheduledRuns(scheduledAddress) }
        }
        // Typing in the column's search field (declared on `AgentContentColumn`) searches the server —
        // every workspace, scope and message text — and the hits show here in place of the sections;
        // clearing the field restores them.
        .task(id: searchQuery) { await runSearch() }
        // Regular iPad keeps the lifecycle scope visible instead of burying it in the filter menu.
        // It lives below the inline title/search chrome and stays fixed while the rows scroll. The
        // compact iPhone list keeps the existing icon-menu scope switcher and pays no extra height.
        // What waits on you is noticed by the toast host, once (docs/mocks/needs-you-capsule/12-once).
        //
        // Not a bare `.safeAreaInset`: on iOS 26 the pull's spinner hangs under the navigation
        // bar, in the band these sit in, and a pull drew it over the needs-you bar; the modifier
        // keeps these put and the spinner under them, pull and refresh alike, and puts the list
        // back at its top when a refresh leaves it just past there (see `topInsetClearOfRefresh`).
        // Also tried on the iOS 26.5 simulator and dropped: the bands stacked above the list
        // instead (the pull pushed them down 60pt and no spinner showed), `.safeAreaBar` (the list
        // would no longer pull, nor stay scrolled), and the needs-you bar as the list's first row
        // (it scrolls away, and a finished refresh left the list settled with it half under the
        // navigation bar).
        .topInsetClearOfRefresh {
            if listPresentation.showsPersistentScope {
                VStack(spacing: 0) {
                    scopePicker
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                    Divider()
                }
                .background(.bar)
            }
        }
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
        //
        // Completed / Trash read the whole account's list, so their poll follows the control stream
        // (`ViewPoll`): a row joining or moving in them is read a second later, otherwise once a
        // minute while the stream is live; every 4 s while it is down; never while the app cannot be
        // seen (docs/list-freshness-design.md §4 R6).
        .task(id: "\(agent.id)|\(view.rawValue)") {
            await agents.loadSessions(agentID: agent.id, view: view, reset: true)
            await app.projects?.load()
            guard view != .open else { return }
            await ViewPoll.run(app, every: 4, hints: { app.lifecycleHints }) {
                await agents.loadSessions(agentID: agent.id, view: view)
            }
        }
        .task(id: scheduledAddress) {
            if let scheduledAddress { await app.pollScheduledRuns(scheduledAddress) }
        }
        #if os(macOS)
        // The scope over the list it filters, centred and content-width; the pane's own surface
        // shows behind it, so it adds no band of chrome.
        .safeAreaInset(edge: .top, spacing: 0) {
            scopePicker
                .fixedSize()
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
        }
        #endif
        .toolbar {
            #if os(iOS)
            // iPhone keeps scope in this compact menu. Regular iPad exposes scope in the persistent
            // segmented control above the list, so this menu narrows to tag filter/group + settings.
            ToolbarItem(placement: .topBarTrailing) {
                sessionOptionsMenu(includesScope: !listPresentation.showsPersistentScope)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    app.startComposingSession()
                } label: {
                    Label("New session", systemImage: "square.and.pencil")
                }
                .accessibilityLabel("Start a new session with \(agent.name)")
            }
            // The same workspace title the new-session draft carries (`WorkspaceTitle`),
            // but at the *leading* slot rather than the title one. In the title slot iOS 26 only
            // centres a custom title view while its whole ideal width fits what is left of the bar
            // after reserving the widest side's chrome on both sides — here the two trailing
            // buttons' glass capsule (measured 107pt wide on a 393pt bar, +16pt margin ≈ 123pt a
            // side, leaving ≈147pt). Past that the group didn't truncate: it was clamped to the
            // leading edge (measured 72.3pt = the drawer button's right edge + 12), so the same bar
            // read centred for `orbit` and left for `wikova-develop`, decided by nothing but how
            // long the name happened to be. Leading is where that fallback put it anyway, and
            // without a width cap the whole name shows rather than a truncation — the two spellings
            // are drawn side by side in docs/mocks/ios-title-switcher-long-name.html (the chosen one
            // is B). The drawer button is declared a level up (`drawerToggle`, on the section root),
            // which is the item this one follows.
            //
            // Its shared background is switched off, so the name is *drawn on the bar* rather than
            // inside a platter with the drawer button: iOS 26 groups adjacent leading items into one
            // glass capsule by itself, which put `[☰ or ⌄]` on one pill (beta.106). Measured on an
            // iPhone 17 Pro Max simulator: with the default the two share a 102pt platter; with
            // `.hidden` the drawer button keeps its own circle and the name sits bare beside it, both
            // workspace names FULL width. (The probe app that measured it was throwaway and is not
            // kept; the harness it was built from is the `.ios-probe` app on
            // `orbit/loading-c855b1-shots`, which is a different arrangement but the same scaffold.)
            // The modifier is iOS 26 only — below that the bar draws no platters at all, so the
            // fallback branch is the same item with nothing to hide.
            if #available(iOS 26.0, *) {
                ToolbarItem(placement: .topBarLeading) {
                    listTitle
                }
                .sharedBackgroundVisibility(.hidden)
            } else {
                ToolbarItem(placement: .topBarLeading) {
                    listTitle
                }
            }
            #else
            // macOS: New Session (leading) and a settings gear; the scope is over the list (above).
            ToolbarItem(placement: .navigation) {
                Button {
                    app.startComposingSession()
                } label: {
                    Label("New session", systemImage: "square.and.pencil")
                }
                .help("Start a new session with \(agent.name)")
            }
            // New Folder…, as the iPhone's ≡ menu offers it: not in Trash, where no folder row is
            // drawn — the new folder would appear nowhere on screen.
            ToolbarItem(placement: .primaryAction) {
                Button { namingFolder = true } label: {
                    Label(SessionFolderCopy.newFolder, systemImage: "folder.badge.plus")
                }
                .help("New folder in \(agent.name)")
                .disabled(view == .trash)
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
        // Rename… / Delete Folder…, raised by a folder row's context menu — the same two asks, in
        // the same words, that a folder page's ⋯ raises (§3.4).
        .sessionFolderManagement(renaming: $renamingFolder, deleting: $deletingFolder)
        #if os(iOS)
        // The share panel for the row whose Share was tapped: the session page's own (ConsoleView's),
        // list-owned like the tag picker above. iOS only, as the rows' Share is.
        .sheet(item: $sharingSession) { s in
            if let baseURL = app.baseURL {
                ShareSheet(kind: .session, rootID: s.id, baseURL: baseURL, tokenStore: app.tokenStore,
                           guests: .of(s, agents: app.agents))
            }
        }
        #endif
        // The Move panel for the row whose Move was tapped: the folders of this workspace, counted
        // over the list the row is in (docs/session-folders-move-design.md §4).
        .sheet(item: $movingSession) { s in
            if let workspace = agents.agent(s.agent?.id ?? s.agentId ?? agent.id) {
                SessionMoveSheet(session: s, workspace: workspace, listed: agents.allSessions).environment(app)
            }
        }
        // New Folder… (the ≡ menu, or the Mac's toolbar): the system's prompt names it, it lands at the top of this list,
        // and a name the workspace already has is refused in so many words (as the Move panel's is).
        .alert(SessionMoveCopy.newFolderTitle, isPresented: $namingFolder) {
            TextField(SessionMoveCopy.folderNamePlaceholder, text: $newFolderDraft)
            Button(SessionMoveCopy.create) { createFolderFromMenu() }
                .keyboardShortcut(.defaultAction)
            Button(SessionMoveCopy.cancel, role: .cancel) {}
        } message: {
            Text(SessionFolderCopy.newFolderMessage)
        }
        .alert(SessionMoveCopy.couldNotCreate, isPresented: newFolderFailed) {
            Button(SessionMoveCopy.ok, role: .cancel) {}
        } message: {
            Text(newFolderFailure ?? "")
        }
        // Load the owner's tag library when the pane appears so the picker + chips are populated,
        // and the folder library the list's folder rows and the Move panel are drawn from.
        .task {
            await app.loadSessionTags()
            await app.loadSessionFolders()
        }
    }

    /// The list's folder rows and recency sections — what the workspace's list draws when it is
    /// neither searching nor grouped by tag, on every platform (web's list draws the same).
    @ViewBuilder private func groupedSections(folderListing: SessionFolderListing, timeSections: [SessionTimeSection],
                                              projectRows: [String: SessionProjectRow],
                                              projectMarks: [String: SessionProjectMark],
                                              scheduledAddress: SessionFolderAddress?,
                                              scheduledRuns: ScheduledRunsFolder.Summary?) -> some View {
        if let scheduledAddress, let scheduledRuns {
            Button {
                app.openFolder(scheduledAddress)
            } label: {
                SessionFolderRowView(scheduledRuns: scheduledRuns)
            }
            .buttonStyle(.plain)
            .listRowSeparator(.hidden, edges: .top)
        }
        // The workspace's folders, at the very top of the list (docs/session-folders-move-design.md
        // §3.3): the sessions filed in one are drawn behind its row and not in the time
        // sections below. Trash, a tag filter and Group by Tag all leave this empty — see
        // `folderListing` — so the list goes on flat there.
        ForEach(Array(folderListing.folders.enumerated()), id: \.element.id) { index, row in
            folderListRow(row, first: index == 0 && scheduledRuns == nil)
        }
        // The leading "Today" keeps no title. A list that opens on today — which is nearly
        // always — would be saying something its rows already say (each carries its own time
        // on the right), and the 28pt of header it costs is half a row back. `Pinned`, when
        // it leads, and every later bucket keep theirs: those are the ones that answer
        // "where am I" once the list has scrolled. (Bucketing itself is untouched — see
        // `SessionTimeGrouping`; this is only whether a given section draws its title. The
        // decision is the one the mock put second, `docs/mocks/ios-session-list-first-header.html`
        // — the reporter picked the first: never draw it, rather than only once it pins.)
        ForEach(Array(timeSections.enumerated()), id: \.element.id) { index, section in
            timeSection(index: index, section: section, foldersEmpty: folderListing.folders.isEmpty && scheduledRuns == nil,
                        projectRows: projectRows, projectMarks: projectMarks)
        }
    }

    /// One folder row at the top of the list; the first drops the hairline the list draws there.
    @ViewBuilder
    private func folderListRow(_ row: SessionFolderRow, first: Bool) -> some View {
        if first {
            folderRow(row).listRowSeparator(.hidden, edges: .top)
        } else {
            folderRow(row)
        }
    }

    /// One recency section: the leading "Today" without its title, the Pinned fold, or an
    /// ordinary titled section. The section is the row this list's ForEach draws, so that closure
    /// holds no branch or second ForEach of its own.
    @ViewBuilder
    private func timeSection(index: Int, section: SessionTimeSection, foldersEmpty: Bool,
                             projectRows: [String: SessionProjectRow],
                             projectMarks: [String: SessionProjectMark]) -> some View {
        if index == 0, section.title == "Today" {
            // The list draws a hairline at the top of its first row — the title used to
            // sit over it. With the title gone it reads as a stray rule above the first
            // session, so that one row drops its top separator (measured on an iOS 26.2
            // simulator: hiding the *section* separator, or giving the Section an empty
            // header, both leave the line; only this removes it).
            ForEach(section.sessions) { session in
                if session.id == section.sessions.first?.id, foldersEmpty {
                    listRow(session, projects: projectRows, marks: projectMarks)
                        .listRowSeparator(.hidden, edges: .top)
                } else {
                    listRow(session, projects: projectRows, marks: projectMarks)
                }
            }
        } else if let folded = sectionFold(section.title) {
            // Pinned and Needs you fold to their header, as Notes' Pinned does: the rows
            // leave the list, the header stays to bring them back. The rows are dropped
            // here rather than through `Section(isExpanded:)`, whose disclosure only draws
            // in the sidebar list style.
            TitledListSection {
                if !folded.wrappedValue {
                    ForEach(section.sessions) { listRow($0, projects: projectRows, marks: projectMarks) }
                }
            } title: {
                foldSectionHeader(section.title, folded: folded)
            }
        } else {
            TitledListSection {
                ForEach(section.sessions) { listRow($0, projects: projectRows, marks: projectMarks) }
            } title: {
                Text(section.title).textCase(nil)
            }
        }
    }

    private var emptyList: some View {
        ContentUnavailableView(
            agents.sessionsLoading ? "Loading…" : "No \(view.title.lowercased()) sessions",
            systemImage: "bubble.left.and.bubble.right")
    }

    #if os(iOS)
    /// The workspace name over the list, with the Open list's freshness line under it while the rows
    /// may still be the previous run's (docs/mocks/ios-launch-updating). Completed / Trash read for
    /// themselves, so they draw the name alone.
    private var listTitle: some View {
        WorkspaceTitle(name: agent.name,
                       status: view == .open ? app.openListStatus : nil,
                       empty: agents.agentSessions.isEmpty,
                       retry: { app.retryOpenList() })
    }
    #endif

    /// Open / Completed / Trash, over the list on the Mac and on regular iPad. This is deliberately
    /// content-width, not fixed-width, so it continues to fit the middle column at larger Dynamic
    /// Type sizes.
    private var scopePicker: some View {
        Picker("Session scope", selection: $view) {
            ForEach(SessionView.pickerCases) { Text($0.title).tag($0) }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .accessibilityLabel("Session scope")
    }

    /// What the List's selection is bound to: the projection onto the section's stack in the
    /// three-column shape, nothing at all in the compact one (whose rows carry their own
    /// destinations). Written as its own property so its type is decided here, not at the call site.
    private var listSelection: Binding<String?>? {
        rowNavigation == .selection ? $selectedSessionID : nil
    }

    #if os(iOS)
    /// One presentation decision shared by scope chrome and row density. Only an explicit compact
    /// width opts into the iPhone treatment, matching the app root's shell switch.
    private var listPresentation: SessionListPresentation {
        SessionListPresentation.resolve(isCompactWidth: horizontalSizeClass == .compact)
    }

    /// One options menu serves both iOS shells. Compact includes lifecycle scope exactly as before;
    /// regular iPad omits that duplicate but retains tag filtering/grouping and Workspace settings.
    /// Ticks and icons share the one leading column: a choice row shows a tick when it is the chosen
    /// one, an action row its icon. Every row keeps an image there — an unchosen choice a transparent
    /// tick — because iOS 27 starts a row without an image at the margin, even beside rows that have
    /// one. (A Toggle's system tick would take a column of its own, beside the icons.)
    private func sessionOptionsMenu(includesScope: Bool) -> some View {
        Menu {
            if includesScope {
                ForEach(SessionView.pickerCases) { v in
                    Button { view = v } label: {
                        Label { Text(v.title) } icon: { tick(v == view) }
                    }
                    .accessibilityAddTraits(v == view ? .isSelected : [])
                }
            }
            if !app.sessionTags.isEmpty {
                if includesScope { Divider() }
                // Filter by tag stays in a submenu instead of adding a persistent chip row. A tick
                // marks the active tag, which the row names underneath; choosing it again or
                // choosing All clears it.
                Menu {
                    Toggle(isOn: Binding(get: { tagFilter == nil }, set: { if $0 { tagFilter = nil } })) {
                        Text("All")
                    }
                    ForEach(app.sessionTags) { tag in
                        Toggle(isOn: Binding(get: { tagFilter == tag.id },
                                             set: { tagFilter = $0 ? tag.id : nil })) {
                            Text(tag.name)
                        }
                    }
                } label: {
                    Label("Filter by Tag", systemImage: "tag")
                    if let active = app.sessionTags.first(where: { $0.id == tagFilter }) {
                        Text(active.name)
                    }
                }
                Button { groupByTag.toggle() } label: {
                    Label { Text("Group by Tag") } icon: { tick(groupByTag) }
                }
                .accessibilityAddTraits(groupByTag ? .isSelected : [])
            }
            if includesScope || !app.sessionTags.isEmpty { Divider() }
            // New Folder… (§3.4): a folder in this workspace, made without moving a session into it
            // (the Move panel's entry is the same thing with a session in hand). Not in Trash, where
            // no folder row is drawn — the new folder would appear nowhere on screen.
            if view != .trash {
                Button { namingFolder = true } label: {
                    Label(SessionFolderCopy.newFolder, systemImage: "folder.badge.plus")
                }
            }
            Button { showSettings = true } label: {
                Label("Settings", systemImage: "gearshape")
            }
        } label: {
            // Filled variant keeps an active (otherwise hidden) tag filter visible at a glance.
            Image(systemName: tagFilter == nil
                  ? "line.3.horizontal.decrease"
                  : "line.3.horizontal.decrease.circle.fill")
        }
        .accessibilityLabel(Text(includesScope
                                 ? "Session scope, \(view.title)"
                                 : "Session filters and workspace settings"))
    }

    /// The options menu's tick: the checkmark on the chosen row, the same glyph fully transparent on
    /// the others, so an unchosen row still has an image and its title keeps the shared edge.
    private func tick(_ on: Bool) -> Image {
        on ? Image(systemName: "checkmark") : Image(uiImage: Self.clearTick)
    }

    private static let clearTick = UIImage(systemName: "checkmark")?
        .withTintColor(.clear, renderingMode: .alwaysOriginal) ?? UIImage()
    #endif

    // The sessions to show: the agent list, narrowed to the tag filter chip when one is active.
    private var shownSessions: [Session] {
        guard let f = tagFilter else { return agents.agentSessions }
        return SessionFilter.withTag(agents.agentSessions, tagID: f)
    }

    /// What the list's grouping is computed from, read off the models each pass — which is also
    /// what re-runs the body when one of them changes (see `SessionListingMemo`).
    private var listInputs: SessionListInputs {
        SessionListInputs(workspaceID: agent.id, sessions: agents.agentSessions, tagFilter: tagFilter,
                          accountSessions: app.sessions, allSessions: agents.allSessions,
                          folders: app.sessionFolders, projects: app.projects?.sidebarProjects ?? [],
                          watches: app.watches?.summaries ?? [:], view: view, groupByTag: groupByTag,
                          searching: isSearching, runnerOffline: agents.runnerIsOffline(agent.runnerId),
                          recaps: accountShowsRecaps)
    }

    /// The account's Session recaps switch, off only when explicitly turned off (`AppModel.user`
    /// carries the preferences). Read here so a toggle regroups the list into the lines it asks for.
    private var accountShowsRecaps: Bool { app.user?.preferences?.showRecaps ?? true }

    /// The whole grouping, from its inputs alone: static, so it cannot read a fact the memo's key
    /// does not carry.
    private static func grouping(_ inputs: SessionListInputs, _ lines: SessionLineCache) -> SessionListGrouping {
        let projectListing = Self.projectListing(inputs, lines)
        let folderListing = Self.folderListing(projectListing, inputs)
        let projectRows = Dictionary(uniqueKeysWithValues: projectListing.projects.map { ($0.id, $0) })
        return SessionListGrouping(projectListing: projectListing, folderListing: folderListing,
                                   timeSections: Self.timeSections(folderListing, inputs), projectRows: projectRows)
    }

    /// The recency sections the list draws, split out of the `ForEach` so the leading one can be
    /// rendered without its title (see the list body). Over what is left after the folders take
    /// theirs — a session inside a folder is drawn behind its row, not here (§3.3).
    private static func timeSections(_ folderListing: SessionFolderListing, _ inputs: SessionListInputs) -> [SessionTimeSection] {
        SessionTimeGrouping.sections(folderListing.sessions, pinnedFirst: inputs.view == .open && inputs.tagFilter == nil,
                                     attention: inputs.view == .open)
    }

    /// This workspace's list, split by folder (§3.3): the folder rows the list draws at its top,
    /// and the sessions left for the time sections. The grouping itself is the pure, tested
    /// `SessionFolderGrouping`; what this reads is what it needs — the workspace's own folders out
    /// of the owner's library, and its Runner's explicit-offline state, which silences a folder
    /// row's spinner exactly as it silences the workspace's own. Trash, a tag filter and Group by
    /// Tag all leave the folder rows empty (§3.3): each is a grouping of its own, and a second one
    /// stacked on the list would leave a session with two places to be.
    private static func folderListing(_ projectListing: SessionProjectListing, _ inputs: SessionListInputs) -> SessionFolderListing {
        guard SessionProjectGrouping.listShowsProjects(view: inputs.view, byTag: inputs.byTag) else {
            return SessionFolderGrouping.listing(inputs.shownSessions,
                                      folders: inputs.workspaceFolders,
                                      view: inputs.view,
                                      byTag: inputs.byTag,
                                      runnerOffline: inputs.runnerOffline)
        }
        return SessionFolderListing(folders: projectListing.folders,
                                    sessions: projectListing.entries.map(\.timeGroupingSession))
    }

    private static func projectListing(_ inputs: SessionListInputs, _ lines: SessionLineCache) -> SessionProjectListing {
        let shownSessions = inputs.shownSessions
        // The grouping reads only the coordinators out of these, so only they are copied out of the
        // account's lists — not several hundred sessions each, concatenated whole on every pass.
        let isCoordinator = { (session: Session) in session.projectMembership?.role == .coordinator }
        let coordinators = inputs.allSessions.filter(isCoordinator) + inputs.accountSessions.filter(isCoordinator)
        // Only the sessions the grouping looks a watch up for — this list's own and the projects'
        // coordinators — not every session of the account, each a `PublicID` key conversion.
        let watched = shownSessions + coordinators
        return SessionProjectGrouping.listing(shownSessions,
                                      folders: inputs.workspaceFolders,
                                      projects: inputs.projects, view: inputs.view,
                                      byTag: inputs.byTag, searching: inputs.searching,
                                      workspaceID: inputs.workspaceID,
                                      runnerOffline: inputs.runnerOffline,
                                      coordinators: coordinators,
                                      contentSessions: inputs.view == .open ? inputs.accountSessions : inputs.allSessions,
                                      watching: Dictionary(watched.compactMap { session in
                                          inputs.watch(for: session.id).map { (session.id, $0) }
                                      }, uniquingKeysWith: { _, latest in latest }),
                                      line: { lines.line(for: $0, watching: inputs.watch(for: $0.id),
                                                         recaps: inputs.recaps) })
    }

    /// One folder's row: the glyph, name, count and the state it reports, as the whole row (the
    /// page it opens is pushed by the container's own navigation — a tap lands on `AppModel`'s one
    /// entry point for both shells). A long press offers the two management acts (§3.4) — on the
    /// row itself, since a `Button` does not pass its label's modifiers up to the `List` (see
    /// `SessionListRow`).
    private func folderRow(_ row: SessionFolderRow) -> some View {
        Button {
            app.openFolder(SessionFolderAddress(folderID: row.folder.id, agentID: agent.id, view: view))
        } label: {
            SessionFolderRowView(row: row)
        }
        .buttonStyle(.plain)
        .sessionFolderDropTarget(folderID: row.folder.id, workspaceID: agent.id, drag: drag, app: app)
        .contextMenu {
            Button {
                renamingFolder = row.folder
            } label: {
                Label(SessionFolderCopy.rename, systemImage: "pencil")
            }
            Button(role: .destructive) {
                deletingFolder = SessionFolderDeletion(folder: row.folder)
            } label: {
                Label(SessionFolderCopy.delete, systemImage: "trash")
            }
        }
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
        TitledListSection {
            ForEach(hits) { hit in
                Button { app.route(to: .session(hit.id)) } label: {
                    SessionSearchRow(hit: hit, query: hitsQuery)
                }
                .buttonStyle(.plain)
            }
        } title: {
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

    /// One row, wrapped for the container it is in. The row view itself is the same either way; what
    /// changes is who moves the screen — the three-column shell's `List` selection, or the row's own
    /// destination value on the compact stack. There is no third state for "highlighted but not
    /// openable" to live in: the highlight IS the pushed console in both shapes, so a tap always
    /// either selects a row that isn't the page showing or pushes the one that is.
    ///
    /// The entry itself — a project's row or a plain session's — is `SessionListEntryRow`, the one
    /// builder a folder's page also draws its rows through.
    @ViewBuilder private func listRow(_ s: Session, projects: [String: SessionProjectRow],
                                      marks: [String: SessionProjectMark]) -> some View {
        SessionListEntryRow(
            session: s, projects: projects, marks: marks, view: view, agentID: agent.id,
            navigation: rowNavigation, drag: drag, dropTargets: folderDropTargets,
            onTag: { taggingSession = $0 }, onShare: { sharingSession = $0 }, onMove: { movingSession = $0 })
    }

    /// Whether this list is drawing folder rows: not Trash, and not under a tag filter, Group by
    /// Tag or search (`SessionFolderGrouping.listShowsFolders`). Also written back to the model, so
    /// a session opened by id knows whether this list has a folder's page to show.
    private var listShowsFolders: Bool {
        !isSearching && SessionFolderGrouping.listShowsFolders(view: view, byTag: tagFilter != nil || groupByTag)
    }

    /// Somewhere to drop a row: this workspace's folder rows over the list (none in Trash or by tag).
    private var folderDropTargets: Bool {
        listShowsFolders && app.sessionFolders.contains { $0.workspaceId == agent.id }
    }

    /// New Folder…: make the folder in this workspace and keep it, so its row draws at
    /// the top of this very list. A refusal (a name the workspace already has is a 409) leaves its
    /// reason up as an alert, with the draft kept for another try.
    private func createFolderFromMenu() {
        guard let name = SessionMoveLogic.folderName(newFolderDraft) else { return }
        Task {
            if let refused = await app.createSessionFolder(named: name, in: agent) {
                newFolderFailure = refused
            }
        }
    }

    private var newFolderFailed: Binding<Bool> {
        Binding(get: { newFolderFailure != nil }, set: { if !$0 { newFolderFailure = nil } })
    }

    /// One tag's sessions under the tag's header band. The section is the row the list's ForEach
    /// draws, so the ForEach closure holds no branch of its own.
    @ViewBuilder private func tagGroupSection(_ section: SessionTagSection) -> some View {
        TitledListSection {
            ForEach(section.sessions) { s in
                SessionListEntryRow(
                    session: s, projects: [:], marks: [:], view: view, agentID: agent.id,
                    navigation: rowNavigation, drag: drag, dropTargets: folderDropTargets,
                    onTag: { taggingSession = $0 }, onShare: { sharingSession = $0 }, onMove: { movingSession = $0 })
            }
        } title: {
            tagSectionHeader(section.tag)
        }
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

    /// A folding section's header (Pinned, Needs you): its title, and at the trailing edge a chevron
    /// that points down while the rows show and right once they are folded away (one glyph turned,
    /// never two swapped — as the cards' chevrons). The whole band is the button, not just the chevron.
    private func foldSectionHeader(_ title: String, folded: Binding<Bool>) -> some View {
        let pinned = title == "Pinned"
        let shows = pinned ? "Shows the pinned sessions" : "Shows the sessions waiting for you"
        let hides = pinned ? "Hides the pinned sessions" : "Hides the sessions waiting for you"
        return Button {
            withAnimation { folded.wrappedValue.toggle() }
        } label: {
            HStack {
                Text(title).textCase(nil)
                Spacer()
                Image(systemName: "chevron.right")
                    .rotationEffect(.degrees(folded.wrappedValue ? 0 : 90))
                    .accessibilityHidden(true)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(.isHeader)
        .accessibilityHint(folded.wrappedValue ? shows : hides)
    }

    /// The fold of a section that folds to its header (Pinned, Needs you); nil for one that doesn't.
    private func sectionFold(_ title: String) -> Binding<Bool>? {
        switch title {
        case "Pinned": return $pinnedCollapsed
        case "Needs you": return $needsYouCollapsed
        default: return nil
        }
    }
}

/// A titled section of a session list — the workspace list's and a folder page's. On iOS the title
/// is the section's first row rather than its header: a plain list pins its section headers, so
/// "Today" / "Yesterday" / Pinned stuck under the title bar as the rows scrolled, on a glass band of
/// their own. The owner (2026-11-16): the titles need not stick — they scroll away with their rows,
/// and the only glass at the top is the title area's own soft edge (`softTopEdgeEffect`), which the
/// rows pass under. The title row is styled as the system header it replaces, carries no separator
/// and cannot be selected.
///
/// The Mac's list draws its section headers in the sidebar's own way, so there it stays a header.
struct TitledListSection<Rows: View, Title: View>: View {
    let rows: Rows
    let title: Title

    init(@ViewBuilder _ rows: () -> Rows, @ViewBuilder title: () -> Title) {
        self.rows = rows()
        self.title = title()
    }

    var body: some View {
        #if os(iOS)
        Section {
            title
                .font(.headline)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .listRowInsets(EdgeInsets(top: 20, leading: 20, bottom: 6, trailing: 20))
                .listRowSeparator(.hidden)
                .selectionDisabled()
                .accessibilityAddTraits(.isHeader)
            rows
        }
        #else
        Section {
            rows
        } header: {
            title
        }
        #endif
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
func newSessionDraftIdentity(_ agent: Agent, folderID: String? = nil) -> String {
    [
        agent.id, agent.defaultProvider,
        agent.effort ?? "", agent.runnerId ?? "host",
        // The folder whose page the draft was opened from is part of the draft's identity: the same
        // workspace's ✎ outside a folder and ✎ inside one are two different drafts, and the one
        // that creates a session files it in its folder (§3.3).
        folderID ?? "",
    ].joined(separator: "|")
}

struct AgentConsoleDetail: View {
    @Environment(AppModel.self) private var app
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif

    /// Whether the pane shows the new-session draft: the one ✎ or ⌘N put on the stack, and on iOS the
    /// pane's root as well. An iPad's detail column is always on screen, so an empty pane would leave
    /// half of it saying "Select a session" — web's right pane composes when nothing is selected. The
    /// pane is at its root with nothing on the stack, or only a folder's frame, which is the column's
    /// page rather than the pane's (§3.3). It is this view's reading of the root rather than a
    /// `.compose` frame the model pushes: both shells share the stack, and a frame pushed for this one
    /// would open the phone's on a draft instead of its list once the window narrows. macOS keeps its
    /// placeholder.
    private var showsDraft: Bool {
        #if os(iOS)
        if app.folderColumn?.isScheduledRuns == true { return app.composingAgentSession }
        return app.composingAgentSession || app.sectionAtRoot || app.folderPage != nil
        #else
        return app.composingAgentSession
        #endif
    }

    /// The folder the draft files its session in: the one its frame names (✎ on a folder's page) or,
    /// for the draft drawn at the pane's root, the folder whose page the column shows — the draft that
    /// page's ✎ opens, so pressing it focuses this one instead of starting another.
    private var draftFolderID: String? {
        #if os(iOS)
        if !app.composingAgentSession { return app.folderPage?.folderID }
        #endif
        return app.composingFolderID
    }

    var body: some View {
        if let guestID = app.guestSessionID {
            // A session somebody shared with this account: its guest view (Shared with me, or a
            // session id the owner's read found nothing of yours at).
            GuestSessionView(sessionID: guestID)
                .id(guestID)
        } else if let runnerID = app.machineDraftRunnerID {
            // A machine's own new session page, whose Set up row put it here (board rule 1).
            MachineDraftPage(runnerID: runnerID)
                .id(runnerID)
        } else if showsDraft, let registry = app.consoleRegistry, let agents = app.agents,
                  let id = app.selectedAgentID, let agent = agents.agent(id) {
            // Draft compose state: the same ComposerView a live console uses, but its send creates a
            // new session, after which we open that session's console. One branch for both drafts, so
            // ✎ over the root's keeps what was typed — and only the one asked for takes focus: a
            // keyboard raised on every launch and workspace switch would cover half the screen.
            NewSessionView(agent: agent, registry: registry,
                           defaultModel: agents.effectiveDefaultModel(for: agent),
                           configuredProviders: agents.configuredProviders,
                           configuredProvidersLoaded: agents.configuredProvidersLoaded,
                           providerPools: agents.providerPools,
                           sharedPools: agents.sharedPools,
                           modelCatalog: agents.modelCatalog(for: agent.runnerId),
                           defaultEffort: app.user?.preferences?.defaultEffort,
                           // ✎ on a folder's page: the draft's frame names the folder, and the
                           // session it creates lands in it (§3.3).
                           folderID: draftFolderID,
                           focusesComposer: app.composingAgentSession,
                           // The session column beside this pane names the workspace already.
                           workspaceTitleInBar: false) { session in
                app.openCreatedAgentSession(session)
            }
            // Rebuild when settings change the selected Agent's execution identity/defaults too;
            // @State would otherwise retain the old provider after an in-place Agent edit.
            .id(newSessionDraftIdentity(agent, folderID: draftFolderID))
        } else if let sid = app.selectedAgentSessionID, let registry = app.consoleRegistry {
            // No `.id(sid)`: reuse the warm cached console and swap streams via `.task(id:)`.
            // A just-created session isn't in the Open list yet, so fall back to the agent
            // we're viewing for `/` autocomplete scoping.
            ConsoleView(sessionID: sid, agentID: app.agentID(for: sid) ?? app.selectedAgentID, registry: registry)
        } else {
            #if os(iOS)
            if SessionListPresentation.resolve(
                isCompactWidth: horizontalSizeClass == .compact
            ).showsPersistentScope {
                ContentUnavailableView {
                    Label("Select a session", systemImage: "bubble.left.and.bubble.right")
                } description: {
                    Text("The session transcript appears here.")
                } actions: {
                    if app.selectedAgentID != nil, app.folderColumn?.isScheduledRuns != true {
                        Button {
                            app.startComposingSession()
                        } label: {
                            Label("New Session", systemImage: "square.and.pencil")
                        }
                        .buttonStyle(.bordered)
                    }
                }
            } else {
                ContentUnavailableView("Select a session", systemImage: "bubble.left.and.bubble.right",
                                       description: Text("The session transcript appears here."))
            }
            #else
            ContentUnavailableView("Select a session", systemImage: "bubble.left.and.bubble.right",
                                   description: Text("The session transcript appears here."))
            #endif
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
    /// Where the status cards end, room under the last one included (see the cards' scroll view).
    private static let statusCardsEnd = "status-cards-end"
    let agent: Agent
    /// Runtime-reported default resolved before this draft is constructed.
    let defaultModel: String
    /// Already-loaded configured-provider identities, needed to resolve the Runtime capability of
    /// a custom model alias before the draft's first asynchronous refresh.
    let configuredProviders: [ConfiguredProvider]
    let configuredProvidersLoaded: Bool
    /// The account pools the parent has loaded, so a workspace that runs on one opens on its tile.
    let providerPools: [ProviderPool]
    /// The shared pools this account is in, which the draft offers beside its own (`draft.allPools`).
    let sharedPools: [SharedPool]
    /// The owning runner's cached model catalogue — what `defaultModel` was resolved from, and what
    /// NAMES it. Passed in so the first frame reads the same label the picker will settle on.
    let modelCatalog: RunnerModelCatalog?
    /// The account's synced default reasoning effort (`user.preferences.defaultEffort`), used to
    /// seed the effort pill so a value picked on web/another device carries here. Optional because
    /// a restored-token launch primes `user` asynchronously — the seed below reacts to it arriving.
    let defaultEffort: String?
    /// The folder whose page opened this draft, if any (a folder page's ✎): the session it creates
    /// is filed in that folder (docs/session-folders-move-design.md §3.3).
    let folderID: String?
    /// Whether the composer takes focus as it appears: true wherever someone asked for the draft. An
    /// iPad's detail column also draws it unasked, at the root of the stack (`AgentConsoleDetail`),
    /// and ✎ then turns this on for that same view.
    let focusesComposer: Bool
    /// Whether the iOS navigation bar names the workspace. The iPad detail pane leaves this to
    /// the session column beside it; the phone's pushed draft needs its own title.
    let workspaceTitleInBar: Bool
    @State private var draft: ConsoleModel
    @Environment(AppModel.self) private var app
    @State private var showEnginePicker = false

    init(agent: Agent, registry: ConsoleRegistry, defaultModel: String,
         configuredProviders: [ConfiguredProvider] = [],
         configuredProvidersLoaded: Bool = false,
         providerPools: [ProviderPool] = [],
         sharedPools: [SharedPool] = [],
         modelCatalog: RunnerModelCatalog? = nil,
         defaultEffort: String? = nil,
         folderID: String? = nil,
         focusesComposer: Bool = true,
         workspaceTitleInBar: Bool = true,
         onCreated: @escaping (Session) -> Void) {
        self.agent = agent
        self.defaultModel = defaultModel
        self.configuredProviders = configuredProviders
        self.configuredProvidersLoaded = configuredProvidersLoaded
        self.providerPools = providerPools
        self.sharedPools = sharedPools
        self.modelCatalog = modelCatalog
        self.defaultEffort = defaultEffort
        self.folderID = folderID
        self.focusesComposer = focusesComposer
        self.workspaceTitleInBar = workspaceTitleInBar
        _draft = State(initialValue: registry.draftModel(
            for: agent, defaultModel: defaultModel,
            configuredProviders: configuredProviders,
            configuredProvidersLoaded: configuredProvidersLoaded,
            providerPools: providerPools,
            sharedPools: sharedPools,
            modelCatalog: modelCatalog, accountDefaultEffort: defaultEffort,
            folderID: folderID,
            onCreated: onCreated))
    }

    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(spacing: 0) {
            if let bubble = draft.draftPendingBubble {
                // The first message, waiting for its session: the conversation it opens, drawn from its
                // first bubble on, top-aligned in the engine picker's place (web `draftPending`;
                // docs/mocks/composer-sending-bubble, board 03). `Not sent` brings Retry and Put back.
                ScrollView {
                    UserBubbleView(bubble: bubble)
                        .frame(maxWidth: .infinity)
                        .padding([.horizontal, .top], 16)
                        .accessibilityIdentifier("draft-pending-bubble")
                }
                .fadesIntoComposerBand()
                // The image cache a user bubble reads for its attachments; the live console injects it, and
                // this page is not under one.
                .environment(draft.attachments)
                .environment(\.notSentActions, NotSentActions(
                    retry: { [draft] _ in Task { await draft.retryDraftPending() } },
                    putBack: { [draft] _ in draft.putBackDraftPending() },
                    retryEnabled: !draft.sending))
            } else if draft.localStatusCards.isEmpty {
                VStack(spacing: 18) {
                    // Which engine runs this session is the hero — the native port of web's
                    // `NewSessionProviderHero`: the vendor's own mark, then the engine's name as the
                    // one tappable identity. Which provider of it the session spends is the
                    // composer's Provider menu's to pick and to say. The workspace name sits in the iOS navigation bar; macOS keeps its workspace
                    // switcher below the hero.
                    VStack(spacing: 14) {
                        ProviderMark(provider: currentEngine.slug, size: 68,
                                     brandKey: currentEngine.brandKey,
                                     label: currentEngine.label)
                        Button { showEnginePicker = true } label: {
                            HStack(spacing: 7) {
                                Text(currentEngine.label)
                                    .font(.title.weight(.bold)).foregroundStyle(.primary).lineLimit(1)
                                Image(systemName: "chevron.down").font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.secondary)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Engine: \(currentEngine.label). Switch")
                        placePill
                    }
                    VStack(spacing: 5) {
                        // The draft moved off what the workspace last ran on, which can't run here
                        // (board docs/mocks/new-session-usable-default ② ③): say what it uses now
                        // and why, with the same route to the reason (web parity).
                        if draft.draftFallback != nil, let from = draft.rememberedDraftEngine,
                           let line = SessionProviderChoices.fallbackLine(from: from, to: currentEngine, machine: machineName) {
                            Button {
                                if let rid = agent.runnerId, let engine = from.provider?.fixEngine {
                                    if let url = draft.webFixURL(engine: engine) { openURL(url) }
                                    else { app.openRunnerEngine(rid, engine: engine) }
                                }
                            } label: {
                                Text("\(line) · \(from.provider?.regionBlocked == true ? ClaudeRegionCopy.CLAUDE_REGION_DETAILS : "Fix it")")
                                    .font(.callout).foregroundStyle(Color.accentColor).lineLimit(2)
                                    .multilineTextAlignment(.center)
                            }
                            .buttonStyle(.plain)
                            .disabled(agent.runnerId == nil || from.provider?.fixEngine == nil)
                        // The pick is sticky, so it can point at an engine this machine can no
                        // longer run — and the session would only fail minutes later, at the runner.
                        // Say so here, and make the line the route to the fix (web parity).
                        } else if let blocker = currentProviderChoice.unavailable,
                           currentProviderChoice.fixEngine != nil {
                            Button {
                                if let rid = agent.runnerId {
                                    let engine = currentProviderChoice.fixEngine ?? ""
                                    if let url = draft.webFixURL(engine: engine) { openURL(url) }
                                    else { app.openRunnerEngine(rid, engine: engine) }
                                }
                            } label: {
                                // A reason nothing on the page fixes — the runner's Claude region —
                                // links to its explanation rather than a fix (web parity).
                                Text("\(blocker) on this runner · \(currentProviderChoice.regionBlocked ? ClaudeRegionCopy.CLAUDE_REGION_DETAILS : "Fix it")")
                                    .font(.callout).foregroundStyle(Color.accentColor).lineLimit(2)
                                    .multilineTextAlignment(.center)
                            }
                            .buttonStyle(.plain)
                            .disabled(agent.runnerId == nil)
                        } else if let blocker = currentProviderChoice.unavailable {
                            // An account pool the server says cannot run at all: no runner fixes
                            // that, so the line only says why — in the picker row's own words.
                            Text(blocker)
                                .font(.callout).foregroundStyle(.secondary).lineLimit(2)
                                .multilineTextAlignment(.center)
                        }
                        // Nothing on this machine runs the draft (board ④): the send waits, and
                        // another provider's key is the way out here.
                        if draft.draftCantRun {
                            Text(SessionProviderChoices.cantRunLine(machine: machineName))
                                .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
                                .padding(.top, 6)
                            Button(ClaudeRegionCopy.CLAUDE_REGION_USE_ANOTHER_PROVIDER) { openURL(draft.webProvidersURL()) }
                                .font(.callout).buttonStyle(.plain).foregroundStyle(Color.accentColor)
                        }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(.horizontal, 24)
                // The room above the band a list keeps under its last row (`fadesIntoComposerBand`).
                .padding(.bottom, .composerBandFade)
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
                        .padding([.horizontal, .top], 16)
                        // The room the fade lies over (`fadesIntoComposerBand`), and where a new card
                        // scrolls the list to: a scroll to the card itself would leave its end in the fade.
                        Color.clear.frame(height: .composerBandFade).id(Self.statusCardsEnd)
                    }
                    .fadesIntoComposerBand()
                    .defaultScrollAnchor(.center)
                    .onChange(of: draft.localStatusCards.count) {
                        if !draft.localStatusCards.isEmpty {
                            proxy.scrollTo(Self.statusCardsEnd, anchor: .bottom)
                        }
                    }
                }
            }

            // Same band as the live console, so the draft composer and the real one are inset and
            // spaced identically.
            ComposerBand {
                // The managed runner's state, as the live console shows it, unless it already stands
                // in the hero's place above, or in the welcome card's first step.
                    if let managed = draft.managed, managed.showsBanner {
                        if managed.display.kind == .sleeping {
                            // Asleep is not a fault: the shared calm line, and sending wakes it.
                            Text(ManagedRunnerCopy.Asleep.composer)
                                .font(.orbitLabel)
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.bottom, .composerBandGap)
                                .accessibilityIdentifier("managed-asleep-composer")
                        } else {
                            ManagedRunnerBanner(display: managed.display, runnerID: managed.runnerID)
                                .padding(.bottom, .composerBandGap)
                        }
                    }
                // createSession failures surface on the draft's statusMessage (mirrors ConsoleView).
                if let msg = draft.statusMessage {
                    HStack {
                        Text(msg).font(.orbitLabel).foregroundStyle(.secondary).lineLimit(2)
                        Spacer()
                        Button { draft.statusMessage = nil } label: { Image(systemName: "xmark") }
                            .buttonStyle(.plain).foregroundStyle(.secondary)
                    }
                    .padding(.bottom, .composerBandGap)
                }
                ComposerView(console: draft, autoFocus: focusesComposer)
            }
        }
        #if os(iOS)
        // The title names the workspace this draft will run in.
        .toolbar {
            if workspaceTitleInBar {
                ToolbarItem(placement: .principal) { WorkspaceTitle(name: agent.name) }
            }
        }
        #endif
        .task {
            // A draft the usage-limit card asked for starts on the account it named (board iOS 5 ⑧).
            if let pick = app.consoleRegistry?.takeDraftAccount(agentID: agent.id) {
                draft.pickDraftAccount(pick.engine, pick.account)
            }
            // Items shared to Orbit for a new session here (ShareHandoff.swift).
            if let stage = app.consoleRegistry?.takeDraftStaging(agentID: agent.id) {
                stage(draft)
            }
            await draft.prepareDraft()
        }
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
        // Re-resolve the effort pill when the account preference lands after the draft was built
        // (async `user` prime on a restored-token launch). The model owns the edit revision, so this
        // account-last-picked refill cannot overwrite a picker action made while it was loading.
        // Lands the draft on what can run here when what the workspace last ran on can't, and back
        // once it can again (board docs/mocks/new-session-usable-default).
        .task(id: draft.draftFallbackTarget) {
            draft.settleDraftDefault()
        }
        .task(id: defaultEffort) {
            draft.adoptDraftDefaultEffort(defaultEffort, legacyWorkspaceDefault: agent.effort)
        }
        .sheet(isPresented: $showEnginePicker) {
            // The draft's own runnerID is only set for a live session, so take the agent's — it is
            // the machine this draft would run on, and the one whose engine page fixes a row.
            EngineSwitchSheet(
                engines: engines, current: currentEngine, agentName: agent.name,
                onSelect: { engine, provider in draft.pickDraft(engine: engine, provider: provider) },
                onFixRunner: agent.runnerId.map { rid in { engine in
                    if let url = draft.webFixURL(engine: engine) { openURL(url) }
                    else { app.openRunnerEngine(rid, engine: engine) }
                } })
        }
    }

    /// Where the session runs, under the engine (docs/mocks/new-session-place, option A's pill, board
    /// 02 option D's menu; web's `PlacePill`): one bordered pill, `[workspace] / [folder] ▾`, naming the
    /// folder only when one is picked — a folder is a sidebar group, so none is the quiet default. Its
    /// menu lists the workspaces alone, this one first; a workspace with folders opens them one level
    /// down under None, so a folder of any workspace is one pick.
    private var placePill: some View {
        let folder = app.sessionFolders.first { $0.workspaceId == agent.id && $0.id == folderID }
        let label = folder.map { "\(agent.name) / \($0.name)" } ?? agent.name
        let workspaces = [agent] + app.orderedAgents.filter { $0.id != agent.id }
        return Menu {
            ForEach(workspaces) { other in
                let folders = app.sessionFolders.filter { $0.workspaceId == other.id }
                let here = other.id == agent.id
                if folders.isEmpty {
                    Button { pick(other.id, folder: nil) } label: { placeRow(other.name, on: here) }
                } else {
                    Menu {
                        Button { pick(other.id, folder: nil) } label: { placeRow("None", on: here && folder == nil) }
                        ForEach(folders) { each in
                            Button { pick(other.id, folder: each.id) } label: {
                                placeRow(each.name, on: here && each.id == folder?.id)
                            }
                        }
                    } label: {
                        placeRow("\(other.name)  \(folders.count)", on: here)
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "terminal").foregroundStyle(.secondary)
                Text(agent.name).lineLimit(1).frame(maxWidth: 200)
                if let folder {
                    Text("/").foregroundStyle(.tertiary)
                    Image(systemName: "folder").foregroundStyle(.secondary)
                    Text(folder.name).lineLimit(1).frame(maxWidth: 200)
                }
                Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            }
            .font(.callout).foregroundStyle(.primary)
            .padding(.horizontal, 12)
            .frame(height: 30)
            .overlay(Capsule().strokeBorder(Color.secondary.opacity(0.35)))
            .contentShape(Capsule())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityLabel("Runs in: \(label)")
    }

    /// A row of the place menu: its name, ticked when it is the draft's.
    @ViewBuilder private func placeRow(_ name: String, on: Bool) -> some View {
        if on { Label(name, systemImage: "checkmark") } else { Text(name) }
    }

    /// A workspace, and a folder of it or none: the draft for that place, with what was typed here.
    private func pick(_ workspaceID: String, folder: String?) {
        guard workspaceID != agent.id || folder != folderID else { return }
        carryDraftText(to: workspaceID)
        app.composeInFolder(folder, of: workspaceID)
    }

    /// The draft the pick opens is a new one (its identity names the workspace and the folder), so
    /// the words typed here are handed to it as a main checkout line's are (`pendingDraftText`).
    private func carryDraftText(to agentID: String) {
        guard !draft.composerText.isEmpty else { return }
        app.consoleRegistry?.pendingDraftText[agentID] = draft.composerText
    }

    /// What the hero judges the engines and their credentials by: the draft's own snapshot — so the
    /// list matches the model space the pills are already resolving against — with this workspace's
    /// Gemini key on the machine it would run on.
    private var sources: ChoiceSources {
        var sources = draft.choiceSources
        sources.antigravityKeyAvailable =
            agent.antigravityKeyAvailableByRunner?[draft.runnerID ?? agent.runnerId ?? ""] == true
        return sources
    }

    /// The engines the hero offers, by their CLIs' names, each landing on the draft's pick when it is
    /// that engine's, else on what this workspace last ran there (web parity).
    private var engines: [EngineChoice] {
        SessionProviderChoices.engines(sources: sources, preferred: [
            EnginePick(engine: draft.engine, provider: draft.provider),
            EnginePick(engine: agent.defaultEngine(configured: draft.configuredProviders), provider: agent.defaultProvider),
        ])
    }

    /// The draft's engine on the draft's own provider, drawn as it is even where that provider is no
    /// longer on offer (a key since removed), so the hero still names what it would run.
    private var currentEngine: EngineChoice {
        SessionProviderChoices.currentEngine(engine: draft.engine, provider: draft.provider, engines: engines,
                                             sources: sources)
    }

    /// The machine this draft would run on, by the name its page gives it.
    private var machineName: String? {
        agent.runnerId.flatMap { app.agents?.runnerLabel($0) }
    }

    private var currentProviderChoice: ProviderChoice {
        currentEngine.provider
            ?? SessionProviderChoices.current(engine: draft.engine, provider: draft.provider, in: [], sources: sources)
    }
}

/// `From Scheduled` after a page chat's title (design §4.3 D4 A; the web's `.session-origin-tag`): a card left in the
/// chat is reachable from the session list. Nothing for any other session.
struct SessionOriginTagView: View {
    let session: Session

    var body: some View {
        if let tag = ScheduledChatLogic.originTag(session.chatOrigin) {
            Text(tag)
                .font(.orbitMeta)
                .foregroundStyle(Color.accentColor)
                .padding(.horizontal, 6)
                .padding(.vertical, 1)
                .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                .lineLimit(1)
                .fixedSize()
                .accessibilityIdentifier("session-origin-tag")
        }
    }
}

struct AgentSessionRow: View {
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif
    let session: Session
    /// True when the Trash tab is showing this row; the preview goes static because nothing in
    /// Trash is directly resumable. The status glyph remains the run's actual outcome.
    var deleted: Bool = false
    /// The project this row belongs to where the list has no row for that project (owner 2026-11-07,
    /// option A): its progress leads the second line, as it leads a project row's.
    var projectMark: SessionProjectMark? = nil
    @Environment(AppModel.self) private var app
    /// The live watches that will resume this session: what a parked row says it's doing instead.
    private var watching: WatchSessionSummary? { app.watches?.summary(for: session.id) }
    // Second line: the recap / last-reply / live-state preview (mirrors the web Agent console).
    // `live` mirrors web's `openable` — false on the Trash tab (a deleted session isn't live), true
    // elsewhere — and `recaps` is the account's Session recaps switch, read from the same `me` every
    // other preference comes from (absent means on). The whole line is the sentence: no tags beside
    // it and no "Recap · <time>" before it (the owner, 2026-10-22). Tags are filed and filtered by.
    private var line: SessionLine {
        SessionLine.make(for: session, live: !deleted, watching: watching,
                         recaps: app.user?.preferences?.showRecaps ?? true, machine: machine,
                         cloneHeard: app.cloneLedger.heard(session.agent?.id ?? session.agentId))
    }
    /// The machine the session runs on: a session held for the Claude region names it ("Anthropic
    /// unavailable on HPC", web `sessionLine`'s `machine`).
    private var machine: String? { app.agents?.machineName(for: session) }
    /// The state from `phase` and the marks beside it (`SessionDisplay`); nil from an older server,
    /// which keeps the glyph and the value the row always had.
    private var displayState: SessionDisplayState? { SessionDisplay.state(session.displayFacts) }
    private var marks: [SessionMark] { SessionDisplay.marks(session.displayFacts) ?? [] }
    /// The chips after the line: Needs you alone, the rest being title-line icons (`rowIcons`).
    private var rowMarks: [SessionMark] { SessionDisplay.rowMarks(session.displayFacts) ?? [] }
    /// Failed, Retrying, On hold, Background and Will resume, drawn at the end of the title line rather than as chips.
    private var rowIcons: [SessionRowIcon] { SessionDisplay.rowIcons(session.displayFacts) }
    /// The row's VoiceOver value: "Idle, Interrupted", else, from an older server, `statusWord`.
    private var statusValue: String {
        if let displayState { return SessionDisplay.spoken(displayState, marks) }
        return SessionHeader.statusWord(for: session, watching: watching, machine: machine)
    }

    var body: some View {
        #if os(iOS)
        if SessionListPresentation.resolve(
            isCompactWidth: horizontalSizeClass == .compact
        ) == .regular {
            regularIOSRow
        } else {
            compactRow
        }
        #else
        HStack(spacing: 0) {
            HStack(spacing: 8) {
                StatusGlyphView(glyph: displayState?.glyph ?? .make(for: session, watching: watching, machine: machine))
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(session.title ?? "Untitled session").lineLimit(1)
                        SessionOriginTagView(session: session)
                        if !rowIcons.isEmpty {
                            Spacer(minLength: 4)
                            SessionRowIconsView(icons: rowIcons)
                        }
                    }
                    HStack(spacing: 7) {
                        SessionCoordinatorBadge(session: session)
                        Text(line.text).font(.orbitListSubtitle)
                            .foregroundStyle(lineColor(line.tone)).lineLimit(1)
                            // A full runner, run or batch: which one, and how its slots are taken.
                            .help(QueuedCapacity.rowHint(session, machine: machine, now: Date()) ?? "")
                        if !rowMarks.isEmpty {
                            Spacer(minLength: 4)
                            SessionMarkPills(marks: rowMarks)
                        }
                    }
                }
                Spacer()
                if let n = session.pendingApprovals, n > 0 {
                    Text("\(n)").font(.orbitMeta.bold())
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(.orange, in: Capsule()).foregroundStyle(.white)
                }
            }
            // Re-add the standard cell insets the zeroed `listRowInsets` removed: the usual 16pt
            // leading so the glyph stays put; 16 trailing; 10 vertical for a comfortable row.
            .padding(.leading, 16)
            .padding(.trailing, 16)
            .padding(.vertical, 10)
        }
        .listRowInsets(EdgeInsets())
        // Keep the separator aligned under the title now that the cell insets are zeroed, rather than
        // letting it run full-bleed: leading pad(16) + glyph(20) + spacing(8) = 44.
        .alignmentGuide(.listRowSeparatorLeading) { _ in 44 }
        #endif
    }

    #if os(iOS)
    /// The regular-width iPad row: two stable scan lines. Title and time own the first line; live
    /// state takes the timestamp's slot while working. The second line is the preview, truncated.
    private var regularIOSRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(session.title ?? "Untitled session")
                    .lineLimit(1)
                    .layoutPriority(1)
                SessionOriginTagView(session: session)
                Spacer(minLength: 8)
                SessionRowIconsView(icons: rowIcons)
                liveIndicator
                if let rel = relTime {
                    Text(rel)
                        .font(.orbitMeta)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            HStack(spacing: 7) {
                if let projectMark { SessionProjectMarkChip(mark: projectMark) }
                SessionCoordinatorBadge(session: session)
                Text(line.text)
                    .font(.orbitListSubtitle)
                    .foregroundStyle(lineColor(line.tone))
                    .lineLimit(1)
                phoneMarks
            }
        }
        .padding(.vertical, 5)
        .accessibilityElement(children: .combine)
        .accessibilityValue(statusValue)
    }

    /// The compact (iPhone) row for the ChatGPT-style grouped list: a flush-left title with a
    /// trailing relative time, a slim live cue (spinner while working / amber dot when it needs you /
    /// red dot on failure), over the preview line. No leading status glyph or pin accent bar — the
    /// recency sections carry pinning, and the preview line already states the live status in words +
    /// colour, so the heavy per-row glyph column is dropped for a calmer, more scannable list.
    private var compactRow: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Text(session.title ?? "Untitled session").lineLimit(1)
                SessionOriginTagView(session: session)
                Spacer(minLength: 8)
                SessionRowIconsView(icons: rowIcons)
                liveIndicator
                if let rel = relTime {
                    Text(rel).font(.orbitMeta).foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 7) {
                if let projectMark { SessionProjectMarkChip(mark: projectMark) }
                SessionCoordinatorBadge(session: session)
                Text(line.text).font(.orbitListSubtitle).foregroundStyle(lineColor(line.tone)).lineLimit(1)
                phoneMarks
            }
        }
        .padding(.vertical, 2)
        // Combine the row's text into one VoiceOver element and speak the session's state as its
        // value — the visible cue only covers working/needs-you/failed, so the calm states (dormant,
        // done, queued) would otherwise no longer announce their status the way the dropped leading
        // glyph did. `statusWord` is the shared, tested port of web's `statusLabel`.
        .accessibilityElement(children: .combine)
        .accessibilityValue(statusValue)
    }

    /// The marks at the right end of a phone row's second line: at most two, then "+N".
    @ViewBuilder private var phoneMarks: some View {
        if !rowMarks.isEmpty {
            let row = SessionDisplay.phoneRowMarks(rowMarks)
            Spacer(minLength: 4)
            SessionMarkPills(marks: row.shown, more: row.more)
        }
    }

    /// The slim trailing status cue for the compact row — the shared `SessionLiveIndicator` (spinner
    /// while working / amber dot when it needs you / red dot on failure / eye while a watch will
    /// resume it; calm states stay quiet).
    private var liveIndicator: some View {
        SessionLiveIndicator(session: session, watching: watching)
    }

    /// Relative last-activity time ("just now", "3m ago", "2d ago", "7/8"). A working row omits
    /// it while its spinner is visible: the live cue already carries the useful information and a
    /// column of continuously refreshed "just now" labels only competes with session titles.
    private var relTime: String? {
        SessionListTime.format(for: session)
    }
    #endif

    private func lineColor(_ tone: SessionLine.Tone) -> Color {
        switch tone {
        case .preview, .queued, .background, .watching, .review: return .secondary
        case .running:                       return .blue
        case .approval, .warning:            return .orange
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
            case .symbol(let name) where glyph.pulse:
                // The one state that moves without spinning: a background job in flight. Same
                // symbol, same neutral tone as the still case — only the claim changes.
                BreathingGlyph(systemImage: name)
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
/// when it needs you (approval), a red dot on failure, the strip's eye for a session a watch will
/// resume, and the two states where something is still under way without the agent generating —
/// the clock of a session queued for a slot, and the terminal of a background process (breathing
/// for a job in flight, still for a process merely left up), each the glyph the web row draws.
/// The settled states (waiting for a reply, ended, succeeded) show nothing: the surrounding row
/// states them in words + colour and in its VoiceOver value, so the jump-back lists (the grouped
/// session list and the drawer's Recents) stay light. Shared so both show the exact same cue.
struct SessionLiveIndicator: View {
    let session: Session
    /// The live watches that will resume this session (`AgentSessionRow.watching`); nil where a list
    /// holds none, which keeps the reading it always had.
    var watching: WatchSessionSummary? = nil
    @ViewBuilder var body: some View {
        // With the session facts, the slot always draws the state icon from `phase`, in the quiet
        // tone; the marks go to the row's second line (`SessionDisplay`).
        if let state = SessionDisplay.state(session.displayFacts) {
            switch state {
            case .running: SpinnerGlyph(color: .secondary)
            case .queued:  Image(systemName: "clock").font(.orbitGlyph).foregroundStyle(.secondary)
            // Idle draws nothing (owner, 2026-11-27): a settled row is already said by its line and its
            // VoiceOver value, and a hollow circle beside the time read as a control.
            case .idle:    EmptyView()
            }
        } else {
            legacyCue
        }
    }

    /// What the slot drew before the session facts, and still draws against an older server.
    @ViewBuilder private var legacyCue: some View {
        let glyph = SessionStatusGlyph.make(for: session, watching: watching)
        switch (glyph.shape, glyph.tone) {
        // Working is the one live state that does *not* want you — the row is making progress on
        // its own. Amber (needs you) and red (failed) are the two that do, so the working cue is
        // deliberately the quietest of the three and leaves blue to mean selection and
        // tappability: it used to sit inches from a blue tag chip on the same row, two unrelated
        // meanings in one hue.
        case (.spinner, _): SpinnerGlyph(color: .secondary)
        // Parked on a watch that will resume it: a wake is coming and nobody is being asked anything,
        // so it is the strip's eye, still — the mark the macOS row and the web glyph draw for the same
        // wait — and it takes the place a job's breathing terminal would (contract §9.2: a watch is
        // not a process). The glyph has already let a question for you or work of its own outrank it.
        case (.symbol("eye"), _):
            Image(systemName: "eye").font(.orbitGlyph).foregroundStyle(.secondary)
        // Under review (contract §5 N3), or queued for a slot (a full runner, the Claude region): the
        // clock the macOS row and the web glyph draw, in the quiet tone — the session is waiting on
        // somebody else, not on you, and nothing here is amber.
        case (.symbol("clock"), .neutral):
            Image(systemName: "clock").font(.orbitGlyph).foregroundStyle(.secondary)
        // The one background state that is NOT quiet. A compact row's only live cue used to go
        // silent here, which is exactly the reading the session row stopped giving: a job in
        // flight is work happening with nobody generating, and this is the surface where the row
        // says nothing else about it. Still not a spinner — the whole point is that it is calm
        // work, so it breathes. Details, including the words, stay in the row's accessibility
        // value (`SessionHeader.statusWord`), which is why this carries no label of its own.
        case (.symbol, .neutral) where glyph.pulse:
            BreathingGlyph(systemImage: "terminal")
        // A process merely left up (a dev server, a watcher): the same terminal, still. The row's line
        // already says "Background process running", and the glyph now says it too — without motion,
        // so a service that never exits cannot make the row look busy.
        case (.symbol("terminal"), _):
            Image(systemName: "terminal").font(.orbitGlyph).foregroundStyle(.secondary)
        case (_, .warning): Circle().fill(.orange).frame(width: 7, height: 7)
        case (_, .error):   Circle().fill(.red).frame(width: 7, height: 7)
        default:            EmptyView()
        }
    }
}

/// Whether the animated row cues in this subtree — `SpinnerGlyph` and `BreathingGlyph` — are on
/// screen, and so may redraw. True everywhere by default; the compact shell's agents stack sets it
/// false for the session list a page has been pushed over.
///
/// That list is not torn down by the push — keeping it mounted is what keeps its rows and scroll
/// position for the pop back — but not one pixel of it is on screen. One
/// `TimelineView(.animation)` per running row went on redrawing at the display's cadence anyway, so
/// the cost of the list scaled with how many sessions were running even while the list was behind a
/// conversation. The drawer's own cues are held back the same way by its `live:` parameter; this is
/// that switch, for the rows themselves.
private struct LiveRowCuesKey: EnvironmentKey { static let defaultValue = true }

extension EnvironmentValues {
    var liveRowCues: Bool {
        get { self[LiveRowCuesKey.self] }
        set { self[LiveRowCuesKey.self] = newValue }
    }
}

/// A symbol that breathes — a slow opacity pulse, the web's `status-glyph-active`. It is the one
/// motion in this vocabulary that is neither rotation nor a dot, and it means one thing: there is
/// work happening here, without the agent generating. Drawn in the neutral tone, which is the tone
/// of the only glyph that ever pulses (the terminal, for a background job in flight). Time-derived
/// like `SpinnerGlyph`, so a row re-rendering many times a second (a streaming neighbour) cannot
/// change its phase.
struct BreathingGlyph: View {
    let systemImage: String
    private let period: Double = 2.4   // seconds per breath; the web's 2.4s keyframes
    private let trough: Double = 0.42  // the web's 50% keyframe
    private let frameInterval: Double = 1.0 / 30.0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.liveRowCues) private var liveRowCues
    var body: some View {
        if reduceMotion || !liveRowCues {
            // The words are the state; the motion is only emphasis, and this is the ambient loop
            // that reduced-motion exists to switch off — or one drawn for a list that is not on
            // screen at all (see `liveRowCues`).
            symbol
        } else {
            TimelineView(.animation(minimumInterval: frameInterval)) { context in
                let phase = context.date.timeIntervalSinceReferenceDate
                    .truncatingRemainder(dividingBy: period) / period
                // cos gives the 1 → trough → 1 shape of an ease-in-out breath, without an
                // animation that re-rendering would restart.
                let wave = (1 - cos(phase * 2 * .pi)) / 2
                symbol.opacity(1 - (1 - trough) * wave)
            }
        }
    }
    private var symbol: some View {
        Image(systemName: systemImage).font(.orbitGlyph).foregroundStyle(.secondary)
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
struct SpinnerGlyph: View {
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
    @Environment(\.liveRowCues) private var liveRowCues
    var body: some View {
        if liveRowCues {
            TimelineView(.animation(minimumInterval: frameInterval)) { context in
                arc(angle: context.date.timeIntervalSinceReferenceDate
                    .truncatingRemainder(dividingBy: period) / period * 360)
            }
        } else {
            // A list that is not on screen (see `liveRowCues`): the arc is drawn once, still. Nobody
            // can see it — what matters is that no display link runs for it, and that the angle is a
            // pure function of the clock again the moment the list is the page showing.
            arc(angle: 0)
        }
    }
    private func arc(angle: Double) -> some View {
        Circle()
            .trim(from: 0, to: 0.7)
            .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round))
            .frame(width: 13, height: 13)
            .rotationEffect(.degrees(angle))
    }
}

/// The edit form. Fields mirror the web RunnerDetailPage agent form: name, effort, Instructions
/// (appendSystemPrompt), working directory, enabled, and smart model selection for its task runs.
/// There is no runtime field — an agent holds no
/// provider; that is picked per session in the composer. Nor a permission mode: migration 0094
/// dropped that column (the posture is per-run, seeded from the account — Settings → Default
/// permission). Empty Instructions / workDir omit the key (no change) — matching the web, which
/// sends `undefined` when blank.
struct AgentFormContent: View {
    let agents: AgentsModel
    let agent: Agent
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var app

    @State private var name = ""
    @State private var effort: Effort = .default
    @State private var instructions = ""
    @State private var workDir = ""
    @State private var enabled = true
    @State private var subagentsEnabled = true
    @State private var subagentsMaxRunning = SubagentSettings.defaultMaxRunning
    @State private var workflowsEnabled = true
    @State private var confirmingDelete = false
    #if os(macOS)
    /// Agent Tools for this workspace (docs/mocks/agent-tools board ⑤), and whether its Edit asked for the
    /// Instructions editor, which takes the focus once the sheet has gone.
    @State private var showingAgentTools = false
    @State private var editInstructionsAfterAgentTools = false
    @FocusState private var instructionsFocused: Bool
    #endif

    /// Not editable fields: an agent holds no engine or provider. This is what the project last ran
    /// on, and it is here only because the effort vocabulary below genuinely differs by engine. The
    /// choice itself lives in the composer, per session.
    private var provider: String { agent.defaultProvider }
    private var engine: String { agent.defaultEngine(configured: agents.configuredProviders) }

    private var effortOptions: [Effort] {
        // `model` / `modelCatalog` were dropped when agents stopped storing a model default; the
        // Runtime-resolved `effectiveModel` and the runner's own catalog replace them.
        let catalog = agents.modelCatalog(for: agent.runnerId)
        let options = AgentDefaults.efforts(for: engine, provider: provider, model: effectiveModel,
                                            catalog: catalog, configured: agents.configuredProviders)
        let current = AgentDefaults.normalizedEffort(
            effort, for: engine, provider: provider, model: effectiveModel, catalog: catalog,
            configured: agents.configuredProviders)
        return options.contains(current) ? options : [current] + options
    }

    /// Agents no longer store a model default. Resolve the model this Runtime will provide, which
    /// is what the effort vocabulary above is drawn from.
    private var effectiveModel: String {
        agents.effectiveDefaultModel(engine: engine, provider: provider, runnerId: agent.runnerId)
    }

    var body: some View {
        Form {
            Section {
                TextField("Name", text: $name, prompt: Text("e.g. tea-cli builder"))

                // A new session with this agent seeds its reasoning effort from here; "Default"
                // (the empty value) leaves it to the model's default.
                Picker("Effort", selection: $effort) {
                    ForEach(effortOptions) {
                        Text($0.label).tag($0)
                    }
                }

                Toggle("Enabled", isOn: $enabled)
                // Takes effect at once (board 04), apart from Done: it asks first when the main checkout
                // holds what new sessions would no longer see.
                WorktreeIsolationSwitch(workspace: agent)
            }

            WorkspaceLandingSection(agent: agent)

            Section("Instructions") {
                TextEditor(text: $instructions)
                    .frame(minHeight: 90)
                    .font(.body)
                    #if os(macOS)
                    .focused($instructionsFocused)
                    #endif
                Text("Added to every run's runtime instructions (optional).")
                    .font(.orbitLabel).foregroundStyle(.secondary)
            }

            #if os(macOS)
            // Agent Tools (docs/mocks/agent-tools board ⑤): what a session here is given — Orbit's tools, the
            // instructions it reads and in what order, the playbooks — in the read-only sheet a session's toolbar
            // opens, without the session's own connection. The Mac only this round; iOS changed only the copy.
            Section {
                Button(AgentToolsCopy.settingsButton) { showingAgentTools = true }
            } footer: {
                Text(AgentToolsCopy.workspaceRow)
            }
            #endif

            Section("Working directory") {
                TextField("Path", text: $workDir,
                          prompt: Text("/path/to/project on the runner (optional)"))
            }

            SubagentSettingsSection(agents: agents, enabled: $subagentsEnabled,
                                    workflowsEnabled: $workflowsEnabled, maxRunning: $subagentsMaxRunning)

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
                    // Delete is destructive and drops the agent from the list, so gate it behind an
                    // explicit confirmation — on the button that asks, so the panel opens against it
                    // rather than at the top of the form. The server soft-deletes (its sessions are
                    // kept and stay linked); close the sheet afterward since the agent is gone from
                    // here.
                    .orbitConfirmation("Delete \(agent.name)?", isPresented: $confirmingDelete) {
                        Button("Delete agent", role: .destructive) {
                            dismiss()
                            Task { await agents.delete(agent.id) }
                        }
                        Button("Cancel", role: .cancel) { }
                    } message: {
                        Text("This removes the workspace from your Workspaces list. Its sessions are kept.")
                    }
            }
        }
        .formStyle(.grouped)
        #if os(macOS)
        // The instructions it lays out are the ones in the editor above, so what is typed shows before Done.
        .sheet(isPresented: $showingAgentTools, onDismiss: {
            if editInstructionsAfterAgentTools { instructionsFocused = true }
            editInstructionsAfterAgentTools = false
        }) {
            AgentToolsSheet(
                mode: .workspace(
                    name: agent.name, instructions: instructions,
                    baseInstructions: !(agent.systemPrompt ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                    // Settings' reading of the switch: absent is on.
                    orchestrationOn: app.user?.preferences?.enableOrchestration ?? true),
                onDone: { showingAgentTools = false },
                onEditInstructions: {
                    editInstructionsAfterAgentTools = true
                    showingAgentTools = false
                })
        }
        #endif
        .onAppear(perform: prefill)
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
    }

    private func prefill() {
        name = agent.name
        effort = prefilledEffort
        instructions = agent.appendSystemPrompt ?? ""
        workDir = agent.workDir ?? ""
        enabled = agent.enabled ?? true
        subagentsEnabled = agent.subagentsEnabled ?? true
        subagentsMaxRunning = SubagentSettings.maxRunning(agent.subagentsMaxRunning)
        workflowsEnabled = agent.workflowsEnabled ?? true
    }

    /// True when the working copy diverges from the agent as prefilled — mirrors `prefill()` field
    /// for field so a look-and-close never fires a needless PATCH.
    private var prefilledEffort: Effort {
        let saved = Effort(rawValue: agent.effort ?? "") ?? .default
        return AgentDefaults.normalizeEffort(saved, for: engine)
    }

    private var isDirty: Bool {
        name != agent.name
        || effort != prefilledEffort
        || instructions != (agent.appendSystemPrompt ?? "")
        || workDir != (agent.workDir ?? "")
        || enabled != (agent.enabled ?? true)
        || subagentsEnabled != (agent.subagentsEnabled ?? true)
        || subagentsMaxRunning != SubagentSettings.maxRunning(agent.subagentsMaxRunning)
        || workflowsEnabled != (agent.workflowsEnabled ?? true)
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
            // Always send the raw value ("" for Default) so picking Default actually clears a
            // previously-set effort — omitting (nil) would leave the old value unchanged.
            effort: effort.rawValue,
            workDir: workDir.isEmpty ? nil : workDir,
            enabled: enabled,
            // SubAgents: each only when moved.
            subagentsEnabled: subagentsEnabled != (agent.subagentsEnabled ?? true) ? subagentsEnabled : nil,
            subagentsMaxRunning: subagentsMaxRunning != SubagentSettings.maxRunning(agent.subagentsMaxRunning)
                ? subagentsMaxRunning : nil,
            workflowsEnabled: workflowsEnabled != (agent.workflowsEnabled ?? true) ? workflowsEnabled : nil
        )
        Task { await agents.save(agent.id, req) }
    }
}

#if os(iOS)
/// Grey rows standing in for a session list that has never been read on this phone (board 02 ④ of
/// docs/mocks/ios-launch-updating), in place of a blank page with a centred "Loading…".
private struct SessionListPlaceholder: View {
    private static let widths: [(CGFloat, CGFloat)] = [
        (0.72, 0.46), (0.60, 0.52), (0.80, 0.38), (0.55, 0.60), (0.68, 0.42), (0.76, 0.50),
    ]

    var body: some View {
        GeometryReader { geo in
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Self.widths.indices, id: \.self) { i in
                    VStack(alignment: .leading, spacing: 8) {
                        Capsule().frame(width: geo.size.width * Self.widths[i].0, height: 12)
                        Capsule().frame(width: geo.size.width * Self.widths[i].1, height: 10)
                    }
                    .padding(.vertical, 14)
                    Divider()
                }
            }
            .foregroundStyle(.quaternary)
            .padding(.horizontal, 16)
        }
        .accessibilityHidden(true)
        .allowsHitTesting(false)
    }
}
#endif
