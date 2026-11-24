import SwiftUI
import OrbitKit

// What a session asked the owner to do, drawn in the conversation that asked: pending it is the
// whole request, ended it is one line saying how, who and when. Every word comes from OrbitKit's
// `OwnerRequests`; web parity: `components/OwnerRequestCard.tsx`.

private extension Color {
    static let ownerRequestAccent = Color.orange
}

/// One request wherever it is drawn: whole, folded for later, or as its summary.
struct OwnerRequestView: View {
    @Environment(AppModel.self) private var appModel
    let requestID: String
    /// Hands a talk about the request to the conversation's composer.
    var onChat: ((OwnerRequest) -> Void)? = nil

    var body: some View {
        if let model = appModel.ownerRequests, let request = model.request(requestID) {
            OwnerRequestContent(model: model, request: request, onChat: onChat)
        }
    }
}

/// The same, given the model and the request: what a probe draws directly.
struct OwnerRequestContent: View {
    let model: OwnerRequestsModel
    let request: OwnerRequest
    var onChat: ((OwnerRequest) -> Void)? = nil

    var body: some View {
        if request.kind == .projectReopen, [.pending, .done, .declined].contains(request.state) {
            ProjectReopenCardView(model: model, request: request, onChat: onChat)
        } else if request.kind == .settingsChange, [.pending, .done, .declined].contains(request.state) {
            SettingsChangeCardView(model: model, request: request)
        } else if request.state != .pending {
            OwnerRequestResolvedLine(model: model, request: request)
        } else if let until = model.snoozedUntil(request.id) {
            OwnerRequestSnoozedLine(model: model, request: request, until: until)
        } else {
            OwnerRequestCard(model: model, request: request, onChat: onChat)
        }
    }
}

/// A pending request, whole: panel 1 of the owner-action board.
struct OwnerRequestCard: View {
    @Environment(AppModel.self) private var appModel
    let model: OwnerRequestsModel
    /// The request as it was filed; `request` below is what the card draws.
    let source: OwnerRequest
    /// Settings › Translation: the whole card flips back to the asking session's words.
    @State private var showOriginal = false
    private var owner: TranslationLanguage? { OwnerCardTranslations.ownerLanguage(appModel.user) }
    /// The request as drawn: title, why, ifUnanswered, options, steps and verifyHint in the owner's
    /// language where they were translated. Same id, kind and option order, so every press is the same.
    private var request: OwnerRequest { source.shown(owner: owner, showOriginal: showOriginal) }
    /// The answer the server refused with 422 TRANSLATION_FAILED, to send again — as typed when
    /// `true` (Send as written). Nil while nothing was refused.
    @State private var resend: ((Bool) -> Void)?
    var onChat: ((OwnerRequest) -> Void)? = nil

    private enum Field: Hashable { case secret, answer, reason }

    /// The key being typed lives here and nowhere else: not in the model, not on disk, not in a URL.
    /// SwiftUI drops it with the card, and a press empties it before the request goes out.
    @State private var draft: OwnerRequests.SecretDraft
    @State private var chosen: Int?
    @State private var text = ""
    /// CHANGE: the Max Concurrent the stepper holds, prefilled with the requested value.
    @State private var maxValue: Int
    @State private var declining = false
    @State private var reason = ""
    @State private var busy = false
    @State private var failure: String?
    /// WIKI_CREATE's Change settings…: the Create wiki form on the asking session's workspace.
    @State private var changingSettings = false
    @FocusState private var field: Field?
    /// Closes the review sheet this card may be drawn in, so the composer it arms is in view.
    @Environment(\.dismissApprovalReview) private var dismissReview
    @Environment(\.openURL) private var openURL

    init(model: OwnerRequestsModel, request: OwnerRequest, onChat: ((OwnerRequest) -> Void)? = nil) {
        self.model = model
        self.source = request
        self.onChat = onChat
        _draft = State(initialValue: OwnerRequests.SecretDraft(spec: request.secretSpec))
        _chosen = State(initialValue: request.recommendedOption)
        _maxValue = State(initialValue: max(1, request.changeSpec?.requested ?? 1))
    }

    private var runner: String { request.secretSpec.map { model.runnerName($0.runnerId) } ?? "this runner" }
    private var changeRunner: String {
        request.changeSpec.map { model.runnerName($0.runnerId) } ?? "this runner"
    }
    private var grant: OwnerRequestSecretGrant? { request.kind == .secret ? request.secretGrant : nil }
    private var closed: Bool { OwnerRequests.pastDeadline(request) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().overlay(Color.ownerRequestAccent.opacity(0.35))
            VStack(alignment: .leading, spacing: 12) {
                if request.kind == .browserSignIn {
                    Text(BrowserSignInCopy.eyebrow).font(.orbitLabel.weight(.semibold)).foregroundStyle(.secondary)
                }
                titleRow
                if !request.why.isEmpty {
                    Text(Self.markdown(request.kind == .browserSignIn ? "“\(request.why)”" : request.why))
                        .font(.orbitProse)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                TranslationFootView(parts: source.translationFoot(owner: owner, showOriginal: showOriginal)) { _ in
                    showOriginal.toggle()
                }
                facts
                kindContent
                if let hint = request.verifyHint {
                    Text(OwnerRequests.verifyHint(hint)).font(.orbitLabel).foregroundStyle(.secondary)
                }
                if let failure {
                    Label { Text("\(OwnerRequests.notRecorded): \(failure)") } icon: {
                        Image(systemName: "exclamationmark.triangle.fill")
                    }
                    .font(.orbitLabel).foregroundStyle(.red)
                }
                if let resend {
                    TranslationFootView(parts: OwnerCardTranslations.refusedFoot) { action in
                        resend(action == .sendAsWritten)
                    }
                }
                if declining { declineForm } else { actions }
                if let unanswered = request.ifUnanswered {
                    Text("\(Text(OwnerRequests.ifNobodyAnswers).bold()) \(unanswered)")
                        .font(.orbitLabel).foregroundStyle(.secondary)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                }
            }
            .padding(16)
        }
        .background(Color.ownerRequestAccent.opacity(0.03), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.ownerRequestAccent.opacity(0.45)))
        .accessibilityIdentifier("owner-request-\(request.id)")
        .task(id: request.id) {
            if request.kind == .secret { await model.loadSavedSecrets() }
            await model.loadTaskTitles(request.blocksTaskIds)
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Circle().fill(Color.ownerRequestAccent).frame(width: 8, height: 8)
            Text(OwnerRequests.waitingOnYou).font(.orbitLabel.weight(.semibold))
                .foregroundStyle(Color.ownerRequestAccent)
            Spacer(minLength: 8)
            Text(OwnerRequests.askedLine(request)).font(.orbitLabel).foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(Color.ownerRequestAccent.opacity(0.10))
    }

    private var titleRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(request.title).font(.headline).fixedSize(horizontal: false, vertical: true)
            OwnerRequestKindTag(kind: request.kind)
        }
    }

    @ViewBuilder private var facts: some View {
        if !request.blocksTaskIds.isEmpty || request.secretSpec != nil {
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 16, verticalSpacing: 6) {
                if !request.blocksTaskIds.isEmpty {
                    GridRow {
                        Text(OwnerRequests.holdingUp).foregroundStyle(.secondary)
                        HStack(spacing: 6) {
                            ForEach(request.blocksTaskIds, id: \.self) { id in
                                Link(destination: DeepLink.url(for: .task(id))) {
                                    Text(model.taskTitle(id))
                                        .padding(.horizontal, 8).padding(.vertical, 2)
                                        .background(Color.accentColor.opacity(0.10), in: Capsule())
                                }
                            }
                        }
                    }
                }
                if let spec = request.secretSpec {
                    GridRow {
                        Text(OwnerRequests.deliveredTo).foregroundStyle(.secondary)
                        Text(OwnerRequests.destination(spec, runner: runner)).textSelection(.enabled)
                    }
                    GridRow {
                        Text(OwnerRequests.removed).foregroundStyle(.secondary)
                        Text(OwnerRequests.removedText(request))
                    }
                }
            }
            .font(.orbitSubtext)
        }
    }

    @ViewBuilder private var kindContent: some View {
        switch request.kind {
        case .manualStep:
            OwnerRequestSteps(steps: request.steps ?? [])
        case .decision:
            decision
        case .secret:
            secret
        case .confirm:
            EmptyView()
        case .wikiCreate:
            OwnerRequestWikiCreateFacts(request: request)
        case .settingsChange, .projectReopen:
            EmptyView()
        case .change:
            if let spec = request.changeSpec { changeSetting(spec) }
        case .browserSignIn:
            VStack(alignment: .leading, spacing: 6) {
                if let from = BrowserSignInCopy.fromSessionLine(request) {
                    Text(from).font(.orbitSubtext).foregroundStyle(.secondary)
                }
                Label { Text(BrowserSignInCopy.note) } icon: { Image(systemName: "lock.fill") }
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// A CHANGE card's setting block: live value → stepper, what is running, and what the number would do.
    private func changeSetting(_ spec: OwnerRequestChangeSpec) -> some View {
        let row = model.runnerRow(spec.runnerId)
        let live = row?.maxConcurrent ?? spec.before
        return VStack(alignment: .leading, spacing: 8) {
            Text(ChangeCopy.setting(changeRunner)).font(.orbitSubtext.weight(.semibold))
            HStack(spacing: 10) {
                Text("\(live)").font(.orbitControl).foregroundStyle(.secondary)
                Text("→").foregroundStyle(.secondary)
                changeStepper
                if let running = row?.activeSessions {
                    Text(ChangeCopy.runningNow(running)).font(.orbitLabel).foregroundStyle(.secondary)
                }
            }
            if live != spec.before {
                Text(ChangeCopy.wasWhenAsked(spec.before)).font(.orbitLabel).foregroundStyle(.secondary)
            }
            if let effect = ChangeCopy.effect(value: maxValue, live: live) {
                Text(effect).font(.orbitLabel).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder private var changeStepper: some View {
        #if os(macOS)
        Stepper(value: $maxValue, in: 1...999) {
            Text("\(maxValue)").font(.orbitControl.monospacedDigit()).frame(minWidth: 28, alignment: .trailing)
        }
        .accessibilityLabel(ChangeCopy.numberLabel)
        .accessibilityIdentifier("owner-request-change-stepper")
        #else
        // A − / + stepper with no keyboard.
        HStack(spacing: 0) {
            Button { maxValue = max(1, maxValue - 1) } label: {
                Image(systemName: "minus").frame(width: 40, height: 36)
            }
            .disabled(maxValue <= 1)
            .accessibilityLabel("Decrease")
            Text("\(maxValue)").font(.orbitControl.monospacedDigit()).frame(minWidth: 36)
                .accessibilityIdentifier("owner-request-change-value")
            Button { maxValue = min(999, maxValue + 1) } label: {
                Image(systemName: "plus").frame(width: 40, height: 36)
            }
            .accessibilityLabel("Increase")
        }
        .buttonStyle(.plain)
        .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityIdentifier("owner-request-change-stepper")
        #endif
    }

    private var decision: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array((request.options ?? []).enumerated()), id: \.offset) { index, option in
                Button { chosen = chosen == index ? nil : index } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: chosen == index ? "largecircle.fill.circle" : "circle")
                            .foregroundStyle(chosen == index ? Color.accentColor : .secondary)
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(option.label).font(.orbitControl)
                                if request.recommendedOption == index {
                                    Text("Recommended").font(.orbitMeta).foregroundStyle(.secondary)
                                }
                            }
                            if let description = option.description {
                                Text(description).font(.orbitLabel).foregroundStyle(.secondary)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            TextField(placeholder, text: $text, axis: .vertical)
                .lineLimit(2...8)
                .textFieldStyle(.roundedBorder)
                .focused($field, equals: .answer)
                .accessibilityIdentifier("owner-request-answer")
        }
    }

    private var placeholder: String {
        if (request.options ?? []).isEmpty { return OwnerRequests.yourAnswer }
        return chosen != nil ? OwnerRequests.addNote : OwnerRequests.ownAnswer
    }

    @ViewBuilder private var secret: some View {
        if let spec = request.secretSpec, let grant, grant.state == .pendingDelivery {
            VStack(alignment: .leading, spacing: 4) {
                Label(OwnerRequests.onItsWay(runner), systemImage: "clock").font(.orbitSubtext)
                if !grant.runnerOnline {
                    Text(OwnerRequests.runnerOffline(runner)).font(.orbitLabel).foregroundStyle(.secondary)
                }
            }
            .accessibilityLabel(spec.name)
        } else if let grant, grant.state == .removing {
            VStack(alignment: .leading, spacing: 4) {
                Label(OwnerRequests.grantLine(grant, runner: runner) ?? "", systemImage: "clock").font(.orbitSubtext)
                Text(OwnerRequests.reenterAfterRemoval(runner)).font(.orbitLabel).foregroundStyle(.secondary)
            }
        } else if let spec = request.secretSpec {
            VStack(alignment: .leading, spacing: 8) {
                if grant?.state == .removed, grant?.endReason == "DELIVERY_FAILED" {
                    Label(OwnerRequests.deliveryFailed(runner), systemImage: "exclamationmark.triangle.fill")
                        .font(.orbitLabel).foregroundStyle(.red)
                } else if OwnerRequests.removalToTell(grant), let grant {
                    Text(OwnerRequests.grantLine(grant, runner: runner) ?? "").font(.orbitLabel).foregroundStyle(.secondary)
                }
                Text(spec.name).font(.orbitSubtext.weight(.semibold))
                if let savedID = draft.savedID {
                    HStack(spacing: 8) {
                        Text(OwnerRequests.usingSaved(model.savedSecrets.first { $0.id == savedID }?.label ?? "secret"))
                            .font(.orbitSubtext)
                        Button(OwnerRequests.enterKeyInstead) { draft.savedID = nil }
                            .buttonStyle(.borderless)
                    }
                } else {
                    SecureField(OwnerRequests.keyPlaceholder, text: $draft.value)
                        .textFieldStyle(.roundedBorder)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                        .focused($field, equals: .secret)
                        .accessibilityIdentifier("owner-request-secret")
                    Toggle(OwnerRequests.saveToAccount, isOn: $draft.save)
                        .font(.orbitLabel)
                        #if os(macOS)
                        .toggleStyle(.checkbox)
                        #endif
                    if draft.save {
                        TextField(OwnerRequests.saveAsPlaceholder, text: $draft.saveAs)
                            .textFieldStyle(.roundedBorder)
                            .autocorrectionDisabled()
                    }
                }
                Label { Text(OwnerRequests.secretNotice(spec, runner: runner)) } icon: {
                    Image(systemName: "lock.fill")
                }
                .font(.orbitLabel).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// The buttons as every other card draws them (`ApprovalActions`: stacked full width on a phone,
    /// one row on a Mac), Chat about this after the press; then the ways out, as links. A WIKI_CREATE card's
    /// are its own three (design §3.6): Create wiki, Change settings…, Not for this repository.
    @ViewBuilder private var actions: some View {
        if request.kind == .browserSignIn { browserSignInActions }
        else if request.kind == .wikiCreate { wikiCreateActions } else { kindActions }
    }

    private var kindActions: some View {
        VStack(alignment: .leading, spacing: 10) {
            ApprovalActions {
                doors
                chat
            }
            HStack(spacing: 12) { exits }
        }
        .lineLimit(1)
    }

    /// Chat about this: on any pending card in its conversation (an `onChat` to hand it to), none past the deadline.
    @ViewBuilder private var chat: some View {
        if let onChat, !closed {
            Button {
                PlatformHaptics.tap()
                dismissReview()
                onChat(request)
            } label: {
                Text(Approvals.chatAction).approvalActionLabel()
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("owner-request-chat")
        }
    }

    @ViewBuilder private var doors: some View {
            if grant?.state == .pendingDelivery {
                Button { run { try await model.cancelSecret(request) } } label: {
                    Text(OwnerRequests.cancel).approvalActionLabel()
                }
                .buttonStyle(.bordered).disabled(busy)
            } else {
                Button { pressPrimary() } label: {
                    Text(OwnerRequests.primaryLabel(request.kind)).bold().approvalActionLabel()
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(busy || grant?.state == .removing
                          || !OwnerRequests.canSubmit(request, draft: draft, option: chosen, text: text))
                .accessibilityIdentifier("owner-request-primary")
                if request.kind == .secret, draft.savedID == nil, let saved = model.savedSecrets.first {
                    Button {
                        draft.value = ""
                        draft.save = false
                        draft.savedID = saved.id
                    } label: {
                        Text(OwnerRequests.useSaved(saved.label)).approvalActionLabel()
                    }
                    .buttonStyle(.bordered)
                }
            }
    }

    @ViewBuilder private var exits: some View {
            Button(OwnerRequests.declineLabel(request.kind)) {
                declining = true
                field = .reason
            }
            .buttonStyle(.borderless).disabled(closed)
            Spacer(minLength: 0)
            Menu(OwnerRequests.remindLater) {
                ForEach(OwnerRequests.snoozeChoices(request)) { choice in
                    Button(choice.label) { model.snooze(request.id, for: choice.seconds) }
                }
            }
            .fixedSize()
            .font(.orbitLabel)
            .disabled(OwnerRequests.snoozeChoices(request).isEmpty)
    }

    private var wikiCreateActions: some View {
        VStack(alignment: .leading, spacing: 10) {
            ApprovalActions {
                Button {
                    run {
                        try await model.createWiki(request)
                        await appModel.wiki?.loadSpaces()
                    }
                } label: {
                    Text(OwnerRequests.primaryLabel(request.kind)).bold().approvalActionLabel()
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(busy || closed)
                .accessibilityIdentifier("owner-request-primary")
                Button { changingSettings = true } label: {
                    Text(WikiStartCopy.changeSettings).approvalActionLabel()
                }
                .buttonStyle(.bordered)
                .disabled(busy || closed || appModel.wiki == nil)
                .accessibilityIdentifier("owner-request-wiki-settings")
                chat
            }
            HStack(spacing: 12) {
                Button(WikiStartCopy.notHere) { run { try await model.decline(request, reason: WikiStartCopy.notHere) } }
                    .buttonStyle(.borderless)
                    .disabled(busy || closed)
                    .accessibilityIdentifier("owner-request-not-here")
                Spacer(minLength: 0)
                Menu(OwnerRequests.remindLater) {
                    ForEach(OwnerRequests.snoozeChoices(request)) { choice in
                        Button(choice.label) { model.snooze(request.id, for: choice.seconds) }
                    }
                }
                .fixedSize()
                .font(.orbitLabel)
                .disabled(OwnerRequests.snoozeChoices(request).isEmpty)
            }
        }
        .lineLimit(1)
        .sheet(isPresented: $changingSettings) {
            if let wiki = appModel.wiki {
                WikiCreateSheet(wiki: wiki, workspaceID: request.workspaceId, created: { await model.load() })
            }
        }
    }

    /// A BROWSER_SIGN_IN card's (Orbit Cloud browser board): Open browser opens the runner's browser tab on the web and
    /// answers nothing, since Signed in is pressed there; Not now declines.
    private var browserSignInActions: some View {
        VStack(alignment: .leading, spacing: 10) {
            ApprovalActions {
                Button {
                    if let base = appModel.baseURL,
                       let url = BrowserSignInCopy.browserURL(baseURL: base, runnerId: request.browserRunnerId) {
                        openURL(url)
                    }
                } label: {
                    Text(BrowserSignInCopy.openBrowser).bold().approvalActionLabel()
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(busy || closed || request.browserRunnerId == nil)
                .accessibilityIdentifier("owner-request-primary")
                Button { run { try await model.decline(request, reason: BrowserSignInCopy.notNow) } } label: {
                    Text(BrowserSignInCopy.notNow).approvalActionLabel()
                }
                .buttonStyle(.bordered)
                .disabled(busy || closed)
                .accessibilityIdentifier("owner-request-not-now")
                chat
            }
        }
        .lineLimit(1)
    }

    private var declineForm: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField(OwnerRequests.declinePrompt, text: $reason, axis: .vertical)
                .lineLimit(2...6)
                .textFieldStyle(.roundedBorder)
                .focused($field, equals: .reason)
            HStack(spacing: 12) {
                Button(OwnerRequests.declineButton) {
                    let why = reason.trimmingCharacters(in: .whitespacesAndNewlines)
                    func decline(asWritten: Bool) {
                        run(resend: decline) { try await model.decline(request, reason: why, sendAsWritten: asWritten) }
                    }
                    decline(asWritten: false)
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy || closed || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button(OwnerRequests.keepIt) { declining = false }.buttonStyle(.borderless)
            }
        }
    }

    private func pressPrimary() {
        if request.kind == .change {
            let value = maxValue
            run { try await model.applyChange(request, maxConcurrent: value) }
            return
        }
        if request.kind == .secret {
            guard let body = draft.body else { return }
            // Emptied before the request goes out: nothing typed outlives the press.
            draft = OwnerRequests.SecretDraft(spec: request.secretSpec)
            field = nil
            run { try await model.submitSecret(request, body) }
            return
        }
        let body = OwnerRequests.doneBody(request, option: chosen, text: text)
        func complete(asWritten: Bool) {
            let sent = OwnerRequestDoneBody(option: body.option, text: body.text, sendAsWritten: asWritten)
            run(resend: complete) { try await model.complete(request, sent) }
        }
        complete(asWritten: false)
    }

    /// `resend` is the press again, for an answer whose words could not be translated (Retry with
    /// `false`, Send as written with `true`).
    private func run(resend: ((Bool) -> Void)? = nil, _ work: @escaping @MainActor () async throws -> Void) {
        busy = true
        failure = nil
        self.resend = nil
        Task { @MainActor in
            do { try await work() } catch {
                if let resend, OwnerCardTranslations.refused(error) {
                    self.resend = { asWritten in resend(asWritten) }
                } else {
                    failure = error.localizedDescription
                }
            }
            busy = false
        }
    }

    static func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
    }
}

/// What a WIKI_CREATE card will make (docs/wiki-explicit-creation-design.md §3.6, board 46 part 3): the repository,
/// the asking session's workspace it reads it from — offline when its runner is — and the maintenance it starts with.
struct OwnerRequestWikiCreateFacts: View {
    @Environment(AppModel.self) private var appModel
    let request: OwnerRequest

    var body: some View {
        let facts = WikiStartLogic.cardFacts(repoUrlNorm: request.repoUrlNorm, workspaceId: request.workspaceId,
                                             choices: appModel.wikiWorkspaceChoices)
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 16, verticalSpacing: 6) {
            if let repository = facts.repository {
                GridRow {
                    Text(WikiStartCopy.cardRepository).foregroundStyle(.secondary)
                    Text(repository).textSelection(.enabled)
                }
            }
            GridRow {
                Text(WikiStartCopy.cardReadsFrom).foregroundStyle(.secondary)
                HStack(spacing: 6) {
                    Text(facts.readsFrom ?? "—")
                    if facts.offline {
                        Text(WikiStartCopy.workspaceOffline).font(.orbitMeta).foregroundStyle(.secondary)
                    }
                }
            }
            GridRow {
                Text(WikiStartCopy.cardMaintenance).foregroundStyle(.secondary)
                Text(facts.maintenance)
            }
        }
        .font(.orbitSubtext)
    }
}

struct OwnerRequestKindTag: View {
    let kind: OwnerRequestKind
    var body: some View {
        Text(OwnerRequests.kindTag(kind))
            .font(.orbitMeta.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Color.secondary.opacity(0.4)))
    }
}

/// A manual step's list: each step's words, the address to open and the command to copy.
struct OwnerRequestSteps: View {
    let steps: [OwnerRequestStep]
    @State private var copied: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text("\(index + 1)")
                        .font(.orbitLabel).foregroundStyle(.secondary)
                        .frame(width: 20, height: 20)
                        .background(Color.secondary.opacity(0.12), in: Circle())
                    VStack(alignment: .leading, spacing: 4) {
                        Text(step.text).font(.orbitProse)
                        if let link = step.link {
                            valueRow(link) {
                                if let url = OwnerRequests.openableLink(link) {
                                    Link("Open", destination: url).font(.orbitLabel.weight(.semibold))
                                }
                            }
                        }
                        if let command = step.command {
                            valueRow(command) {
                                Button(copied == index ? "Copied" : "Copy") {
                                    PlatformPasteboard.copyString(command)
                                    copied = index
                                }
                                .buttonStyle(.borderless).font(.orbitLabel.weight(.semibold))
                            }
                        }
                    }
                }
            }
        }
    }

    private func valueRow(_ value: String, @ViewBuilder action: () -> some View) -> some View {
        HStack(spacing: 8) {
            Text(value).font(.orbitMono).textSelection(.enabled).lineLimit(3)
            action()
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
    }
}

/// A terminal asking to be approved (docs/terminal-session-design.md, board 2 marker 7): the owner request card's
/// frame, header and action row — no look of its own. Approve mints the terminal's credential for 30 days; Deny tells
/// the terminal so. Web parity: `TerminalApproveCard.tsx`; the words are OrbitKit's `Terminals`.
struct TerminalApproveCard: View {
    let model: OwnerRequestsModel
    let request: TerminalRequest
    /// Opened from the needs-you line or the push: the card's outline says which one for a moment.
    var lit = false
    /// What the server recorded, for the page's notice (board ② choice 3).
    var onSaid: (String) -> Void = { _ in }
    @State private var busy = false
    @State private var failure: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Circle().fill(Color.ownerRequestAccent).frame(width: 8, height: 8)
                Text(OwnerRequests.waitingOnYou).font(.orbitLabel.weight(.semibold))
                    .foregroundStyle(Color.ownerRequestAccent)
                Spacer(minLength: 8)
                Text("Asked \(RelativeTime.ago(request.createdAt) ?? "")").font(.orbitLabel).foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .padding(.horizontal, 16).padding(.vertical, 10)
            .background(Color.ownerRequestAccent.opacity(0.10))
            Divider().overlay(Color.ownerRequestAccent.opacity(0.35))
            VStack(alignment: .leading, spacing: 12) {
                Text(Terminals.approveTitle).font(.headline)
                VStack(alignment: .leading, spacing: 4) {
                    Text(Terminals.requestLine(request))
                    Text(Terminals.approveDetail)
                }
                .font(.orbitProse)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                if let failure {
                    Label { Text("\(OwnerRequests.notRecorded): \(failure)") } icon: {
                        Image(systemName: "exclamationmark.triangle.fill")
                    }
                    .font(.orbitLabel).foregroundStyle(.red)
                }
                HStack(spacing: 10) {
                    Button { decide(approve: false) } label: {
                        Text(Terminals.deny).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("terminal-deny-\(request.id)")
                    Button { decide(approve: true) } label: {
                        Text(Terminals.approve).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("terminal-approve-\(request.id)")
                }
                .disabled(busy)
            }
            .padding(16)
        }
        .background(Color.ownerRequestAccent.opacity(0.03), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12)
            .strokeBorder(Color.ownerRequestAccent.opacity(lit ? 1 : 0.45), lineWidth: lit ? 2 : 1))
        .shadow(color: lit ? .orange.opacity(0.35) : .clear, radius: lit ? 6 : 0)
        // A container, so its own identifier does not overwrite its buttons'.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("terminal-request-\(request.id)")
    }

    private func decide(approve: Bool) {
        busy = true
        Task { @MainActor in
            do {
                try await model.decideTerminal(request, approve: approve)
                onSaid(approve ? Terminals.approvedToast : Terminals.deniedToast)
            } catch { failure = error.localizedDescription }
            busy = false
        }
    }
}

/// A request that has ended, as one row: how, who, when, and from which device (panel 4).
struct OwnerRequestResolvedLine: View {
    let model: OwnerRequestsModel
    let request: OwnerRequest
    @State private var busy = false
    @State private var failure: String?

    private var runner: String {
        (request.secretSpec?.runnerId ?? request.changeSpec?.runnerId).map(model.runnerName) ?? "this runner"
    }

    private var icon: (String, Color) {
        switch request.state {
        case .done: return ("checkmark.circle.fill", .green)
        case .declined: return ("xmark.circle.fill", .red)
        case .expired: return ("clock", .secondary)
        case .withdrawn, .pending: return ("arrow.uturn.backward.circle", .secondary)
        }
    }

    var body: some View {
        let grant = OwnerRequests.resolvedGrant(request)
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon.0).foregroundStyle(icon.1).font(.title3)
            VStack(alignment: .leading, spacing: 2) {
                Text(request.title).font(.orbitSubtext.weight(.semibold))
                Text(OwnerRequests.outcomeLine(request, runner: runner)).font(.orbitLabel).foregroundStyle(.secondary)
                if let grant, let line = OwnerRequests.grantLine(grant, runner: runner) {
                    Text(line).font(.orbitLabel).foregroundStyle(.secondary)
                }
                Text([OwnerRequests.byLine(request), OwnerRequests.deviceLabel(request.resolvedClient)]
                        .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.orbitLabel).foregroundStyle(.secondary)
                if let failure { Text(failure).font(.orbitLabel).foregroundStyle(.red) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if grant?.state == .active {
                Button(OwnerRequests.revoke) {
                    busy = true
                    Task { @MainActor in
                        do { try await model.revokeSecret(request) } catch { failure = error.localizedDescription }
                        busy = false
                    }
                }
                .buttonStyle(.borderless).font(.orbitLabel).disabled(busy)
            }
        }
        .padding(12)
        .overlay(RoundedRectangle(cornerRadius: 10)
            .strokeBorder((request.state == .done ? Color.green : Color.secondary).opacity(0.35)))
        .accessibilityIdentifier("owner-request-\(request.id)")
    }
}

/// A request put off with Remind me later, folded until it comes back.
struct OwnerRequestSnoozedLine: View {
    let model: OwnerRequestsModel
    let request: OwnerRequest
    let until: Date

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "clock").foregroundStyle(.secondary)
            Text(request.title).font(.orbitSubtext).lineLimit(1)
            Spacer(minLength: 8)
            Text(OwnerRequests.reminderLine(until)).font(.orbitLabel).foregroundStyle(.secondary)
            Button(OwnerRequests.showNow) { model.wake(request.id) }.buttonStyle(.borderless).font(.orbitLabel)
        }
        .padding(10)
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.secondary.opacity(0.3)))
    }
}

