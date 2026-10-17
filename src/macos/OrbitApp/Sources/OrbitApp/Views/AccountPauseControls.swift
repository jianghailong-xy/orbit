import SwiftUI
import OrbitKit

/// The same pause controls on runner accounts and pool members. The owning model refreshes after writes.
struct AccountPauseControls: View {
    let name: String
    let pausedUntil: String?
    let scope: String
    var canManage = true
    var signedInAction: (() -> Void)? = nil
    var signInDisabled = false
    let save: (Int?) async -> String?

    @State private var choosing = false
    @State private var saving = false
    @State private var failure: String?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let paused = AccountPause.isPaused(pausedUntil, now: context.date)
            VStack(alignment: .leading, spacing: 10) {
                AccountPauseLine(pausedUntil: pausedUntil)
                if canManage || signedInAction != nil {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 8) { buttons(paused: paused) }
                        VStack(alignment: .leading, spacing: 8) { buttons(paused: paused) }
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.small)
                    .disabled(saving)
                }
                if let failure {
                    Text(failure).font(.orbitLabel).foregroundStyle(Color.red)
                }
            }
        }
        .sheet(isPresented: $choosing) {
            AccountPauseSheet(name: name, scope: scope, save: save)
        }
    }

    @ViewBuilder private func buttons(paused: Bool) -> some View {
        if let signedInAction {
            Button("Sign In Again", action: signedInAction).disabled(signInDisabled)
        }
        if canManage {
            if paused {
                Button {
                    saving = true
                    failure = nil
                    Task {
                        failure = await save(nil)
                        saving = false
                    }
                } label: { Label("Resume Now", systemImage: "play.fill") }
                Button("Change Duration…") { choosing = true }
                    .buttonStyle(.borderless)
            } else {
                Button { choosing = true } label: { Label("Pause…", systemImage: "pause.fill") }
                    .tint(.secondary)
            }
        }
    }
}

/// An account's pause as a line of its row: Paused, and until when, in the pause's orange. A state,
/// not a control — what resumes the account or changes the pause is the row's to offer — and nothing
/// at all once the pause has run out.
struct AccountPauseLine: View {
    let pausedUntil: String?

    var body: some View {
        if let pausedUntil, let date = RelativeTime.parse(pausedUntil) {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                if AccountPause.isPaused(pausedUntil, now: context.date) {
                    HStack(alignment: .firstTextBaseline) {
                        Label("Paused", systemImage: "pause.fill")
                            .font(.orbitLabel.weight(.semibold))
                        Spacer(minLength: 8)
                        Text("Until \(date.formatted(date: .abbreviated, time: .shortened))")
                            .font(.orbitMeta)
                            .multilineTextAlignment(.trailing)
                    }
                    .foregroundStyle(Color.orange)
                }
            }
        }
    }
}

/// How long to pause an account for, and the press that does it. Raised by the account's own
/// Pause… — a row's press, its swipe, or its long-press menu.
struct AccountPauseSheet: View {
    @Environment(\.dismiss) private var dismiss
    let name: String
    let scope: String
    let save: (Int?) async -> String?

    init(name: String, scope: String, save: @escaping (Int?) async -> String?) {
        self.name = name
        self.scope = scope
        self.save = save
    }

    @State private var hours = 2
    @State private var custom = false
    @State private var customHours = "2"
    @State private var saving = false
    @State private var failure: String?

    private var minutes: Int? { custom ? AccountPause.minutes(hours: customHours) : hours * 60 }
    private var confirmTitle: String {
        custom ? "Pause Account" : "Pause for \(hours) Hour\(hours == 1 ? "" : "s")"
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(name).font(.headline)
                    Text(scope).font(.orbitListSubtitle).foregroundStyle(.secondary)
                }
                Section("Pause for") {
                    Picker("Duration", selection: $hours) {
                        ForEach([1, 2, 4, 8], id: \.self) { Text("\($0)h").tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: hours) { _, _ in custom = false }
                    Toggle("Custom duration", isOn: $custom)
                    if custom {
                        TextField("Hours", text: $customHours)
                            #if os(iOS)
                            .keyboardType(.decimalPad)
                            #endif
                        Text("1 minute to 168 hours").font(.orbitMeta).foregroundStyle(.secondary)
                    }
                }
                Section {
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        if let minutes {
                            let resumes = context.date.addingTimeInterval(Double(minutes) * 60)
                            Label("Automatically resumes at \(resumes.formatted(date: .abbreviated, time: .shortened))",
                                  systemImage: "clock")
                                .font(.orbitListSubtitle)
                        }
                    }
                    Text("Skip this account for new turns. Any running turn will finish normally.")
                        .font(.orbitListSubtitle).foregroundStyle(.secondary)
                    if let failure {
                        Text(failure).font(.orbitLabel).foregroundStyle(Color.red)
                    }
                    Button(saving ? "Saving…" : confirmTitle) {
                        guard let minutes else { return }
                        saving = true
                        failure = nil
                        Task {
                            failure = await save(minutes)
                            saving = false
                            if failure == nil { dismiss() }
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    .disabled(minutes == nil || saving)
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Pause Account")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(saving)
                }
            }
            .disabled(saving)
            .interactiveDismissDisabled(saving)
        }
        #if os(macOS)
        .frame(minWidth: 440, minHeight: 440)
        #endif
        .presentationDetents([.medium, .large])
    }
}
