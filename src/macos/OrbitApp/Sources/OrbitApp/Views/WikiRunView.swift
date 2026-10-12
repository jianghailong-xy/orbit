import SwiftUI
import OrbitKit

// One run (criterion 8, mock 18 ④⑤): what a maintenance run, an import or a session's proposal
// applied at once — who it was and when, Revert run… and the session behind it, what it counted, and
// its entries grouped Added / Amended / Reinforced — pushed from its row in Recently changed.
//
// The web's run drawer, block for block and in its order (`WikiRunPage.tsx`); every count and word is
// `WikiModeLogic` / `WikiModeCopy`, held to the web's by `WikiReviewModeCopyParityTests`. The run is
// read by its own id (`GET /wiki/changesets/:id`), whatever of it still waits in Review: the server
// counts it and says whether Revert run… would take anything back.

/// Where a press on a run's page goes.
struct WikiRunActions {
    var revert: () -> Void = {}
    var openSession: (String) -> Void = { _ in }
    var openEntry: (String) -> Void = { _ in }
    var reject: (String, WikiRejectReason) -> Void = { _, _ in }
}

/// One run's page, drawn from its own read: the changeset, the entries its ops name, and the server's counts.
struct WikiRunPage: View {
    let run: WikiChangesetView
    var busy = false
    var actions = WikiRunActions()

    private var changeset: WikiChangeset { run.changeset }
    private var entries: [WikiEntry] { run.entries }

    /// How many rows a group shows before `Show N more` — the web drawer's number.
    private static let shownPerGroup = 4

    @State private var expanded: Set<String> = []
    /// The row whose Reject is asking for its reason.
    @State private var rejecting: WikiModeLogic.RunRow?

    private var summary: WikiModeLogic.RunSummary { WikiModeLogic.runSummary(run) }

    var body: some View {
        let counted = summary
        List {
            Section { head(counted) }
            Section {
                countsRow(counted)
            }
            group(WikiModeCopy.runAdded, counted.added)
            group(WikiModeCopy.runAmended, counted.amended)
            group(WikiModeCopy.runReinforced, counted.reinforced)
        }
        .wikiRunListStyle()
        .navigationTitle("")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    /// The kicker, the count as the title, when — then Revert run… and Open session side by side.
    private func head(_ summary: WikiModeLogic.RunSummary) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(WikiModeCopy.runKicker(changeset.origin))
                .font(.orbitLabel.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(WikiModeCopy.appliedChanges(summary.applied))
                .font(.title2.bold())
            if let at = changeset.createdAt {
                Text(WikiModeLogic.runWhen(at))
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 10) {
                Button(action: actions.revert) {
                    Label(WikiModeCopy.revertRun, systemImage: "arrow.uturn.backward")
                        .frame(maxWidth: .infinity, minHeight: 32)
                }
                .buttonStyle(.bordered)
                .tint(.red)
                .disabled(busy || !summary.revertible)
                if let session = changeset.sessionId {
                    Button { actions.openSession(session) } label: {
                        Text(WikiModeCopy.openSession).frame(maxWidth: .infinity, minHeight: 32)
                    }
                    .buttonStyle(.bordered)
                }
            }
            .padding(.top, 4)
        }
        .padding(.vertical, 4)
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4))
    }

    /// `13 Auto · 10 Unreviewed · 2 rejected by the check · 1 to review`.
    private func countsRow(_ summary: WikiModeLogic.RunSummary) -> some View {
        Text(WikiModeLogic.runCounts(summary).joined(separator: "  ·  "))
            .font(.orbitLabel)
            .foregroundStyle(.secondary)
    }

    /// One of the run's three groups, left out when it is empty.
    @ViewBuilder
    private func group(_ title: String, _ rows: [WikiModeLogic.RunRow]) -> some View {
        if !rows.isEmpty {
            Section {
                let open = expanded.contains(title)
                ForEach(open ? rows : Array(rows.prefix(Self.shownPerGroup))) { row in runRow(row) }
                if rows.count > Self.shownPerGroup {
                    Button(open ? WikiModeCopy.showLess : WikiModeCopy.showMore(rows.count - Self.shownPerGroup)) {
                        if open { expanded.remove(title) } else { expanded.insert(title) }
                    }
                }
            } header: {
                HStack(spacing: 6) {
                    Text(title)
                    Text("\(rows.count)").foregroundStyle(.secondary)
                }
            }
        }
    }

    /// An entry of the run: its title and one line, its mark; a swipe takes it back with a reason.
    private func runRow(_ row: WikiModeLogic.RunRow) -> some View {
        let entry = row.entryId.flatMap { id in entries.first { PublicID.storageKey($0.id) == PublicID.storageKey(id) } }
        let answerable = entry.map { WikiModeLogic.answerable(status: $0.status, trust: $0.trust) } ?? false
        return Button {
            if let id = row.entryId { actions.openEntry(id) }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title)
                        .font(.orbitProse)
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                    if !row.summary.isEmpty {
                        Text(row.summary)
                            .font(.orbitListSubtitle)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                if let trust = row.trust, trust != .unknown {
                    WikiBadge(text: WikiCopy.trustLabel(trust), tone: WikiLogic.trustTone(trust))
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .trailing) {
            if answerable {
                Button(WikiCopy.reject, role: .destructive) { rejecting = row }
            }
        }
        // On the entry's own row, whose swipe raises it, so the panel opens against the row rather
        // than at the top of the page.
        .orbitConfirmation(WikiModeCopy.rejectOnRecord,
                           isPresented: Binding(get: { rejecting != nil }, set: { if !$0 { rejecting = nil } })) {
            ForEach(WikiRejectReason.allCases, id: \.self) { reason in
                Button(WikiCopy.rejectReasonLabel(reason)) {
                    if let id = rejecting?.entryId { actions.reject(id, reason) }
                    rejecting = nil
                }
            }
            // The reasons are the question; this is the way out of it.
            Button(WikiModeCopy.cancel, role: .cancel) {}
        }
    }
}

/// The screen: the run as its own read answers it, the Revert confirm, and where a press goes.
struct WikiRunView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let changesetID: String

    @State private var reverting = false
    @State private var notice: String?
    @State private var noticeTitle = WikiCopy.runRevertFailed

    var body: some View {
        if let wiki = model.wiki {
            Group {
                if let changeset = wiki.run(changesetID) {
                    WikiRunPage(run: changeset, busy: wiki.busy, actions: actions(wiki))
                        .alert(WikiModeCopy.revertTitle, isPresented: $reverting) {
                            Button(WikiModeCopy.cancel, role: .cancel) {}
                            Button(WikiModeCopy.revertRunConfirm, role: .destructive) {
                                Task {
                                    if let answer = await wiki.revert(changeset) {
                                        noticeTitle = WikiCopy.runRevertFailed
                                        notice = answer
                                    } else {
                                        model.showToast(WikiModeCopy.reverted)
                                        dismiss()
                                    }
                                }
                            }
                        } message: {
                            let summary = WikiModeLogic.runSummary(changeset)
                            Text(WikiModeLogic.revertBody(summary) + "\n" + WikiModeCopy.revertKeeps)
                        }
                } else if wiki.isMissingRun(changesetID) {
                    // A run the server does not know: nothing to draw, and nothing said it cannot back.
                    Color.clear
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .task(id: changesetID) { await wiki.loadRun(changesetID) }
            .alert(noticeTitle, isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
                Button("OK", role: .cancel) { notice = nil }
            } message: {
                Text(notice ?? "")
            }
        } else {
            ProgressView()
        }
    }

    private func actions(_ wiki: WikiModel) -> WikiRunActions {
        WikiRunActions(
            revert: { reverting = true },
            openSession: { id in model.openFromConversation(.session(PublicID.toPublic(id)), overConsole: false) },
            openEntry: { id in model.push(.wikiEntry(entryID: id)) },
            reject: { id, reason in
                Task {
                    if let answer = await wiki.reject(id, reason: reason) {
                        noticeTitle = WikiCopy.entryRejectFailed
                        notice = answer
                    } else {
                        model.showToast(WikiModeCopy.rejected)
                    }
                }
            })
    }
}

private extension View {
    /// Grouped cards on iOS, the platform's inset list on macOS — the entry page's shape.
    @ViewBuilder func wikiRunListStyle() -> some View {
        #if os(iOS)
        self.listStyle(.insetGrouped)
        #else
        self.listStyle(.inset)
        #endif
    }
}
