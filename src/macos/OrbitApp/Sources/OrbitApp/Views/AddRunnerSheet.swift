import SwiftUI
import OrbitKit

// Add Runner (ios-detail.png ⑨): a new machine from the phone. The one command that installs a runner
// — the web's RunnerRegisterGuide, built from this instance's own origin — to copy or share over to
// that machine; then a wait on the runner list, as the web's guide waits, until a runner that wasn't
// online comes online, and a way straight to it. Under that, for a machine with no browser: the code
// `orbit register` prints there, looked up so its name and hostname show before it is approved from
// here (the web's /enroll page, the same two routes).

struct AddRunnerSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var platform = RunnerPageFormat.Platform.macOS
    @State private var copied = false
    /// The runners online when the wait began; nil until the list has been read once.
    @State private var baseline: Set<String>?
    /// The first runner to come online since — latched, like the web guide's.
    @State private var arrived: Runner?

    @State private var code = ""
    /// The code the machine below was looked up by.
    @State private var lookedUp: String?
    @State private var device: DeviceInfo?
    @State private var looking = false
    @State private var approving = false
    @State private var approved = false
    /// Why the last lookup or approval didn't go through (`APIClient.failureReason`).
    @State private var message: String?

    var body: some View {
        NavigationStack {
            Form {
                commandSection
                waitSection
                deviceSection
            }
            .formStyle(.grouped)
            .orbitRevealSurface()   // macOS: reveal the unified `orbitSurface` behind the grouped form
            .navigationTitle(RunnerPageCopy.RUNNER_ADD)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Close")
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 460, idealWidth: 500, minHeight: 560, idealHeight: 640)
        #endif
        .task { await wait() }
        .onChange(of: code) { _, typed in
            // The whole code is in: read it, once — lookups are rate-limited per account.
            guard let complete = RunnerPageFormat.deviceCode(typed), complete != lookedUp else { return }
            lookUp(complete)
        }
    }

    // MARK: sections

    /// What to run on the new machine, for the platform it is.
    private var commandSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 16) {
                Text(RunnerPageCopy.RUNNER_ADD_LEAD)
                    .fixedSize(horizontal: false, vertical: true)
                Picker(RunnerPageCopy.RUNNER_ADD, selection: $platform) {
                    ForEach(RunnerPageFormat.Platform.allCases) { platform in
                        Text(platform.label).tag(platform)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                commandBox
            }
            .padding(.vertical, 4)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
        }
    }

    /// The command on a dark card, with Copy and Share (to the machine it has to be typed on).
    private var commandBox: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(promptedCommand)
                .font(.orbitMono)
                .foregroundStyle(Color.white)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Button(action: copyCommand) {
                    Label(copied ? "Copied" : RunnerPageCopy.RUNNER_COPY,
                          systemImage: copied ? "checkmark" : "doc.on.doc")
                        .modifier(RunnerCommandButton())
                }
                .buttonStyle(.plain)
                SwiftUI.ShareLink(item: command) {
                    Label(RunnerPageCopy.RUNNER_SHARE, systemImage: "square.and.arrow.up")
                        .modifier(RunnerCommandButton())
                }
                .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Color(white: 0.11), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    /// Waiting for the new runner — or the one that came.
    @ViewBuilder private var waitSection: some View {
        Section {
            if let arrived {
                HStack(spacing: 10) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(RunnerInk.green)
                    Text("Runner online — “\(RunnerPageFormat.displayName(arrived))” is ready")
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    Button("Open") { open(arrived) }
                        .buttonStyle(.borderedProminent)
                        .buttonBorderShape(.capsule)
                        .controlSize(.small)
                }
            } else {
                HStack(spacing: 10) {
                    ProgressView()
                        .controlSize(.small)
                    Text(RunnerPageCopy.RUNNER_WAITING_FOR_NEW)
                }
            }
        }
    }

    /// A machine with no browser: its code, what it asked to register as, and Approve.
    @ViewBuilder private var deviceSection: some View {
        Section {
            LabeledContent(RunnerPageCopy.RUNNER_DEVICE_CODE) {
                TextField(RunnerPageCopy.RUNNER_DEVICE_CODE_PLACEHOLDER, text: $code)
                    .font(.orbitMono)
                    .multilineTextAlignment(.trailing)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.characters)
                    #endif
                    .submitLabel(.go)
                    .onSubmit(submitCode)
            }
            if looking {
                ProgressView()
                    .controlSize(.small)
            }
            if let device {
                deviceRows(device)
            }
            if let message {
                Text(message)
                    .font(.orbitLabel)
                    .foregroundStyle(RunnerInk.red)
            }
        } header: {
            RunnerSectionHeader(RunnerPageCopy.RUNNER_NO_BROWSER)
        } footer: {
            Text(runnerStyledText(RunnerPageCopy.RUNNER_DEVICE_CODE_FOOTER, code: ["orbit register"]))
        }
    }

    /// The machine a code belongs to — its name, and its hostname when that says something else — and
    /// the press that registers it (the web's /enroll page, in its words).
    @ViewBuilder private func deviceRows(_ device: DeviceInfo) -> some View {
        let name = device.name ?? ""
        LabeledContent("Runner", value: name)
        if let host = device.hostname, !host.isEmpty, host != name {
            LabeledContent(RunnerPageCopy.RUNNER_ABOUT_HOSTNAME, value: host)
        }
        if let labels = device.labels, !labels.isEmpty {
            LabeledContent("Labels", value: labels.joined(separator: ", "))
        }
        if approved {
            Label("“\(name)” is now registered. Return to your terminal — it will continue automatically.",
                  systemImage: "checkmark.circle.fill")
                .foregroundStyle(RunnerInk.green)
        } else {
            if device.nameConflict == true {
                VStack(alignment: .leading, spacing: 3) {
                    Text("This runner (“\(name)”) is already registered on your account.")
                        .font(.orbitListSubtitle.weight(.semibold))
                    Text("Approving re-issues its credential. The old credential stops working; no duplicate runner is created.")
                        .font(.orbitLabel)
                }
                .foregroundStyle(RunnerInk.amber)
            }
            Button(role: device.nameConflict == true ? .destructive : nil) {
                approve()
            } label: {
                Text(device.nameConflict == true ? "Re-register machine" : RunnerPageCopy.RUNNER_APPROVE)
            }
            .disabled(approving)
        }
    }

    // MARK: the wait

    private var command: String {
        RunnerPageFormat.installCommand(platform, origin: model.baseURL.map(RunnerPageFormat.origin) ?? "")
    }

    /// `$ curl -fsSL …`, the prompt drawn dim.
    private var promptedCommand: AttributedString {
        typealias Colour = AttributeScopes.SwiftUIAttributes.ForegroundColorAttribute
        var line = AttributedString("$ ")
        line[Colour.self] = Color.gray
        line += AttributedString(command)
        return line
    }

    /// Read the runner list every 5s — the web guide's pace — until a runner that wasn't online when
    /// the sheet opened comes online. The list the sheet opened over is the baseline when it has been
    /// read; otherwise the first read that succeeds is.
    private func wait() async {
        guard let runners = model.runners else { return }
        if runners.loadState.hasLoaded { baseline = RunnerPageFormat.onlineIDs(runners.runners) }
        while !Task.isCancelled {
            await runners.load()
            if let baseline {
                if arrived == nil {
                    arrived = RunnerPageFormat.newlyOnline(runners.runners, baseline: baseline)
                }
            } else if runners.loadState.hasLoaded, !runners.loadState.lastLoadFailed {
                baseline = RunnerPageFormat.onlineIDs(runners.runners)
            }
            try? await Task.sleep(for: .seconds(5))
        }
    }

    // MARK: presses

    private func copyCommand() {
        PlatformPasteboard.copyString(command)
        PlatformHaptics.success()
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(1.6))
            copied = false
        }
    }

    /// Return on a code that isn't all there yet reads it as typed; the server says if it's wrong.
    private func submitCode() {
        let typed = code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard !typed.isEmpty else { return }
        lookUp(RunnerPageFormat.deviceCode(typed) ?? typed)
    }

    private func lookUp(_ userCode: String) {
        guard let runners = model.runners else { return }
        lookedUp = userCode
        device = nil
        approved = false
        message = nil
        looking = true
        Task {
            let result = await runners.device(userCode)
            looking = false
            guard lookedUp == userCode else { return }
            switch result {
            case .success(let info):
                device = info
                approved = info.status == "APPROVED"
            case .failure(let failure):
                message = failure.reason
            }
        }
    }

    private func approve() {
        guard let runners = model.runners, let userCode = lookedUp else { return }
        approving = true
        message = nil
        Task {
            let failure = await runners.approveDevice(userCode)
            approving = false
            if let failure {
                message = failure
            } else {
                approved = true
            }
        }
    }

    /// The new runner's page, on the stack the sheet was opened over.
    private func open(_ runner: Runner) {
        dismiss()
        model.push(.runnerDetail(runnerID: runner.id))
    }
}

/// Copy and Share on the command's dark card: white on a lighter wash.
private struct RunnerCommandButton: ViewModifier {
    func body(content: Content) -> some View {
        content
            .font(.orbitListSubtitle.weight(.semibold))
            .foregroundStyle(Color.white)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(Color.white.opacity(0.14), in: Capsule())
    }
}
