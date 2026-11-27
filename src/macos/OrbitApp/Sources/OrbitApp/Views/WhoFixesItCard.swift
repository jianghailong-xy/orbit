import SwiftUI
import OrbitKit

/// The owner exception card's body, organised around "Who fixes it?" (board
/// docs/mocks/owner-exception-who-fixes, D1–D4 = A; the browser's `WhoFixesItCard`).
///
/// Drawn by `OwnerItemCardView` for an item `ExceptionCards.whoFixesIt` holds for — an exception
/// that became the owner's by escalation, a hand-over, or an ended or missing coordinator — under
/// the card's header and the one clock beside it. The heading is the live cause, a subline says what
/// it is, then WHO FIXES IT? — the coordinator (why it can or cannot, and the one press that brings
/// it back or hands this to it) and you (the task session) — then how it ends, the facts folded into
/// Details, and after a divider the owner's own ending. Every word and rule is `ExceptionCards`.
///
/// The presses that are the card's own — Ask again, the server's other doors, Mark as handled — are
/// the host card's, handed in: one card, one in-flight flag, one receipt. What this view adds is the
/// coordinator's repair, which is the project page's on this client (Change workspace…, Start a new
/// coordinator) reached from here without leaving the card (D1 = A): once the coordinator is back
/// the server reads the item askable, and the card turns into the reachable one in place.
struct WhoFixesItBody: View {
    let console: ConsoleModel
    let row: ProjectOpenItemRow
    /// The host card's in-flight flag.
    let sending: Bool
    /// Ask the coordinator again — the host card's press.
    let askAgain: () -> Void
    /// "or Chat about this first" — the item into the composer.
    let chat: () -> Void
    /// Mark as handled — the host card's field, asked in place.
    let markHandled: () -> Void
    /// What one of the server's other doors does from here (the host card's `makePress`), or nil
    /// for a door this client cannot make — which is then not drawn.
    let makePress: (ExceptionCards.CardPress) -> (() -> Void)?

    @Environment(AppModel.self) private var model
    @Environment(\.opensPagesOverConsole) private var overConsole
    @Environment(\.openURL) private var openURL

    /// The coordinator status, read only while the item is not askable — an askable item's cause
    /// is the row's own (`ExceptionCards.readCoordinatorCause`).
    @State private var status: ProjectCoordinatorStatus?
    /// The coordinator workspace's two facts a LIVE status does not carry.
    @State private var workspace: CoordinatorWorkspaceFacts?
    @State private var detailsOpen = false
    /// The whole check output's sheet (D2 = A), on a phone.
    @State private var outputOpen = false
    @Environment(\.dynamicTypeSize) private var typeSize
    /// A repair on its way: a new coordinator being started.
    @State private var repairing = false
    /// Change workspace…'s sheet, the row it handed back, and a move under way.
    @State private var changing = false
    @State private var changingTo: WhoFixesChangePick?
    @State private var changeMoving = false
    /// The hand-over note's flip: "Translated · Show original" ↔ "Original · Show translation".
    @State private var showOriginal = false

    private var askable: Bool { ExceptionCards.askable(row) }

    private var reading: CoordinatorReading {
        ExceptionCards.readCoordinatorCause(row, status: askable ? nil : status,
                                            workspace: askable ? nil : workspace)
    }

    private var projectName: String? {
        console.projectTitle.isEmpty ? nil : console.projectTitle
    }

    private var drawn: [ProjectOpenItemAction] {
        ExceptionCards.drawn(row, mergeCard: console.mergeCardPromotionID)
    }

    private var taskSessionURL: URL? {
        drawn.contains(.openTaskSession) ? ExceptionCards.openTaskSessionLink(row) : nil
    }

    private var landingURL: URL? {
        drawn.contains(.openLanding) ? ExceptionCards.landingLink(row) : nil
    }

    /// The server's other doors onto the work, each only where this client can make it.
    private var youDoors: [WhoFixesYouDoor] {
        ExceptionCards.youDoors(row, mergeCard: console.mergeCardPromotionID).compactMap { press in
            makePress(press).map { WhoFixesYouDoor(press: press, make: $0) }
        }
    }

    /// Re-read whenever the server's own reading of the item moves.
    private var readKey: String {
        "\(row.itemId)|\(askable)|\(row.coordinatorUnreachable)|\(row.assigneeReason.rawValue)"
    }

    var body: some View {
        let reading = self.reading
        VStack(alignment: .leading, spacing: ApprovalMetrics.spacing) {
            Text(ExceptionCards.whoFixesHeading(reading.cause))
                .font(.orbitProse.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            #if os(iOS)
            // One line, cut at its tail; the whole title leads Details (board owner-card-ios-text,
            // rule 4).
            Text(ExceptionCards.phoneSubline(row, projectName: projectName))
                .font(.orbitLabel).foregroundStyle(.secondary)
                .lineLimit(ExceptionCards.phoneSublineLines)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            #else
            Text(ExceptionCards.whoFixesSubline(row, projectName: projectName))
                .font(.orbitLabel).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            #endif
            if let fixing = ExceptionCards.handledByLine(row) {
                Text(fixing)
                    .font(.orbitLabel)
                    .foregroundStyle(.tint)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            whoBlock(reading)
            if ExceptionCards.closesByItself(row) {
                Text("✓ \(ExceptionCards.closesByItselfLine)")
                    .font(.orbitLabel)
                    .foregroundStyle(Color.green)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.green.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            }
            let handling = ExceptionCards.handlingRows(
                row, main: console.projectDone?.main ?? RunSettings.defaultMainBranch)
            if !handling.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(handling, id: \.label) { fact in factRow(fact) }
                }
            }
            #if os(iOS)
            phoneDetails
            #else
            details
            #endif
            if ExceptionCards.markable(row) {
                Divider()
                #if os(iOS)
                // "Already settled? Mark as handled" — the question and its link-blue door on one
                // line where they fit (board owner-card-ios-text, rule 3).
                VStack(alignment: .leading, spacing: 3) {
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .firstTextBaseline, spacing: 4) { settledLine }
                        VStack(alignment: .leading, spacing: 3) { settledLine }
                    }
                    Text(ExceptionCards.markHandledSettledConsequence)
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                #else
                VStack(alignment: .leading, spacing: 6) {
                    Text(ExceptionCards.alreadySettled)
                        .font(.orbitLabel).foregroundStyle(.secondary)
                    doorRow(ExceptionCards.markHandledSettledConsequence) {
                        Button(action: markHandled) {
                            Text(ExceptionCards.markHandled)
                        }
                        .buttonStyle(.plain)
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                        .disabled(sending)
                    }
                }
                #endif
            }
        }
        .task(id: readKey) {
            guard !askable else { return }
            await readStatus()
        }
        .sheet(isPresented: $changing) {
            CoordinatorChangeSheet(projectTitle: console.projectTitle,
                                   sessionID: CoordinatorChangeLogic.conversationID(status),
                                   currentWorkspaceID: status?.coordination.workspaceId,
                                   currentWorkspaceName: status?.coordination.workspaceName) { row, targets in
                changing = false
                // The question goes up once the sheet is down: one panel at a time.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                    changingTo = WhoFixesChangePick(row: row, targets: targets)
                }
            }
        }
        // Change workspace's one question, as the project page asks it (04-change).
        .orbitConfirmation({ CoordinatorChangeCopy.title(project: console.projectTitle, to: $0.row.name) },
                           isPresented: Binding(get: { changingTo != nil }, set: { if !$0 { changingTo = nil } }),
                           presenting: changingTo) { pick in
            if pick.row.way == .move, let targets = pick.targets {
                Button(CoordinatorChangeCopy.move) { moveConversation(to: pick.row, targets: targets) }
                    .keyboardShortcut(.defaultAction)
                Button(CoordinatorChangeCopy.startThere) { startNewCoordinator(inWorkspace: pick.row.workspaceId) }
                Button(CoordinatorChangeCopy.cancel, role: .cancel) {}
            } else {
                let outgoing = OutgoingCoordinator(status)
                Button(CoordinatorChangeCopy.newAction(pick.row.name, outgoing: outgoing),
                       role: outgoing == .open ? .destructive : nil) {
                    startNewCoordinator(inWorkspace: pick.row.workspaceId)
                }
                Button(CoordinatorChangeCopy.cancel, role: .cancel) {}
            }
        } message: { pick in
            Text(changeParagraphs(pick).joined(separator: "\n\n"))
        }
    }

    // MARK: WHO FIXES IT?

    @ViewBuilder private func whoBlock(_ reading: CoordinatorReading) -> some View {
        let hasYou = taskSessionURL != nil || !youDoors.isEmpty
        VStack(alignment: .leading, spacing: 10) {
            Text(ExceptionCards.whoFixesItLabel.uppercased())
                .font(.orbitMeta.weight(.semibold))
                .foregroundStyle(Color.orange)
            // D4 = A: a hand-over leads with the owner's own row.
            if ExceptionCards.youLead(reading) && hasYou {
                youRow(reading)
                Divider()
                coordinatorRow(reading)
            } else {
                coordinatorRow(reading)
                if hasYou {
                    Divider()
                    youRow(reading)
                }
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
        .overlay {
            RoundedRectangle(cornerRadius: 8).strokeBorder(Color.orange.opacity(0.22))
        }
    }

    /// One "who" row: on a phone the name over its body, the presses above their consequence; on a
    /// Mac "who | status + presses" in two columns, as the browser draws it.
    @ViewBuilder private func whoRow<Content: View>(_ name: String,
                                                    @ViewBuilder _ content: () -> Content) -> some View {
        #if os(iOS)
        VStack(alignment: .leading, spacing: 6) {
            Text(name).font(.orbitLabel.weight(.semibold))
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        #else
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(name)
                .font(.orbitLabel.weight(.semibold))
                .frame(width: 110, alignment: .leading)
            VStack(alignment: .leading, spacing: 6) { content() }
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        #endif
    }

    /// Presses side by side where they fit, one under another where they do not.
    @ViewBuilder private func pressLine<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .center, spacing: 10) { content() }
            VStack(alignment: .leading, spacing: 6) { content() }
        }
    }

    @ViewBuilder private func coordinatorRow(_ reading: CoordinatorReading) -> some View {
        let presses = ExceptionCards.coordinatorRowPresses(reading)
        whoRow(ExceptionCards.whoFixesCoordinator) {
            sentence(reading)
                .font(.orbitLabel)
                #if os(iOS)
                // A row's status sentence: 13pt, two lines at most (board owner-card-ios-text, rule 5).
                .lineLimit(ExceptionCards.phoneStatusLines)
                #endif
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if reading.cause == .handedOver {
                handoverNote
            }
            pressLine {
                ForEach(Array(presses.enumerated()), id: \.offset) { _, press in
                    coordinatorPress(press, reading: reading)
                }
            }
            if changeMoving {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(SessionMoveCopy.moving).font(.orbitLabel).foregroundStyle(.secondary)
                }
            }
            if let note = ExceptionCards.coordinatorRowNote(row, reading,
                                                             escalationSeconds: console.projectEscalationSeconds) {
                Text(note)
                    .font(captionFont).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    /// The coordinator's hand-over note under its caption, drawn translated with its own flip while a
    /// usable translation exists; nothing when the item carries no note.
    @ViewBuilder private var handoverNote: some View {
        let owner = OwnerCardTranslations.ownerLanguage(model.user)
        if let note = row.shownHandoverNote(owner: owner, showOriginal: showOriginal) {
            VStack(alignment: .leading, spacing: 2) {
                Text(ExceptionCards.handoverNoteCaption)
                    .font(captionFont.weight(.semibold)).foregroundStyle(.secondary)
                Text(note)
                    .font(.orbitLabel)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                TranslationFootView(parts: row.handoverNoteFoot(owner: owner, showOriginal: showOriginal)) { _ in
                    showOriginal.toggle()
                }
                .font(captionFont)
            }
            .accessibilityElement(children: .contain)
        }
    }

    /// The status sentence, with the workspace's name in bold.
    private func sentence(_ reading: CoordinatorReading) -> Text {
        let said = ExceptionCards.coordinatorRowSentence(row, reading)
        guard let parts = ExceptionCards.boldWorkspace(said, name: reading.workspaceName) else {
            return Text(said)
        }
        return Text(parts.before) + Text(parts.name).bold() + Text(parts.after)
    }

    @ViewBuilder private func coordinatorPress(_ press: CoordinatorRowPress,
                                               reading: CoordinatorReading) -> some View {
        switch press {
        case .askAgain:
            weighted(press.tier) {
                Button(action: askAgain) { Text(press.label) }
            }
            .disabled(sending)
        case .chatFirst:
            // D2 = A: only where a message can go — an unreachable card draws no chat at all.
            if row.chat?.refusal == nil {
                weighted(.link) {
                    Button {
                        PlatformHaptics.tap()
                        chat()
                    } label: { Text(press.label) }
                }
                .disabled(sending)
            }
        case .fix:
            // Where the workspace is configured, as the browser's repair goes to the workspace's
            // own page: the workspace itself.
            if let workspaceID = reading.workspaceId {
                weighted(press.tier) {
                    Button {
                        PlatformHaptics.tap()
                        model.openAgent(workspaceID)
                    } label: { Text(press.label) }
                }
            }
        case .changeWorkspace:
            // The project page's picker, which reads the status it was opened against.
            if status != nil {
                weighted(press.tier) {
                    Button {
                        PlatformHaptics.tap()
                        changing = true
                    } label: { Text(press.label) }
                }
                .disabled(repairing || changeMoving)
            }
        case .startNewCoordinator:
            weighted(press.tier) {
                Button { startNewCoordinator(inWorkspace: nil) } label: { Text(press.label) }
            }
            .disabled(repairing || changeMoving)
        case .setUpCoordinator:
            if let projectID = console.projectID {
                weighted(press.tier) {
                    Button {
                        PlatformHaptics.tap()
                        model.openProjectFromConversation(projectID, overConsole: overConsole)
                    } label: { Text(press.label) }
                }
            }
        }
    }

    @ViewBuilder private func youRow(_ reading: CoordinatorReading) -> some View {
        let doors = youDoors
        whoRow(ExceptionCards.whoFixesYou) {
            pressLine {
                if let url = taskSessionURL {
                    weighted(ExceptionCards.fixItMyselfLeads(reading) ? .primary : .secondary) {
                        Button {
                            PlatformHaptics.tap()
                            openURL(url)
                        } label: { Text(ExceptionCards.fixItMyself) }
                    }
                }
                ForEach(doors) { door in
                    weighted(door.press.tier, tint: door.press.action == .abandon ? .red : nil) {
                        Button(action: door.make) { Text(door.press.label) }
                    }
                    .disabled(sending)
                }
            }
            if taskSessionURL != nil {
                Text(ExceptionCards.fixItMyselfConsequence(row))
                    .font(captionFont).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            ForEach(doors) { door in
                Text(door.press.consequence)
                    .font(captionFont).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    /// primary = borderedProminent, secondary = bordered, the rest plain.
    @ViewBuilder private func weighted<V: View>(_ tier: ExceptionCards.PressTier,
                                                tint: Color? = nil,
                                                @ViewBuilder _ button: () -> V) -> some View {
        switch tier {
        case .primary:
            button().buttonStyle(.borderedProminent).tint(tint ?? .accentColor)
        case .secondary:
            button().buttonStyle(.bordered)
        case .link:
            button().buttonStyle(.plain).font(.orbitLabel).foregroundStyle(.tint)
        }
    }

    /// One door and its line: under it on a phone, beside it on a Mac (the host card's `doorRow`).
    @ViewBuilder private func doorRow<Content: View>(_ consequence: String,
                                                     @ViewBuilder _ button: () -> Content) -> some View {
        #if os(iOS)
        VStack(alignment: .leading, spacing: 3) {
            button()
            // Captions are 12pt on a phone (board owner-card-ios-text, rule 3).
            Text(consequence)
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        #else
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            button()
                .layoutPriority(1)
            Text(consequence)
                .font(.orbitLabel).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        #endif
    }

    /// A press's line of consequence: 12pt on a phone (board owner-card-ios-text, rule 3).
    private var captionFont: Font {
        #if os(iOS)
        return .caption
        #else
        return .orbitLabel
        #endif
    }

    // MARK: Details

    /// Folded (board ② 4): "Details · 9 files · Open landing" until opened, then the facts, how long
    /// the coordinator had it, and the landing.
    private var details: some View {
        let landing = landingURL
        return DisclosureGroup(isExpanded: $detailsOpen) {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(ExceptionCards.detailRows(row, projectName: projectName), id: \.label) { fact in
                    factRow(fact)
                }
                if let landing {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(ExceptionCards.landingFactLabel)
                            .font(.orbitLabel).foregroundStyle(.secondary)
                            .frame(width: 90, alignment: .leading)
                        Button {
                            PlatformHaptics.tap()
                            openURL(landing)
                        } label: { Text(ExceptionCards.openLanding) }
                        .buttonStyle(.plain).font(.orbitLabel).foregroundStyle(.tint)
                        Text("— \(ExceptionCards.openLandingDetail)")
                            .font(.orbitLabel)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .padding(.top, 4)
        } label: {
            Text(detailsOpen ? ExceptionCards.detailsLabel
                             : ExceptionCards.detailsSummary(row, landing: landing != nil))
                .font(.orbitLabel).foregroundStyle(.secondary)
        }
    }

    /// One fact row, in the faces the model gave each run of its value.
    private func factRow(_ fact: ExceptionCards.FactRow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if !fact.label.isEmpty {
                    Text(fact.label)
                        .font(.orbitLabel).foregroundStyle(.secondary)
                        .frame(width: 90, alignment: .leading)
                }
                fact.runs.map { run -> Text in
                    switch run.face {
                    case .plain: return Text(run.text).font(.orbitLabel)
                    case .mono: return Text(run.text).font(.orbitMono)
                    case .bad: return Text(run.text).font(.orbitLabel).foregroundColor(.red)
                    }
                }.reduce(Text("")) { $0 + $1 }
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
            if let tail = fact.logTail {
                Text(tail.shown.joined(separator: "\n"))
                    .font(.orbitMono)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 8).padding(.vertical, 6)
                    .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
            }
        }
    }

    #if os(iOS)
    // MARK: Details on a phone (board owner-card-ios-text ③, D2 = A)

    /// "Already settled?" and its link-blue Mark as handled.
    @ViewBuilder private var settledLine: some View {
        Text(ExceptionCards.alreadySettled)
            .font(.orbitLabel).foregroundStyle(.secondary)
        Button(action: markHandled) { Text(ExceptionCards.markHandled) }
            .buttonStyle(.plain)
            .font(.orbitLabel)
            .foregroundStyle(.tint)
            .disabled(sending)
    }

    /// Folded: "Details · check failed · 1 failing test". Open: the whole task title, the facts,
    /// the check's command on one line with Copy command, how it failed, the failing lines (at
    /// most three) in a small mono box, then "Full output (N lines)" and Open landing.
    private var phoneDetails: some View {
        let landing = landingURL
        let check = row.facts?.check
        let failing = ExceptionCards.failingLines(check?.outputTail)
        return DisclosureGroup(isExpanded: $detailsOpen) {
            VStack(alignment: .leading, spacing: 5) {
                ForEach(ExceptionCards.phoneDetailRows(row, projectName: projectName), id: \.label) { fact in
                    if fact.label == ExceptionCards.checkLabel, let copy = ExceptionCards.commandCopyValue(row) {
                        phoneFact(fact.label) { commandLine(copy) }
                    } else {
                        phoneFact(fact.label) { factValue(fact) }
                    }
                }
                if let failing, !failing.shown.isEmpty {
                    failingBox(failing.shown)
                }
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 4) { outputLinks(failing, landing: landing, dot: true) }
                    VStack(alignment: .leading, spacing: 4) { outputLinks(failing, landing: landing, dot: false) }
                }
            }
            .padding(.top, 4)
        } label: {
            Text(detailsOpen ? ExceptionCards.detailsLabel : ExceptionCards.phoneDetailsSummary(row))
                .font(.orbitLabel)
                .lineLimit(1)
        }
        .sheet(isPresented: $outputOpen) {
            CheckOutputSheet(lines: failing?.all ?? [])
        }
    }

    /// One fact: its label in a narrow column, or above its value at the accessibility sizes,
    /// where a column would leave the value a sliver.
    @ViewBuilder private func phoneFact<Value: View>(_ label: String,
                                                     @ViewBuilder _ value: () -> Value) -> some View {
        if typeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 2) {
                if !label.isEmpty { Text(label).font(.orbitLabel).foregroundStyle(.secondary) }
                value()
            }
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if !label.isEmpty {
                    Text(label)
                        .font(.orbitLabel).foregroundStyle(.secondary)
                        .frame(width: 84, alignment: .leading)
                }
                value()
            }
        }
    }

    private func factValue(_ fact: ExceptionCards.FactRow) -> some View {
        fact.runs.map { run -> Text in
            switch run.face {
            case .plain: return Text(run.text).font(.orbitLabel)
            case .mono: return Text(run.text).font(.orbitMono)
            case .bad: return Text(run.text).font(.orbitLabel).foregroundColor(.red)
            }
        }.reduce(Text("")) { $0 + $1 }
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
    }

    /// The command on one line, cut at its tail, and Copy command — which copies all of it.
    private func commandLine(_ command: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(command)
                .font(.orbitDiffLine)
                .lineLimit(1)
                .truncationMode(.tail)
                .padding(.horizontal, 6).padding(.vertical, 3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
            Button {
                PlatformHaptics.tap()
                PlatformPasteboard.copyString(command)
            } label: { Text(ExceptionCards.copyCommand) }
            .buttonStyle(.plain)
            .font(.caption)
            .foregroundStyle(.tint)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The failing lines in a small mono box, each ✖ in red.
    private func failingBox(_ lines: [String]) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                failingLine(line)
                    .font(.orbitDiffLine)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .textSelection(.enabled)
        .padding(.horizontal, 8).padding(.vertical, 6)
        .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 8))
        .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(Color.orange.opacity(0.25)) }
    }

    private func failingLine(_ line: String) -> Text {
        guard line.hasPrefix("✖") else { return Text(line) }
        return Text("✖").foregroundColor(.red) + Text(line.dropFirst())
    }

    /// "Full output (N lines) · Open landing".
    @ViewBuilder private func outputLinks(_ failing: ExceptionCards.FailingLines?, landing: URL?,
                                          dot: Bool) -> some View {
        if let failing {
            Button {
                PlatformHaptics.tap()
                outputOpen = true
            } label: { Text(ExceptionCards.fullOutputLabel(failing.total)) }
            .buttonStyle(.plain).font(.caption).foregroundStyle(.tint)
        }
        if failing != nil && landing != nil && dot {
            Text("·").font(.caption).foregroundStyle(.secondary)
        }
        if let landing {
            Button {
                PlatformHaptics.tap()
                openURL(landing)
            } label: { Text(ExceptionCards.openLanding) }
            .buttonStyle(.plain).font(.caption).foregroundStyle(.tint)
        }
    }
    #endif

    // MARK: the repairs (D1 = A: each repairs the coordinator and nothing else)

    private func readStatus() async {
        let read = await console.readCoordinatorStatus()
        status = read
        if let read, read.state == .live, let workspaceID = read.coordination.workspaceId {
            workspace = await console.readCoordinatorWorkspace(workspaceID)
        } else {
            workspace = nil
        }
    }

    /// Start a new coordinator — the project page's replace — and stay on the card: the item list
    /// and the status are read again, and the card says what the coordinator is now.
    private func startNewCoordinator(inWorkspace workspaceID: String?) {
        guard !repairing else { return }
        PlatformHaptics.tap()
        repairing = true
        Task {
            _ = await console.replaceProjectCoordinator(inWorkspace: workspaceID)
            await readStatus()
            repairing = false
        }
    }

    /// Move conversation, as the project page moves it: into the picked workspace's No Folder.
    private func moveConversation(to pick: CoordinatorChangeRow, targets: SessionMoveTargets) {
        guard let sessionID = CoordinatorChangeLogic.conversationID(status),
              let target = targets.targets.first(where: { $0.workspaceId == pick.workspaceId }) else { return }
        changeMoving = true
        Task {
            let refused = await model.moveSession(sessionID, to: target, folder: nil)
            changeMoving = false
            if let refused { console.statusMessage = refused }
            await console.refreshRulerQuestions(force: true)
            await readStatus()
        }
    }

    /// The confirmation's words for a pick, as the project page says them.
    private func changeParagraphs(_ pick: WhoFixesChangePick) -> [String] {
        let from = status?.coordination.workspaceName
        if pick.row.way == .move, let targets = pick.targets {
            return CoordinatorChangeCopy.moveParagraphs(
                to: pick.row.name, from: from ?? "",
                files: SessionMoveCopy.filesSentence(targets, from: from ?? ""))
        }
        return CoordinatorChangeCopy.newParagraphs(to: pick.row.name, from: from,
                                                   outgoing: OutgoingCoordinator(status),
                                                   reason: pick.row.reason)
    }
}

/// The workspace Change workspace… handed back, and the targets it was read from.
private struct WhoFixesChangePick {
    let row: CoordinatorChangeRow
    let targets: SessionMoveTargets?
}

/// One of the server's other doors in the You row, with what pressing it does from here.
private struct WhoFixesYouDoor: Identifiable {
    let press: ExceptionCards.CardPress
    let make: () -> Void
    var id: ProjectOpenItemAction { press.action }
}

#if os(iOS)
/// The failed check's whole output (D2 = A: "Full output (N lines)"), in its own sheet: every line,
/// selectable, scrolled sideways rather than wrapped, so a log reads as the terminal printed it.
private struct CheckOutputSheet: View {
    let lines: [String]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView([.vertical, .horizontal]) {
                Text(lines.joined(separator: "\n"))
                    .font(.orbitDiffLine)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
            .navigationTitle(ExceptionCards.outputSheetTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(ExceptionCards.doneWord) { dismiss() }
                }
            }
        }
    }
}
#endif
