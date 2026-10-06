import SwiftUI
import OrbitKit

// The Wiki's plan (criterion 11's owner half, criterion 10 revised: mocks 22 and 26 ③): the plan a wiki's
// documents are written from, as the owner reviews, confirms and changes it — the version shown and its
// history, the job that drafts it or writes its documents, the gate's report, the changes a maintenance
// run proposed, the categories and documents; a document's and a section's own pages; Redraft… and Edit;
// and the plan's banner on the home. Drawn from what the server said and nothing else; where a press goes
// is decided by the screen that mounts the page (`WikiScreens.swift`).
//
// The blocks are the web phone's, block for block and in its order (`WikiPlanPage.tsx`, `WikiPlanCard.tsx`);
// every word is `WikiPlanCopy` / `WikiPlanLogic`, which `WikiPlanCopyParityTests` holds to the web's.
//
// THE OWNER'S DOOR ONLY: every write goes through `WikiModel` on the JWT door; nothing here can be asked
// for by an agent.

/// Where a press on the plan's pages goes.
struct WikiPlanActions {
    /// Draft plan, on a space with none.
    var draft: () -> Void = {}
    /// Redraft…: the sheet with the owner's words.
    var redraft: () -> Void = {}
    var confirm: (Int) -> Void = { _ in }
    /// A version from the menu; nil for the one the page shows first.
    var pickVersion: (Int?) -> Void = { _ in }
    var openDoc: (String) -> Void = { _ in }
    /// A section of a document, by its place (0-based).
    var openSection: (String, Int) -> Void = { _, _ in }
    /// Edit a document: the sheet.
    var editDoc: (String) -> Void = { _ in }
    /// Edit one section, from its own page.
    var editSection: (String, Int) -> Void = { _, _ in }
    /// Accept a change — with `edit`, only accept, and open the new draft's document to edit.
    var accept: (WikiPlanProposal, _ edit: Bool) -> Void = { _, _ in }
    var reject: (WikiPlanProposal) -> Void = { _ in }
    var openRun: (String) -> Void = { _ in }
    var openSettings: () -> Void = {}
    var openRunners: () -> Void = {}
    var openContents: () -> Void = {}
    var openEntry: (String) -> Void = { _ in }
}

// MARK: - the plan page

/// The plan (mock 22 ②): the title with the version shown, where that version came from, Confirm plan and
/// Redraft…, a failed draft's hint, the job's card, the gate's report, the changes proposed, and the
/// categories and documents — `WikiPlanLogic.PageSection`'s order, which is the web phone's.
struct WikiPlanPage: View {
    let state: WikiPlanState
    /// The version shown, or nil: the empty page.
    let shown: WikiPlanLogic.Shown?
    /// What the shown version is held against: the protection check, a change's rows.
    let base: WikiPlanLogic.Shown?
    let versions: [WikiPlanLogic.VersionRow]
    let jobCard: WikiPlanLogic.JobCard?
    /// How far the documents of the version in force are written.
    let written: (written: Int, total: Int)?
    /// Where a draft runs, and on what: `orbit · wikova`, `local-vllm`.
    let whereItRuns: String?
    let provider: String?
    var busy = false
    /// The gate's errors of a change whose acceptance it refused, by proposal.
    var refused: [String: [WikiPlanGateError]] = [:]
    var actions = WikiPlanActions()

    private var open: WikiPlanJob? { WikiPlanLogic.openJob(state) }
    private var inForce: Bool { shown?.status == .confirmed && state.confirmed?.version == shown?.version }

    var body: some View {
        List {
            ForEach(WikiPlanLogic.PageSection.allCases, id: \.self) { section in
                self.section(section)
            }
        }
        #if os(iOS)
        .listStyle(.insetGrouped)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .navigationTitle("")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(action: actions.openContents) { Image(systemName: "list.bullet") }
                    .accessibilityLabel(WikiArticleCopy.contents)
            }
        }
    }

    @ViewBuilder
    private func section(_ section: WikiPlanLogic.PageSection) -> some View {
        switch section {
        case .crumb:
            // The bar's back button is the crumb on a phone: Wiki › Plan is where it goes.
            EmptyView()
        case .title:
            HStack(alignment: .center, spacing: 10) {
                Text(WikiPlanCopy.title)
                    .font(.largeTitle.bold())
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 8)
                if let shown { versionMenu(shown) }
            }
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
        case .meta:
            Text(metaLine)
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
        case .actions:
            if let shown {
                HStack(spacing: 10) {
                    if shown.status == .draft || shown.status == .failed {
                        Button { actions.confirm(shown.version) } label: {
                            Text(WikiPlanCopy.confirm).frame(maxWidth: .infinity, minHeight: 30)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(shown.status == .failed || busy)
                    }
                    if shown.status != .superseded {
                        Button(action: actions.redraft) {
                            Label(WikiPlanCopy.redraft, systemImage: "arrow.clockwise")
                                .frame(maxWidth: .infinity, minHeight: 30)
                        }
                        .buttonStyle(.bordered)
                        .disabled(open != nil || busy)
                    }
                }
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            } else if open == nil {
                empty
            }
        case .hint:
            if shown?.status == .failed {
                Text(WikiPlanCopy.failedHint(inForce: state.confirmed?.version))
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
        case .job:
            if let jobCard {
                Section { WikiPlanJobCardView(card: jobCard, actions: actions) }
            }
        case .gate:
            if let shown, shown.status == .draft || shown.status == .failed {
                WikiPlanGateView(gate: WikiPlanLogic.gate(shown, base: base, job: shown.status == .failed ? WikiPlanLogic.failedJob(state) : state.job))
            }
        case .changes:
            let proposals = state.proposals ?? []
            if let shown, shown.status != .superseded, !proposals.isEmpty {
                Section {
                    ForEach(proposals, id: \.id) { proposal in
                        WikiPlanChangeCard(proposal: proposal, change: WikiPlanLogic.change(proposal, base: changesBase),
                                           acceptNote: WikiPlanLogic.acceptNote(state, op: WikiPlanLogic.change(proposal, base: changesBase).op),
                                           refused: refused[proposal.id], busy: busy, actions: actions)
                    }
                } header: {
                    HStack(spacing: 6) {
                        Text(WikiPlanCopy.changes)
                        Text("\(proposals.count)").foregroundStyle(.secondary)
                    }
                }
            }
        case .documents:
            if let shown {
                ForEach(shown.categories) { category in
                    Section {
                        ForEach(category.docs) { doc in docRow(doc, in: shown) }
                    } header: {
                        HStack(spacing: 6) {
                            Text("\(category.number)")
                                .foregroundStyle(.secondary)
                            Text(category.title)
                            Spacer(minLength: 4)
                            Text(WikiPlanLogic.categoryLine(category))
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }

    /// The version in force, which a change was proposed against.
    private var changesBase: WikiPlanLogic.Shown? { state.confirmed.map(WikiPlanLogic.fromVersion) }

    private var metaLine: String {
        if let shown {
            let job = shown.status == .failed ? WikiPlanLogic.failedJob(state) : (open ?? state.job)
            return WikiPlanLogic.meta(shown, job: job, docs: inForce ? written : nil).joined(separator: " · ")
        }
        if let open { return WikiPlanLogic.jobHead(open) }
        return WikiPlanCopy.none
    }

    /// The version beside the title: a menu of every version, the shown one ticked, each with where it came from.
    private func versionMenu(_ shown: WikiPlanLogic.Shown) -> some View {
        Menu {
            ForEach(versions) { row in
                Toggle(isOn: Binding(get: { row.version == shown.version }, set: { if $0 { actions.pickVersion(row.version) } })) {
                    Text("\(WikiPlanCopy.versionLabel(row.version)) · \(row.status.label)")
                    Text(row.note)
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(WikiPlanCopy.versionLabel(shown.version))
                    .font(.orbitLabel.weight(.semibold))
                Text("· \(shown.status.label)")
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.orbitMeta.weight(.semibold))
            }
            .foregroundStyle(Color.primary)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Color.primary.opacity(0.07), in: Capsule())
        }
    }

    /// No plan yet (mock 22 ①): what a plan is, Draft plan, and where and how long it runs.
    private var empty: some View {
        VStack(spacing: 12) {
            Image(systemName: "list.bullet.rectangle")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text(WikiPlanCopy.emptyTitle)
                .font(.title3.bold())
            Text(WikiPlanCopy.emptyText(provider: provider))
                .font(.orbitSubtext)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: actions.draft) {
                Text(WikiPlanCopy.draft).frame(maxWidth: .infinity, minHeight: 34)
            }
            .buttonStyle(.borderedProminent)
            .disabled(busy)
            Text(WikiPlanCopy.emptyNote(where: whereItRuns, provider: provider))
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 20)
        .frame(maxWidth: .infinity)
    }

    /// `1.3  安全模型与密钥信任` over the reader's question and `2 errors · 7 sections · 1,500–2,400 chars`: the
    /// document row the home draws too, with the plan's counts under the question.
    private func docRow(_ doc: WikiPlanLogic.ShownDoc, in shown: WikiPlanLogic.Shown) -> some View {
        let errors = WikiPlanLogic.docErrors(shown, doc: doc).count
        return WikiDocRow(mark: .number(doc.number), title: doc.title, line: doc.question, locked: doc.protected,
                          action: { actions.openDoc(doc.slug) }) {
            ((errors > 0 ? Text(WikiPlanCopy.errorCount(errors)).foregroundColor(.red).bold() + Text(" · ") : Text(""))
                + Text(WikiPlanLogic.docLine(doc)))
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - a document as a row

/// A document as a list row (`WikiDocRow`): its number, its title, a line under it and the chevron into its
/// page — the plan page's row (mock 22 ②), and the home's (design §12.3.1, mocks 30 ③, 31 ① ③).
///
/// ONE ROW, TWO LINES UNDER THE TITLE: the plan's is the question the document answers; the home's is the
/// document's lead (`lead`), a shade darker, since it is what the document says rather than what it is for.
struct WikiDocRow<Extra: View>: View {
    /// What stands in the number column: `3.1`, or a principle's pin. Nil leaves the row no such column (a topic).
    enum Mark: Equatable {
        case number(String)
        case pin
    }

    let mark: Mark?
    let title: String
    /// The line under the title, two lines at most.
    var line: String? = nil
    /// The line is the document's lead.
    var lead = false
    /// A blue dot before the title: new since the reader last looked.
    var fresh = false
    var locked = false
    /// The title in grey: a document not written yet.
    var muted = false
    /// What ends the row in the chevron's place: a principle's day.
    var end: String? = nil
    let action: () -> Void
    /// Under the line: the plan's counts, and the errors its check found.
    let extra: Extra

    /// The number column, as wide as `10.3` (the web's 34 px).
    @ScaledMetric(relativeTo: .subheadline) private var numberWidth: CGFloat = 34

    init(mark: Mark?, title: String, line: String? = nil, lead: Bool = false, fresh: Bool = false, locked: Bool = false,
         muted: Bool = false, end: String? = nil, action: @escaping () -> Void, @ViewBuilder extra: () -> Extra) {
        self.mark = mark
        self.title = title
        self.line = line
        self.lead = lead
        self.fresh = fresh
        self.locked = locked
        self.muted = muted
        self.end = end
        self.action = action
        self.extra = extra()
    }

    var body: some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                switch mark {
                case .number(let number)?:
                    Text(number)
                        .font(.orbitSubtext.monospacedDigit().weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: numberWidth, alignment: .leading)
                case .pin?:
                    Image(systemName: "pin.fill")
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                        .frame(width: numberWidth, alignment: .leading)
                case nil:
                    EmptyView()
                }
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        if fresh {
                            Text("●")
                                .font(.orbitMeta)
                                .foregroundStyle(WikiPalette.color(.blue))
                                .accessibilityHidden(true)
                        }
                        Text(title)
                            .font(.orbitProse)
                            .foregroundStyle(muted ? Color.secondary : Color.primary)
                            .lineLimit(1)
                        if locked {
                            Image(systemName: "lock.fill")
                                .font(.orbitMeta)
                                .foregroundStyle(.secondary)
                        }
                    }
                    if let line, !line.isEmpty {
                        Text(line)
                            .font(.orbitListSubtitle)
                            .foregroundStyle(lead ? Color.primary.opacity(0.75) : Color.secondary)
                            .lineLimit(2)
                    }
                    extra
                }
                // The separator under the row starts at the title, past the number column (mock 30 ③).
                .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
                Spacer(minLength: 4)
                if let end {
                    Text(end)
                        .font(.orbitLabel.monospacedDigit())
                        .foregroundStyle(.secondary)
                } else {
                    Image(systemName: "chevron.forward")
                        .font(.orbitMeta.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

extension WikiDocRow where Extra == EmptyView {
    init(mark: Mark?, title: String, line: String? = nil, lead: Bool = false, fresh: Bool = false, locked: Bool = false,
         muted: Bool = false, end: String? = nil, action: @escaping () -> Void) {
        self.init(mark: mark, title: title, line: line, lead: lead, fresh: fresh, locked: locked, muted: muted, end: end,
                  action: action, extra: { EmptyView() })
    }
}

/// A category's folded row: what of it is not written yet, in grey under the title column, and the chevron that
/// turns down once it is opened to their titles.
struct WikiDocFoldedRow: View {
    let text: String
    let open: Bool
    let action: () -> Void

    /// The number column the titles above it start after.
    @ScaledMetric(relativeTo: .subheadline) private var numberWidth: CGFloat = 34

    init(text: String, open: Bool, action: @escaping () -> Void) {
        self.text = text
        self.open = open
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Color.clear.frame(width: numberWidth, height: 1)
                Text(text)
                    .font(.orbitListSubtitle)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 4)
                Image(systemName: "chevron.forward")
                    .font(.orbitMeta.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(open ? 90 : 0))
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(open ? "Expanded" : "Collapsed")
    }
}


// MARK: - the job

/// The job's card (mock 22 ⑩): grey queued, blue drafting and writing, amber held, red failed.
struct WikiPlanJobCardView: View {
    let card: WikiPlanLogic.JobCard
    var actions = WikiPlanActions()

    private var tone: Color {
        switch card.look {
        case .queued: return .secondary
        case .drafting, .writing: return .blue
        case .held: return .orange
        case .failed: return .red
        }
    }

    private var glyph: String {
        switch card.look {
        case .queued: return "clock"
        case .drafting, .writing: return "arrow.triangle.2.circlepath"
        case .held: return "exclamationmark.triangle"
        case .failed: return "xmark.circle.fill"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: glyph)
                    .foregroundStyle(tone)
                VStack(alignment: .leading, spacing: 3) {
                    Text(card.title)
                        .font(.orbitSubtext.weight(.semibold))
                        .foregroundStyle(tone == .secondary ? Color.primary : tone)
                    Text(card.text)
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let link = card.link {
                        Button(link.label) {
                            switch link.to {
                            case .run: if let session = link.sessionId { actions.openRun(session) }
                            case .settings: actions.openSettings()
                            case .runners: actions.openRunners()
                            }
                        }
                        .font(.orbitSubtext)
                        .buttonStyle(.borderless)
                    }
                }
            }
            if let progress = card.progress {
                ProgressView(value: Double(progress.done), total: Double(max(1, progress.total)))
                    .tint(.blue)
                if let now = progress.now {
                    (Text(WikiPlanCopy.writingNow) + Text(" ") + Text(now).bold())
                        .font(.orbitLabel)
                }
            }
        }
        .padding(.vertical, 4)
        .listRowBackground(tone.opacity(card.look == .queued ? 0.06 : 0.10))
    }
}

// MARK: - the gate's report

/// The gate's report (mock 22 ②): passed in green, or failed in red with its four rows and the references
/// not found, the first few listed where they were named.
struct WikiPlanGateView: View {
    let gate: WikiPlanLogic.Gate

    @State private var allRefs = false

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 3) {
                Label(gate.title, systemImage: gate.passed ? "checkmark.circle" : "xmark.circle.fill")
                    .font(.orbitSubtext.weight(.semibold))
                    .foregroundStyle(gate.passed ? Color.green : Color.red)
                Text(([gate.line] + (gate.aside.map { [$0] } ?? [])).joined(separator: " · "))
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
            }
            .listRowBackground((gate.passed ? Color.green : Color.red).opacity(0.10))
            if !gate.passed {
                ForEach(gate.rows) { row in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: row.ok ? "checkmark.circle" : "xmark.circle.fill")
                                .foregroundStyle(row.ok ? Color.green : Color.red)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(row.title)
                                    .font(.orbitSubtext)
                                Text(row.text)
                                    .font(.orbitLabel)
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        if row.check == .references && !gate.refs.isEmpty { refs }
                    }
                }
            }
        }
    }

    /// The references not found, the first few on a phone, each where it was named, what, and why.
    @ViewBuilder
    private var refs: some View {
        let shown = allRefs ? gate.refs : Array(gate.refs.prefix(WikiPlanCopy.refsShownPhone))
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(shown.enumerated()), id: \.offset) { _, ref in
                (Text(ref.where_).foregroundColor(.accentColor).bold() + Text(" ") + Text(ref.kind).foregroundColor(.secondary)
                    + Text(" ") + Text(ref.ref).font(.system(.caption, design: .monospaced)) + Text(" — \(ref.why)").foregroundColor(.red))
                    .font(.orbitLabel)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if gate.refs.count > shown.count {
                Button(WikiArticleCopy.showMore(gate.refs.count - shown.count)) { allRefs = true }
                    .font(.orbitSubtext)
                    .buttonStyle(.borderless)
            }
        }
        .padding(.leading, 26)
    }
}

// MARK: - a change proposed

/// One change a maintenance run proposed (mock 22 ⑥⑦): Review's card with the plan's parts — why, the change
/// to the document's sections, the new sections' sources, the facts it came from, the gate it passed — and
/// Accept, Edit, Reject, with what Accept will do said under them.
struct WikiPlanChangeCard: View {
    let proposal: WikiPlanProposal
    let change: WikiPlanLogic.Change
    let acceptNote: String
    /// The gate refused the acceptance: its errors, and nothing confirmed.
    var refused: [WikiPlanGateError]?
    var busy = false
    var actions = WikiPlanActions()

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(WikiPlanLogic.ChangePart.allCases, id: \.self) { part in
                self.part(part)
            }
        }
        .padding(.vertical, 6)
    }

    @ViewBuilder
    private func part(_ part: WikiPlanLogic.ChangePart) -> some View {
        switch part {
        case .head:
            HStack(spacing: 6) {
                Text(change.op.label)
                    .font(.system(.caption2, design: .monospaced).weight(.bold))
                    .foregroundStyle(.green)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(Color.green.opacity(0.12), in: RoundedRectangle(cornerRadius: 3))
                Text(change.target)
                    .font(.orbitLabel.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 4)
                if let at = proposal.createdAt, let ago = RelativeTime.ago(at) {
                    Text(ago)
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                }
            }
            (Text(WikiPlanCopy.proposedBy).foregroundColor(.secondary) + Text(" ") + Text(WikiCopy.historyMaintenance).foregroundColor(.accentColor))
                .font(.orbitLabel)
        case .title:
            Text(change.title)
                .font(.orbitProse.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
        case .why:
            field(WikiPlanCopy.why) {
                Text(proposal.reason ?? "")
                    .font(.orbitSubtext)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .change:
            if !change.rows.isEmpty || change.renumber != nil {
                field(WikiPlanCopy.change) {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(change.rows.enumerated()), id: \.offset) { _, row in
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text(row.n)
                                    .font(.orbitLabel.monospacedDigit())
                                    .foregroundStyle(row.mark == .add ? Color.green : row.mark == .remove ? Color.red : Color.secondary)
                                    .frame(minWidth: 24, alignment: .leading)
                                Text(row.title)
                                    .font(.orbitSubtext.weight(row.mark == .same ? .regular : .semibold))
                                    .strikethrough(row.mark == .remove)
                                    .foregroundStyle(row.mark == .same ? Color.secondary : Color.primary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            .padding(8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(row.mark == .add ? Color.green.opacity(0.10) : row.mark == .remove ? Color.red.opacity(0.08) : Color.clear)
                        }
                        if let renumber = change.renumber {
                            Text(renumber)
                                .font(.orbitLabel)
                                .foregroundStyle(.secondary)
                                .padding(8)
                        }
                    }
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.green.opacity(0.35)))
                }
            }
        case .sources:
            let lines = change.added.flatMap { WikiPlanLogic.sourceLines($0.sources) }
            if !lines.isEmpty {
                field(WikiPlanCopy.sources) {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                            Text(line)
                                .font(.orbitSubtext)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        case .from:
            let facts = proposal.facts ?? []
            if !facts.isEmpty {
                field(WikiPlanCopy.from) {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(facts.prefix(WikiPlanCopy.factsShown).enumerated()), id: \.offset) { _, fact in
                            factRow(fact)
                        }
                        if facts.count > WikiPlanCopy.factsShown {
                            Text(WikiPlanCopy.andMore(facts.count - WikiPlanCopy.factsShown))
                                .font(.orbitLabel)
                                .foregroundStyle(Color.accentColor)
                        }
                    }
                }
            }
        case .check:
            field(WikiPlanCopy.check) {
                if let refused {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(WikiPlanCopy.acceptRefused)
                            .font(.orbitLabel.weight(.semibold))
                            .foregroundStyle(.red)
                        ForEach(Array(refused.prefix(8).enumerated()), id: \.offset) { _, error in
                            Text("\(error.path) \(error.message)")
                                .font(.orbitLabel)
                                .foregroundStyle(.red)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                } else {
                    Label(WikiPlanCopy.passed, systemImage: "checkmark.circle")
                        .font(.orbitSubtext.weight(.semibold))
                        .foregroundStyle(.green)
                }
            }
        case .actions:
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Button { actions.accept(proposal, false) } label: {
                        Text(WikiPlanCopy.accept).frame(maxWidth: .infinity, minHeight: 30)
                    }
                    .buttonStyle(.borderedProminent)
                    Button { actions.accept(proposal, true) } label: {
                        Text(WikiPlanCopy.edit).frame(maxWidth: .infinity, minHeight: 30)
                    }
                    .buttonStyle(.bordered)
                    Button { actions.reject(proposal) } label: {
                        Text(WikiPlanCopy.reject).frame(maxWidth: .infinity, minHeight: 30)
                    }
                    .buttonStyle(.bordered)
                }
                .disabled(busy)
                Text(acceptNote)
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func field<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
            content()
        }
    }

    /// A fact the change came from: an entry of the space opens its page; a session or a commit is named.
    @ViewBuilder
    private func factRow(_ fact: WikiPlanProposal.Fact) -> some View {
        switch fact.kind {
        case "entry":
            Button(fact.id) { actions.openEntry(fact.id) }
                .font(.orbitSubtext)
                .buttonStyle(.borderless)
                .lineLimit(1)
        case "session":
            Button(fact.id) { actions.openRun(fact.id) }
                .font(.orbitSubtext)
                .buttonStyle(.borderless)
                .lineLimit(1)
        default:
            Label(WikiLogic.shortSha(fact.id), systemImage: "arrow.triangle.branch")
                .font(.system(.footnote, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - a document of the plan, and a section of it

/// A plan document's own page (mock 22 ③): its number, title and lock; its version, errors and length; its
/// fields — question, readers, what it covers and leaves out, length, protection, what it draws on — and
/// its sections, a protected document's lost ones in red where they were — `WikiPlanLogic.DocSection`'s order.
struct WikiPlanDocPage: View {
    let shown: WikiPlanLogic.Shown
    let doc: WikiPlanLogic.ShownDoc
    let base: WikiPlanLogic.Shown?
    var canEdit = false
    var actions = WikiPlanActions()

    @State private var allCovers = false

    var body: some View {
        List {
            ForEach(WikiPlanLogic.DocSection.allCases, id: \.self) { section in
                self.section(section)
            }
        }
        #if os(iOS)
        .listStyle(.insetGrouped)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .navigationTitle("")
        .toolbar {
            if canEdit {
                ToolbarItem(placement: .primaryAction) {
                    Button(WikiPlanCopy.edit) { actions.editDoc(doc.slug) }
                }
            }
        }
    }

    @ViewBuilder
    private func section(_ section: WikiPlanLogic.DocSection) -> some View {
        switch section {
        case .crumb:
            EmptyView()
        case .title:
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("\(doc.number) \(doc.title)")
                    .font(.title2.bold())
                    .fixedSize(horizontal: false, vertical: true)
                if doc.protected {
                    Image(systemName: "lock.fill")
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                }
            }
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .accessibilityAddTraits(.isHeader)
        case .meta:
            let errors = WikiPlanLogic.docErrors(shown, doc: doc).count
            (Text("\(WikiPlanCopy.versionLabel(shown.version)) · \(shown.status.label) · ")
                + (errors > 0 ? Text(WikiPlanCopy.errorCount(errors)).foregroundColor(.red).bold() + Text(" · ") : Text(""))
                + Text(WikiPlanLogic.docLine(doc)))
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
        case .fields:
            Section {
                field(WikiPlanCopy.question) { Text(doc.question).font(.orbitSubtext.weight(.semibold)) }
                field(WikiPlanCopy.writtenFor) { bullets(doc.audience) }
                field(WikiPlanCopy.covers) {
                    let shownCovers = allCovers ? doc.scopeIn : Array(doc.scopeIn.prefix(4))
                    VStack(alignment: .leading, spacing: 3) {
                        bullets(shownCovers)
                        if doc.scopeIn.count > shownCovers.count {
                            Button(WikiArticleCopy.moreArticles(doc.scopeIn.count - shownCovers.count)) { allCovers = true }
                                .font(.orbitSubtext)
                                .buttonStyle(.borderless)
                        }
                    }
                }
                if !doc.scopeOut.isEmpty {
                    field(WikiPlanCopy.notCovered) {
                        let numbers = Dictionary(shown.docs.map { ($0.slug, $0.number) }, uniquingKeysWith: { first, _ in first })
                        VStack(alignment: .leading, spacing: 3) {
                            ForEach(Array(doc.scopeOut.enumerated()), id: \.offset) { _, out in
                                (Text("• \(out.text)") + Text(out.docs.map { " → \(numbers[$0] ?? $0)" }.joined()).foregroundColor(.accentColor))
                                    .font(.orbitSubtext)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
                field(WikiPlanCopy.length) { Text(WikiPlanCopy.chars(doc.length)).font(.orbitSubtext) }
                field(WikiPlanCopy.protected) {
                    if doc.protected {
                        Label(WikiPlanCopy.protectedNote, systemImage: "lock.fill").font(.orbitSubtext)
                    } else {
                        Text(WikiPlanCopy.notProtectedNote).font(.orbitSubtext).foregroundStyle(.secondary)
                    }
                }
                field(WikiPlanCopy.drawsOn) { Text(WikiPlanLogic.drawsOn(doc)).font(.orbitSubtext) }
            }
        case .sections:
            let lost = WikiPlanLogic.lostSections(shown, base: base, slug: doc.slug)
            Section {
                ForEach(Array(doc.sections.enumerated()), id: \.offset) { index, section in
                    ForEach(lost.filter { $0.number - 1 == index }, id: \.number) { row in lostRow(row) }
                    Button { actions.openSection(doc.slug, index) } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text("\(index + 1)")
                                .font(.orbitSubtext.monospacedDigit())
                                .foregroundStyle(.secondary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(section.title)
                                    .font(.orbitProse)
                                    .foregroundStyle(Color.primary)
                                    .fixedSize(horizontal: false, vertical: true)
                                Text(WikiPlanLogic.sectionLine(section))
                                    .font(.orbitListSubtitle)
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Spacer(minLength: 4)
                            Image(systemName: "chevron.forward")
                                .font(.orbitMeta.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                ForEach(lost.filter { $0.number - 1 >= doc.sections.count }, id: \.number) { row in lostRow(row) }
            } header: {
                HStack(spacing: 6) {
                    Text(WikiPlanCopy.sections)
                    Text("\(doc.sections.count)").foregroundStyle(.secondary)
                }
            }
        }
    }

    /// A section a protected document lost in the draft, in red where it was: `v1 §7 已知的坑`.
    private func lostRow(_ row: (number: Int, title: String, movedTo: String?)) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("− \(WikiPlanCopy.lostLabel(base: base?.version ?? 0, number: row.number, title: row.title))")
                .font(.orbitProse)
                .strikethrough()
                .foregroundStyle(.secondary)
            Text(WikiPlanCopy.protectedMovePhone(movedTo: row.movedTo, number: doc.number))
                .font(.orbitLabel)
                .foregroundStyle(.red)
        }
        .listRowBackground(Color.red.opacity(0.08))
    }

    private func field<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
            content()
        }
        .padding(.vertical, 2)
    }

    private func bullets(_ lines: [String]) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                Text("• \(line)")
                    .font(.orbitSubtext)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// A plan section's own page (mock 22 ④⑤): its title, kind and length, what it covers, and its sources —
/// design docs, code and contracts each found or not at the sha, and where to look in sessions for the
/// words — `WikiPlanLogic.SectionSection`'s order.
struct WikiPlanSectionPage: View {
    let shown: WikiPlanLogic.Shown
    let doc: WikiPlanLogic.ShownDoc
    let index: Int
    var canEdit = false
    var actions = WikiPlanActions()

    private var section: WikiPlanLogic.ShownSection { doc.sections[index] }

    var body: some View {
        List {
            ForEach(WikiPlanLogic.SectionSection.allCases, id: \.self) { part in
                self.part(part)
            }
        }
        #if os(iOS)
        .listStyle(.insetGrouped)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .navigationTitle("")
        .toolbar {
            if canEdit {
                ToolbarItem(placement: .primaryAction) {
                    Button(WikiPlanCopy.edit) { actions.editSection(doc.slug, index) }
                }
            }
        }
    }

    @ViewBuilder
    private func part(_ part: WikiPlanLogic.SectionSection) -> some View {
        switch part {
        case .crumb:
            EmptyView()
        case .title:
            Text("§\(index + 1) \(section.title)")
                .font(.title2.bold())
                .fixedSize(horizontal: false, vertical: true)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .accessibilityAddTraits(.isHeader)
        case .meta:
            Text(WikiPlanLogic.sectionMeta(shown, section: section))
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
        case .covers:
            Section(WikiPlanCopy.covers) {
                Text(section.covers)
                    .font(.orbitSubtext)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .sources:
            let sources = section.sources
            if !sources.docs.isEmpty {
                Section(WikiPlanCopy.sourceDocs) {
                    ForEach(Array(sources.docs.enumerated()), id: \.offset) { k, source in
                        sourceRow(source.path, detail: source.section.map { "§ \($0)" },
                                  found: WikiPlanLogic.sourceFound(shown, doc: doc, section: index, kind: "docs", at: k))
                    }
                }
            }
            if !sources.code.isEmpty {
                Section(WikiPlanCopy.sourceCode) {
                    ForEach(Array(sources.code.enumerated()), id: \.offset) { k, source in
                        sourceRow(source.path, detail: source.symbols.isEmpty ? nil : source.symbols.joined(separator: " · "),
                                  found: WikiPlanLogic.sourceFound(shown, doc: doc, section: index, kind: "code", at: k))
                    }
                }
            }
            if !sources.contracts.isEmpty {
                Section(WikiPlanCopy.sourceContracts) {
                    ForEach(Array(sources.contracts.enumerated()), id: \.offset) { k, path in
                        sourceRow(path, detail: nil, found: WikiPlanLogic.sourceFound(shown, doc: doc, section: index, kind: "contracts", at: k))
                    }
                }
            }
            if let sessions = sources.sessions {
                Section(WikiPlanCopy.sourceSessions) {
                    if !sessions.projects.isEmpty {
                        condition(WikiPlanCopy.sessionProjects) { chips(sessions.projects.map(\.title)) }
                    }
                    condition(WikiPlanCopy.sessionTime) { Text(WikiPlanCopy.time(since: sessions.since, until: sessions.until)) }
                    if !sessions.keywords.isEmpty { condition(WikiPlanCopy.sessionKeywords) { chips(sessions.keywords) } }
                    if !sessions.anchorPaths.isEmpty {
                        condition(WikiPlanCopy.sessionAnchors) {
                            Text(sessions.anchorPaths.joined(separator: "\n")).font(.system(.footnote, design: .monospaced))
                        }
                    }
                    if !sessions.entryKinds.isEmpty { condition(WikiPlanCopy.sessionKinds) { Text(sessions.entryKinds.joined(separator: " · ")) } }
                    if !sessions.topics.isEmpty { condition(WikiPlanCopy.sessionTopics) { Text(sessions.topics.joined(separator: " · ")) } }
                    if !sessions.evidence.isEmpty {
                        condition(WikiPlanCopy.sessionEvidence) { Text(sessions.evidence).fixedSize(horizontal: false, vertical: true) }
                    }
                }
            }
        }
    }

    /// `docs/architecture.md § Realtime and recovery ✓ found`: the path in full, never cut — a path cut short
    /// can't be checked.
    private func sourceRow(_ path: String, detail: String?, found: Bool?) -> some View {
        (Text(path).font(.system(.footnote, design: .monospaced))
            + Text(detail.map { " \($0)" } ?? "").foregroundColor(.secondary)
            + (found.map { Text(" \($0 ? WikiPlanCopy.found : WikiPlanCopy.notFound)").foregroundColor($0 ? .green : .red).bold() } ?? Text("")))
            .font(.orbitSubtext)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func condition<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
            content()
                .font(.orbitSubtext)
        }
        .padding(.vertical, 2)
    }

    private func chips(_ words: [String]) -> some View {
        WikiFlowLayout(spacing: 6) {
            ForEach(Array(words.enumerated()), id: \.offset) { _, word in
                Text(word)
                    .font(.orbitLabel)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Color.secondary.opacity(0.12), in: Capsule())
            }
        }
    }
}

// MARK: - Redraft…

/// Redraft the plan (mock 22 ⑧): what to change, in the owner's words — empty is a fresh draft — and the
/// protected documents a redraft keeps as they are.
struct WikiPlanRedraftSheet: View {
    let note: String
    let protectedDocs: [String]
    /// Sends it; true once the server took it.
    let redraft: (String) async -> Bool

    @Environment(\.dismiss) private var dismiss
    @State private var words = ""
    @State private var sending = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $words)
                        .frame(minHeight: 120)
                        .overlay(alignment: .topLeading) {
                            if words.isEmpty {
                                Text(WikiPlanCopy.redraftPlaceholder)
                                    .foregroundStyle(.tertiary)
                                    .padding(.top, 8)
                                    .padding(.leading, 5)
                                    .allowsHitTesting(false)
                            }
                        }
                } header: {
                    Text(note)
                        .textCase(nil)
                        .fixedSize(horizontal: false, vertical: true)
                } footer: {
                    if !protectedDocs.isEmpty { Text(WikiPlanCopy.protectedKept(protectedDocs)) }
                }
            }
            .navigationTitle(WikiPlanCopy.redraftTitle)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(WikiPlanCopy.cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(WikiPlanCopy.redraftGo) {
                        sending = true
                        Task {
                            let done = await redraft(words)
                            sending = false
                            if done { dismiss() }
                        }
                    }
                    .disabled(sending)
                }
            }
        }
    }
}

// MARK: - Edit

/// Edit one document (mock 22 ⑨): its title, question, length and protection, and its sections — taken
/// out, dragged into a new order, or added. Saving makes a new draft, which goes through the gate again;
/// the sections it kept keep their sources, and the next run finds material for the ones it added.
struct WikiPlanEditSheet: View {
    let number: String
    let stored: WikiPlanDoc
    let nextVersion: Int
    /// Sends the draft's shape; nil once the server took it, else the gate's errors or why not.
    let save: (WikiPlanDocInput) async -> [String]?

    @Environment(\.dismiss) private var dismiss
    @State private var form: WikiPlanLogic.DocForm
    @State private var refused: [String]?
    @State private var saving = false

    init(number: String, stored: WikiPlanDoc, nextVersion: Int, save: @escaping (WikiPlanDocInput) async -> [String]?) {
        self.number = number
        self.stored = stored
        self.nextVersion = nextVersion
        self.save = save
        _form = State(initialValue: WikiPlanLogic.docForm(stored))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent(WikiPlanCopy.editTitleField) {
                        TextField(WikiPlanCopy.editTitleField, text: $form.title)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(WikiPlanCopy.question).font(.orbitLabel).foregroundStyle(.secondary)
                        TextField(WikiPlanCopy.question, text: $form.question, axis: .vertical)
                    }
                    HStack(spacing: 6) {
                        Text(WikiPlanCopy.length)
                        Spacer(minLength: 8)
                        TextField("", value: $form.length.min, format: .number)
                            .frame(maxWidth: 70)
                            .multilineTextAlignment(.trailing)
                        Text("–")
                        TextField("", value: $form.length.max, format: .number)
                            .frame(maxWidth: 70)
                        Text("chars").foregroundStyle(.secondary)
                    }
                    Toggle(isOn: $form.protected) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(WikiPlanCopy.protected)
                            Text(WikiPlanCopy.protectedSwitch).font(.orbitLabel).foregroundStyle(.secondary)
                        }
                    }
                }
                Section {
                    ForEach($form.sections) { $row in
                        HStack(spacing: 8) {
                            if row.key == nil {
                                TextField(WikiPlanCopy.editTitleField, text: $row.title)
                            } else {
                                Text(row.title).lineLimit(1)
                            }
                            Spacer(minLength: 4)
                            Picker(WikiPlanCopy.editKind, selection: $row.kind) {
                                ForEach(WikiPlanSectionKind.allCases.filter { $0 != .unknown }, id: \.self) { kind in
                                    Text(WikiDocCopy.sectionKind(kind)).tag(kind)
                                }
                            }
                            .labelsHidden()
                            .fixedSize()
                        }
                    }
                    .onDelete { form.sections.remove(atOffsets: $0) }
                    .onMove { form.sections.move(fromOffsets: $0, toOffset: $1) }
                    Button {
                        form.sections.append(.init(key: nil, title: "", kind: .other))
                    } label: {
                        Label(WikiPlanCopy.addSection, systemImage: "plus.circle.fill")
                    }
                } header: {
                    Text(WikiPlanCopy.sections)
                } footer: {
                    Text(WikiPlanCopy.saveNote(nextVersion))
                }
                if let refused {
                    Section {
                        ForEach(Array(refused.prefix(8).enumerated()), id: \.offset) { _, line in
                            Text(line).font(.orbitLabel).foregroundStyle(.red)
                        }
                    }
                }
            }
            #if os(iOS)
            .environment(\.editMode, .constant(.active))
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .navigationTitle(WikiPlanCopy.editTitle(number))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(WikiPlanCopy.cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(WikiPlanCopy.saveDraft) {
                        saving = true
                        Task {
                            let answer = await save(WikiPlanLogic.docEdit(stored, form: form))
                            saving = false
                            if let answer { refused = answer } else { dismiss() }
                        }
                    }
                    .disabled(saving)
                }
            }
        }
    }
}

/// One section, edited from its own page: title, kind, what it covers, length.
struct WikiPlanSectionEditSheet: View {
    let index: Int
    let stored: WikiPlanSection
    let nextVersion: Int
    let save: ((title: String, kind: WikiPlanSectionKind, covers: String, length: Int)) async -> [String]?

    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var kind: WikiPlanSectionKind
    @State private var covers: String
    @State private var length: Int
    @State private var refused: [String]?
    @State private var saving = false

    init(index: Int, stored: WikiPlanSection, nextVersion: Int,
         save: @escaping ((title: String, kind: WikiPlanSectionKind, covers: String, length: Int)) async -> [String]?) {
        self.index = index
        self.stored = stored
        self.nextVersion = nextVersion
        self.save = save
        _title = State(initialValue: stored.title)
        _kind = State(initialValue: stored.kind)
        _covers = State(initialValue: stored.covers ?? "")
        _length = State(initialValue: stored.length ?? WikiPlanCopy.newSectionLength)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent(WikiPlanCopy.editTitleField) {
                        TextField(WikiPlanCopy.editTitleField, text: $title)
                    }
                    Picker(WikiPlanCopy.editKind, selection: $kind) {
                        ForEach(WikiPlanSectionKind.allCases.filter { $0 != .unknown }, id: \.self) { kind in
                            Text(WikiDocCopy.sectionKind(kind)).tag(kind)
                        }
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(WikiPlanCopy.covers).font(.orbitLabel).foregroundStyle(.secondary)
                        TextField(WikiPlanCopy.covers, text: $covers, axis: .vertical)
                    }
                    LabeledContent(WikiPlanCopy.length) {
                        TextField("", value: $length, format: .number)
                            .multilineTextAlignment(.trailing)
                    }
                } footer: {
                    Text(WikiPlanCopy.saveNote(nextVersion))
                }
                if let refused {
                    Section {
                        ForEach(Array(refused.prefix(8).enumerated()), id: \.offset) { _, line in
                            Text(line).font(.orbitLabel).foregroundStyle(.red)
                        }
                    }
                }
            }
            .navigationTitle(WikiPlanCopy.editTitle("§\(index + 1)"))
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(WikiPlanCopy.cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(WikiPlanCopy.saveDraft) {
                        saving = true
                        Task {
                            let answer = await save((title, kind, covers, length))
                            saving = false
                            if let answer { refused = answer } else { dismiss() }
                        }
                    }
                    .disabled(saving)
                }
            }
        }
    }
}
