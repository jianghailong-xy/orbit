import SwiftUI
import OrbitKit

// The ⌘K session palette, shared by macOS and iOS (the iOS target compiles this file in place —
// see src/ios/project.yml). SwiftUI here is parse-checked only on Linux; verify on a Mac.
//
// A sheet, opened by ⌘K, the macOS menu command and the iOS drawer's magnifier. The iPhone/iPad
// session list runs this same search *inline* instead (see `AgentPanes`) — a sheet over the list
// you're already looking at is a detour on touch. It stays a sheet everywhere else because there's
// no list to search in place: the macOS window is a three-pane layout the palette floats over, and
// the drawer's entry point fires from whichever section you're in.
//
// Either way the results are their own view, never rows merged into a session list's sections: the
// search spans every agent, runner and lifecycle scope, so a hit carries the agent it belongs to,
// a Completed/Trash badge and the snippet it matched on — which is what stops a cross-scope result
// from reading as a session the list itself is claiming to hold.

/// How long a search waits after the last keystroke before firing. Matches the web palette, and
/// shared with the session list's inline search so both settle at the same rhythm.
let sessionSearchDebounce = Duration.milliseconds(200)

/// What the hit matched on, when it isn't the title (which the row already shows).
private func matchLabel(_ field: SessionSearchMatchField) -> String? {
    switch field {
    case .id:     return "ID"
    case .title, .recent: return nil
    case .prompt:  return "first message"
    case .reply:   return "last reply"
    case .message: return "message"
    case .branch:  return "branch"
    case .agent:   return "agent"
    case .task:    return "task"
    }
}

/// Where a hit lives, when that isn't the normal Open list — so a result the user can't find in
/// their session list explains itself instead of looking like a ghost.
private func scopeBadge(_ hit: SessionSearchHit) -> String? {
    switch hit.effectiveLifecycleState {
    case .open, .unknown: return nil
    case .completed: return "Completed"
    case .trash: return "Trash"
    }
}

struct SessionSearchView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var query = ""
    @State private var hits: [SessionSearchHit] = []
    @State private var contentSearched = true
    @State private var loading = false
    /// Matches the server found, which is more than `hits` whenever the page was capped — the
    /// palette has no paging, so the count is the only sign the rest exists.
    @State private var total = 0
    /// The query the currently displayed `hits` came from — what the snippets are highlighted
    /// against, so highlighting can't run ahead of the results while typing.
    @State private var shownQuery = ""

    var body: some View {
        // NavigationStack so `.searchable` has a bar to live in — without one the field never
        // renders and the palette opens with no way to type into it.
        NavigationStack {
            VStack(spacing: 0) {
                List(hits) { hit in
                    Button { open(hit) } label: { SessionSearchRow(hit: hit, query: shownQuery) }
                        .buttonStyle(.plain)
                }
                .overlay {
                    if hits.isEmpty && !loading {
                        ContentUnavailableView(
                            shownQuery.isEmpty ? "No sessions yet" : "No matches",
                            systemImage: "magnifyingglass",
                            description: Text(shownQuery.isEmpty
                                              ? "Recent sessions will appear here."
                                              : "Nothing matches \u{201C}\(shownQuery)\u{201D}."))
                    }
                }
                footer
            }
            .searchable(text: $query, prompt: "Search sessions")
            .navigationTitle("Search Sessions")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    // `.cancelAction` is what binds Esc — the placement above only decides where the
                    // button sits. Without it a sheet swallows Esc, and on macOS the search field
                    // would eat the key to clear itself instead of closing the palette.
                    Button("Done") { dismiss() }
                        .keyboardShortcut(.cancelAction)
                }
            }
        }
        // Sized for macOS, where a sheet has no intrinsic size. On iOS the sheet fills the screen
        // and this is ignored.
        #if os(macOS)
        .frame(minWidth: 560, minHeight: 460)
        #endif
        // Fires on open (empty query -> recents) and again on every keystroke, cancelling the
        // previous run — which is what makes the debounce inside `runSearch` work.
        .task(id: query) { await runSearch() }
    }

    private var footer: some View {
        HStack {
            if !contentSearched && !shownQuery.isEmpty {
                Label("Matching names only — type more to search message text.",
                      systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
            } else if !shownQuery.isEmpty && total > hits.count {
                Text("Top \(hits.count) of \(total) matching sessions")
                    .foregroundStyle(.secondary)
            } else {
                Text(shownQuery.isEmpty ? "Recent sessions"
                                        : "IDs, titles, messages, agents and tasks")
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if loading { ProgressView().controlSize(.small) }
        }
        .font(.orbitLabel)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }

    /// Debounced search. `.task(id:)` already cancels the previous run on a new keystroke, so the
    /// sleep is the debounce: a cancelled task never reaches the request.
    private func runSearch() async {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if !q.isEmpty {
            try? await Task.sleep(for: sessionSearchDebounce)
            if Task.isCancelled { return }
        }
        loading = true
        defer { loading = false }
        guard let res = await model.searchSessions(q) else { return }
        if Task.isCancelled { return }
        hits = res.hits
        contentSearched = res.contentSearched
        total = res.effectiveTotal
        shownQuery = res.q
    }

    private func open(_ hit: SessionSearchHit) {
        model.route(to: .session(hit.id))
        dismiss()
    }
}

/// One result row: status glyph, title (+ scope badge), agent · status · what matched, and the
/// snippet with the query marked. Mirrors the web palette's row.
struct SessionSearchRow: View {
    let hit: SessionSearchHit
    let query: String

    var body: some View {
        let glyph = SessionStatusGlyph.make(runState: hit.effectiveRunState)
        HStack(alignment: .top, spacing: 10) {
            StatusGlyphView(glyph: glyph)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(hit.title).lineLimit(1)
                    if let badge = scopeBadge(hit) {
                        Text(badge)
                            .font(.orbitLabel)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(.quaternary, in: RoundedRectangle(cornerRadius: 4))
                    }
                }
                HStack(spacing: 5) {
                    if let name = hit.agent?.name { Text(name) }
                    Text(glyph.label)
                    if let what = matchLabel(hit.matchField) { Text("in \(what)") }
                }
                .font(.orbitListSubtitle)
                .foregroundStyle(.secondary)
                .lineLimit(1)

                if let snippet = hit.snippet, hit.matchField != .title, hit.matchField != .recent {
                    highlighted(snippet).font(.orbitListSubtitle).lineLimit(1)
                }
            }
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
    }

    /// The snippet with every occurrence of the query marked, built from the OrbitKit splitter so
    /// macOS, iOS and web all mark the same runs.
    private func highlighted(_ snippet: String) -> Text {
        SessionSearchHighlight.split(snippet, query: query).reduce(Text("")) { acc, seg in
            acc + (seg.match
                   ? Text(seg.text).foregroundColor(.accentColor).fontWeight(.semibold)
                   : Text(seg.text).foregroundColor(.secondary))
        }
    }
}

extension View {
    /// Hosts the ⌘K palette. Applied at each platform's signed-in root — macOS `RootView`
    /// (OrbitApp.swift) and iOS `RootView` (OrbitiOSApp.swift) — rather than inside a shell,
    /// because iPhone and iPad use different shells (`CompactShell` / `MainView`) and the palette
    /// has to open from the menu command, the drawer button and a hardware ⌘K alike.
    func sessionSearchSheet(_ model: AppModel) -> some View {
        @Bindable var model = model
        return sheet(isPresented: $model.searchOpen) { SessionSearchView() }
    }
}
