import SwiftUI
import OrbitKit

// A watch's own record and its controls, shared by the Following page's detail column and the sheet
// the console's Watching card opens with View. The wording is all OrbitKit's `WatchProjection`.

/// The detail column (a pushed page on iPhone) for `AppModel.selectedWatchID`. A deep link or a push
/// can name a watch the list doesn't hold — an older one — so a miss fetches it before saying so.
struct WatchDetailView: View {
    @Environment(AppModel.self) private var model
    @State private var missingID: String?

    var body: some View {
        if let store = model.watches, let id = model.selectedWatchID {
            if let watch = store.watch(id) {
                WatchDetailContent(store: store, watch: watch, opensTargets: true)
                    .id(watch.id)
            } else if missingID == id {
                ContentUnavailableView("Watch not found", systemImage: "eye.slash",
                                       description: Text("It may have been deleted, or this server doesn't serve watches."))
            } else {
                ProgressView()
                    .task(id: id) {
                        await store.fetch(id)
                        if store.watch(id) == nil { missingID = id }
                    }
            }
        } else {
            ContentUnavailableView("Select a watch", systemImage: "eye",
                                   description: Text("What it waits for, where each target stands, and what happened when it held."))
        }
    }
}

/// The Watching card's View: the same record in a sheet, so looking doesn't leave the console. It
/// reads the store on every render, so a control used here shows its outcome here.
struct WatchDetailSheet: View {
    @Environment(\.dismiss) private var dismiss
    let store: WatchesModel
    let watch: Watch

    var body: some View {
        NavigationStack {
            WatchDetailContent(store: store, watch: store.watch(watch.id) ?? watch, opensTargets: false)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
        #if os(macOS)
        .frame(minWidth: 480, minHeight: 520)
        #endif
    }
}

/// A watch's whole record: what it's doing and for what, where each target stands, how fresh that is,
/// what happens when the condition holds, and every Match or end with what its delivery did.
struct WatchDetailContent: View {
    @Environment(AppModel.self) private var model
    let store: WatchesModel
    let watch: Watch
    /// Whether a target row opens its session or task. Off in the card's sheet, where navigating
    /// underneath it would go unseen.
    let opensTargets: Bool
    @State private var busy = false
    @State private var errorText: String?
    @State private var editing = false
    @State private var confirmingStop = false

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            Form {
                overview(now: context.date)
                attention(now: context.date)
                Section("Targets") {
                    ForEach(watch.targets.indices, id: \.self) { index in
                        WatchTargetRow(target: watch.targets[index], opens: opensTargets)
                    }
                }
                history
                if let errorText {
                    Section {
                        Text(errorText).foregroundStyle(.red)
                    }
                }
            }
            .formStyle(.grouped)
        }
        .navigationTitle(WatchProjection.headline(for: watch))
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                ForEach(WatchStateMachine.controls(for: watch.state).filter { $0 != .view }, id: \.self) { control in
                    Button(control.title) { tap(control) }
                        .disabled(busy)
                }
            }
        }
        .sheet(isPresented: $editing) {
            WatchEditSheet(store: store, watch: watch)
        }
        .confirmationDialog("Stop watching?", isPresented: $confirmingStop, titleVisibility: .visible) {
            Button("Stop", role: .destructive) { run(.stop) }
        } message: {
            Text(WatchProjection.stopWarning(for: watch))
        }
    }

    @ViewBuilder
    private func overview(now: Date) -> some View {
        Section {
            LabeledContent("Progress", value: WatchProjection.progress(for: watch))
            LabeledContent("Condition", value: WatchProjection.condition(watch.predicate,
                                                                          targetCount: WatchProgress(watch.targets).live))
            LabeledContent("When it holds", value: WatchProjection.action(for: watch, observerTitle: observerTitle))
            LabeledContent("Freshness", value: WatchProjection.lastEvaluated(for: watch, now: now))
            if let deadline = WatchProjection.deadline(for: watch, now: now) {
                LabeledContent("Deadline", value: deadline)
            }
            if let delivery = WatchProjection.deliveryStatus(for: watch) {
                LabeledContent("Delivery", value: delivery)
            }
        } header: {
            Text(WatchProjection.headline(for: watch))
        }
    }

    @ViewBuilder
    private func attention(now: Date) -> some View {
        let reasons = WatchProjection.attention(for: watch, now: now)
        if !reasons.isEmpty {
            Section("Needs attention") {
                ForEach(reasons.indices, id: \.self) { index in
                    Label(reasons[index].text, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                }
            }
        }
    }

    /// Every Match, and the end of a watch that never matched, each with what its delivery did.
    @ViewBuilder
    private var history: some View {
        if !watch.matches.isEmpty || !watch.expiryDeliveries.isEmpty {
            Section("History") {
                ForEach(watch.matches) { match in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(matchedLine(match))
                        Text(match.reason)
                            .font(.orbitMono)
                            .foregroundStyle(.secondary)
                        ForEach(match.deliveries) { delivery in
                            if let status = WatchProjection.deliveryStatus(delivery) {
                                Text(status)
                                    .font(.orbitMeta)
                                    .foregroundStyle(delivery.state == .deadLetter ? Color.orange : Color.secondary)
                            }
                        }
                    }
                }
                ForEach(watch.expiryDeliveries.indices, id: \.self) { index in
                    let end = watch.expiryDeliveries[index]
                    VStack(alignment: .leading, spacing: 3) {
                        Text(WatchProjection.endTitle(end.kind))
                        if let status = WatchProjection.deliveryStatus(end.delivery) {
                            Text(status)
                                .font(.orbitMeta)
                                .foregroundStyle(end.delivery.state == .deadLetter ? Color.orange : Color.secondary)
                        }
                    }
                }
            }
        }
    }

    private func matchedLine(_ match: WatchMatch) -> String {
        guard let when = RelativeTime.format(match.matchedAt) else { return "Matched" }
        return "Matched \(when)"
    }

    private var observerTitle: String? {
        guard let id = watch.observerSessionId else { return nil }
        return model.session(id: id)?.title
    }

    private func tap(_ control: WatchControl) {
        switch control {
        case .view: break
        case .edit: editing = true
        case .stop: confirmingStop = true
        case .pause, .resume: run(control)
        }
    }

    private func run(_ control: WatchControl) {
        busy = true
        errorText = nil
        Task {
            errorText = await store.perform(control, on: watch)
            busy = false
        }
    }
}

/// One frozen target: what it is, where it stands, and — while it still exists — a way to it.
private struct WatchTargetRow: View {
    @Environment(AppModel.self) private var model
    let target: WatchTarget
    let opens: Bool

    var body: some View {
        if opens, let destination = route {
            Button { model.route(to: destination) } label: { label }
                .buttonStyle(.plain)
        } else {
            label
        }
    }

    private var label: some View {
        HStack(spacing: 8) {
            Image(systemName: target.targetKind == .session ? "bubble.left.and.bubble.right" : "checklist")
                .foregroundStyle(.secondary)
                .frame(width: 18)
            Text(title).lineLimit(1)
            Spacer(minLength: 8)
            Text(WatchProjection.targetStateWord(target.state))
                .font(.orbitMeta)
                .foregroundStyle(target.state == .satisfied ? Color.green : Color.secondary)
        }
        .contentShape(Rectangle())
    }

    private var route: Route? {
        guard target.state != .gone else { return nil }
        switch target.targetKind {
        case .session: return .session(target.targetResourceId)
        case .task: return .task(target.targetResourceId)
        case .unknown: return nil
        }
    }

    /// Named from what the app already holds; a target it hasn't loaded shows its kind and short id.
    private var title: String {
        let id = target.targetResourceId
        switch target.targetKind {
        case .session: return model.session(id: id)?.title ?? "Session \(id.prefix(8))"
        case .task: return model.tasks?.item(id)?.title ?? "Task \(id.prefix(8))"
        case .unknown: return id
        }
    }
}

/// Edit a live watch's condition and deadline. Its targets and what it does stay as created.
struct WatchEditSheet: View {
    @Environment(\.dismiss) private var dismiss
    let store: WatchesModel
    let watch: Watch
    @State private var condition: WatchPredicate
    /// Nil keeps the current deadline.
    @State private var ttlSeconds: Int?
    @State private var saving = false
    @State private var errorText: String?

    init(store: WatchesModel, watch: Watch) {
        self.store = store
        self.watch = watch
        _condition = State(initialValue: watch.predicate)
        _ttlSeconds = State(initialValue: nil)
    }

    private var targetCount: Int { WatchProgress(watch.targets).live }

    private var request: UpdateWatchRequest? {
        WatchEditing.request(for: watch, condition: condition, ttlSeconds: ttlSeconds)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Condition", selection: $condition) {
                        ForEach(WatchEditing.conditions(for: watch), id: \.self) { predicate in
                            Text(WatchProjection.condition(predicate, targetCount: targetCount))
                                .tag(predicate)
                        }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                } header: {
                    Text("Condition")
                } footer: {
                    Text("\(WatchProjection.watchingLabel(targets: targetCount)). The targets and what happens when the condition holds stay as created.")
                }
                Section {
                    Picker("Expires", selection: $ttlSeconds) {
                        Text(keepDeadlineTitle).tag(Int?.none)
                        ForEach(WatchEditing.deadlineChoices, id: \.self) { seconds in
                            Text("In \(WatchEditing.deadlineTitle(seconds))").tag(Int?.some(seconds))
                        }
                    }
                } footer: {
                    Text("A new deadline counts from now.")
                }
                if let errorText {
                    Section {
                        Text(errorText).foregroundStyle(.red)
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Edit watch")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                        .disabled(request == nil || saving)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 480)
        #endif
    }

    private var keepDeadlineTitle: String {
        guard let deadline = WatchProjection.deadline(for: watch) else { return "Keep current" }
        return "Keep current — \(deadline)"
    }

    private func save() {
        guard let request else { return }
        saving = true
        errorText = nil
        Task {
            if let failure = await store.save(request, for: watch) {
                errorText = failure
                saving = false
            } else {
                dismiss()
            }
        }
    }
}
