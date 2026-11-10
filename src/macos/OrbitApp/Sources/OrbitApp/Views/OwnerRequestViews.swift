import SwiftUI
import OrbitKit

// What a session asked the owner to do, drawn the same way in the conversation that asked and in the
// "Waiting on you" inbox: pending it is the whole request, ended it is one line saying how, who and
// when. Every word comes from OrbitKit's `OwnerRequests`; web parity: `components/OwnerRequestCard.tsx`.

private extension Color {
    static let ownerRequestAccent = Color.orange
}

/// One request wherever it is drawn: whole, folded for later, or as its summary.
struct OwnerRequestView: View {
    @Environment(AppModel.self) private var appModel
    let requestID: String
    /// The input a push or a link asked for: the card puts the cursor there when it appears.
    var focus: OwnerRequestLink.Focus? = nil

    var body: some View {
        if let model = appModel.ownerRequests, let request = model.request(requestID) {
            OwnerRequestContent(model: model, request: request, focus: focus)
        }
    }
}

/// The same, given the model and the request: what the inbox and the probe draw directly.
struct OwnerRequestContent: View {
    let model: OwnerRequestsModel
    let request: OwnerRequest
    var focus: OwnerRequestLink.Focus? = nil

    var body: some View {
        if request.state != .pending {
            OwnerRequestResolvedLine(model: model, request: request)
        } else if focus == nil, let until = model.snoozedUntil(request.id) {
            OwnerRequestSnoozedLine(model: model, request: request, until: until)
        } else {
            OwnerRequestCard(model: model, request: request, focus: focus)
        }
    }
}

/// A pending request, whole: panel 1 of the owner-action board.
struct OwnerRequestCard: View {
    let model: OwnerRequestsModel
    let request: OwnerRequest
    var focus: OwnerRequestLink.Focus? = nil

    private enum Field: Hashable { case secret, answer, reason }

    /// The key being typed lives here and nowhere else: not in the model, not on disk, not in a URL.
    /// SwiftUI drops it with the card, and a press empties it before the request goes out.
    @State private var draft: OwnerRequests.SecretDraft
    @State private var chosen: Int?
    @State private var text = ""
    @State private var declining = false
    @State private var reason = ""
    @State private var busy = false
    @State private var failure: String?
    @FocusState private var field: Field?

    init(model: OwnerRequestsModel, request: OwnerRequest, focus: OwnerRequestLink.Focus? = nil) {
        self.model = model
        self.request = request
        self.focus = focus
        _draft = State(initialValue: OwnerRequests.SecretDraft(spec: request.secretSpec))
        _chosen = State(initialValue: request.recommendedOption)
    }

    private var runner: String { request.secretSpec.map { model.runnerName($0.runnerId) } ?? "this runner" }
    private var grant: OwnerRequestSecretGrant? { request.kind == .secret ? request.secretGrant : nil }
    private var closed: Bool { OwnerRequests.pastDeadline(request) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().overlay(Color.ownerRequestAccent.opacity(0.35))
            VStack(alignment: .leading, spacing: 12) {
                titleRow
                if !request.why.isEmpty {
                    Text(Self.markdown(request.why))
                        .font(.orbitProse)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
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
        .task(id: focus) {
            guard let focus else { return }
            // Let the card land on screen before the cursor goes in, or the field is not there yet.
            try? await Task.sleep(nanoseconds: 350_000_000)
            switch focus {
            case .secret: field = .secret
            case .answer: field = .answer
            case .primary: field = nil
            }
        }
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
        }
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

    private var actions: some View {
        HStack(spacing: 12) {
            if grant?.state == .pendingDelivery {
                Button(OwnerRequests.cancel) { run { try await model.cancelSecret(request) } }
                    .buttonStyle(.bordered).disabled(busy)
            } else {
                Button { pressPrimary() } label: {
                    Text(OwnerRequests.primaryLabel(request.kind)).bold()
                }
                .buttonStyle(.borderedProminent)
                .tint(.primary)
                .keyboardShortcut(.defaultAction)
                .disabled(busy || grant?.state == .removing
                          || !OwnerRequests.canSubmit(request, draft: draft, option: chosen, text: text))
                .accessibilityIdentifier("owner-request-primary")
                if request.kind == .secret, draft.savedID == nil, let saved = model.savedSecrets.first {
                    Button(OwnerRequests.useSaved(saved.label)) {
                        draft.value = ""
                        draft.save = false
                        draft.savedID = saved.id
                    }
                    .buttonStyle(.bordered)
                }
            }
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
                    run { try await model.decline(request, reason: why) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy || closed || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button(OwnerRequests.keepIt) { declining = false }.buttonStyle(.borderless)
            }
        }
    }

    private func pressPrimary() {
        if request.kind == .secret {
            guard let body = draft.body else { return }
            // Emptied before the request goes out: nothing typed outlives the press.
            draft = OwnerRequests.SecretDraft(spec: request.secretSpec)
            field = nil
            run { try await model.submitSecret(request, body) }
            return
        }
        let body = OwnerRequests.doneBody(request, option: chosen, text: text)
        run { try await model.complete(request, body) }
    }

    private func run(_ work: @escaping @MainActor () async throws -> Void) {
        busy = true
        failure = nil
        Task { @MainActor in
            do { try await work() } catch { failure = error.localizedDescription }
            busy = false
        }
    }

    static func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
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

/// A request that has ended, as one row: how, who, when, and from which device (panel 4).
struct OwnerRequestResolvedLine: View {
    let model: OwnerRequestsModel
    let request: OwnerRequest
    @State private var busy = false
    @State private var failure: String?

    private var runner: String { request.secretSpec.map { model.runnerName($0.runnerId) } ?? "this runner" }

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
                if let failure { Text(failure).font(.orbitLabel).foregroundStyle(.red) }
            }
            Spacer(minLength: 8)
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
            VStack(alignment: .trailing, spacing: 2) {
                Text(OwnerRequests.byLine(request))
                if let device = OwnerRequests.deviceLabel(request.resolvedClient) { Text(device) }
            }
            .font(.orbitLabel).foregroundStyle(.secondary)
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

/// "Waiting on you": everything agents have asked the owner to do, with Open, Done and Declined (panel 3).
struct OwnerRequestInboxView: View {
    let model: OwnerRequestsModel
    var onClose: (() -> Void)? = nil
    @State private var expanded: Set<String> = []

    var body: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(OwnerRequests.waitingOnYou).font(.title3.weight(.semibold))
                if model.waitingCount > 0 {
                    Text("\(model.waitingCount)")
                        .font(.orbitLabel.weight(.bold)).foregroundStyle(.white)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(Color.ownerRequestAccent, in: Capsule())
                }
                Spacer()
                Picker(OwnerRequests.waitingOnYou, selection: $model.tab) {
                    ForEach(OwnerRequests.InboxTab.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                if let onClose {
                    Button { onClose() } label: { Image(systemName: "xmark") }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Close")
                }
            }
            .padding(16)
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        let rows = model.rows(model.tab)
                        if rows.isEmpty {
                            Text(model.tab.empty).font(.orbitSubtext).foregroundStyle(.secondary).padding(16)
                        }
                        ForEach(rows) { request in
                            if model.tab == .open {
                                row(request).id(request.id)
                                Divider()
                            } else {
                                OwnerRequestResolvedLine(model: model, request: request)
                                    .padding(.horizontal, 16).padding(.vertical, 6)
                            }
                        }
                    }
                }
                .onChange(of: model.focusedRequestID, initial: true) { _, id in
                    guard let id, let request = model.request(id) else { return }
                    expanded.insert(request.id)
                    withAnimation { proxy.scrollTo(request.id, anchor: .top) }
                }
                .onChange(of: model.open.count) { _, _ in
                    guard let id = model.focusedRequestID, let request = model.request(id) else { return }
                    expanded.insert(request.id)
                    proxy.scrollTo(request.id, anchor: .top)
                }
            }
        }
        .task(id: model.tab) { await model.loadTab(model.tab) }
        .accessibilityIdentifier("owner-request-inbox")
    }

    private func row(_ request: OwnerRequest) -> some View {
        let open = expanded.contains(request.id)
        let detail = [OwnerRequests.inboxDetail(request)].compactMap { $0 }.joined(separator: " · ")
        let holds = OwnerRequests.holdsText(request)
        let age = model.snoozedUntil(request.id).map { OwnerRequests.reminderLine($0) }
            ?? RelativeTime.ago(request.createdAt) ?? ""
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: OwnerRequests.symbol(request.kind))
                    .foregroundStyle(request.kind == .secret ? Color.ownerRequestAccent : .accentColor)
                    .frame(width: 32, height: 32)
                    .background(Color.secondary.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
                VStack(alignment: .leading, spacing: 2) {
                    Text(request.title).font(.orbitSubtext.weight(.semibold))
                    if !detail.isEmpty || holds != nil {
                        Text("\(detail)\(detail.isEmpty || holds == nil ? "" : " · ")\(Text(holds ?? "").foregroundColor(.orange).bold())")
                            .font(.orbitLabel).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 4) {
                    Text(age).font(.orbitLabel).foregroundStyle(.secondary)
                    Button(open ? "Close" : OwnerRequests.inboxAction(request.kind)) {
                        if open { expanded.remove(request.id) } else { expanded.insert(request.id) }
                    }
                    .buttonStyle(.bordered).controlSize(.small)
                    .accessibilityIdentifier("owner-request-row-\(request.id)")
                }
            }
            if open {
                let focused = model.focusedRequestID.map { PublicID.storageKey($0) == PublicID.storageKey(request.id) } ?? false
                OwnerRequestContent(model: model, request: request,
                                    focus: focused ? OwnerRequestLink.focus(request.kind) : nil)
            }
        }
        .padding(16)
    }
}

/// The inbox as a sheet over whichever shell is showing, raised by a push action, a link or its entry.
struct OwnerRequestInboxSheet: ViewModifier {
    let model: AppModel
    func body(content: Content) -> some View {
        content.sheet(isPresented: Binding(
            get: { model.ownerRequests?.inboxPresented ?? false },
            set: { shown in
                model.ownerRequests?.inboxPresented = shown
                if !shown { model.ownerRequests?.focusedRequestID = nil }
            })) {
            if let requests = model.ownerRequests {
                OwnerRequestInboxView(model: requests, onClose: {
                    requests.inboxPresented = false
                    requests.focusedRequestID = nil
                })
                #if os(macOS)
                .frame(minWidth: 620, minHeight: 560)
                #endif
            }
        }
    }
}

extension View {
    func ownerRequestInboxSheet(_ model: AppModel) -> some View { modifier(OwnerRequestInboxSheet(model: model)) }
}

/// The entry to the inbox, with its count: in the drawer and the sidebar.
struct OwnerRequestInboxEntry: View {
    @Environment(AppModel.self) private var appModel

    var body: some View {
        if let requests = appModel.ownerRequests, !requests.unsupported {
            Button {
                requests.tab = .open
                requests.inboxPresented = true
            } label: {
                HStack {
                    Label(OwnerRequests.waitingOnYou, systemImage: "hand.raised")
                    Spacer()
                    if requests.waitingCount > 0 {
                        Text("\(requests.waitingCount)")
                            .font(.orbitLabel.weight(.bold)).foregroundStyle(.white)
                            .padding(.horizontal, 7).padding(.vertical, 1)
                            .background(Color.ownerRequestAccent, in: Capsule())
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("owner-request-inbox-entry")
        }
    }
}
