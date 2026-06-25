import SwiftUI
import OrbitKit

struct ComposerView: View {
    @Bindable var console: ConsoleModel

    var body: some View {
        VStack(spacing: 6) {
            if !console.pendingAttachments.isEmpty {
                HStack {
                    ForEach(console.pendingAttachments) { att in
                        HStack(spacing: 4) {
                            Image(systemName: "paperclip")
                            Text(att.filename).lineLimit(1)
                            Button { console.removeAttachment(att) } label: { Image(systemName: "xmark.circle.fill") }
                                .buttonStyle(.plain).foregroundStyle(.secondary)
                        }
                        .font(.caption)
                        .padding(.horizontal, 6).padding(.vertical, 3)
                        .background(.gray.opacity(0.12), in: Capsule())
                    }
                    Spacer()
                }
            }

            HStack(alignment: .bottom, spacing: 8) {
                Toggle(isOn: $console.shellMode) {
                    Image(systemName: "terminal")
                }
                .toggleStyle(.button)
                .help("Run as a shell command")

                TextField(console.shellMode ? "Shell command…" : "Message…",
                          text: $console.composerText, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...6)
                    .onSubmit { Task { await console.send() } }

                if console.state.status == .running {
                    Button { Task { await console.interrupt() } } label: {
                        Image(systemName: "stop.fill")
                    }
                    .help("Interrupt the current turn")
                }
                Button { Task { await console.send() } } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.title2)
                }
                .buttonStyle(.plain)
                .disabled(!console.canSend)
            }

            HStack(spacing: 8) {
                Picker("", selection: $console.modelID) {
                    ForEach(AgentDefaults.models) { Text($0.name).tag($0.id) }
                }
                .labelsHidden().fixedSize()

                Picker("", selection: $console.permissionMode) {
                    ForEach(AgentDefaults.permissionModes, id: \.self) { Text(AgentDefaults.label($0)).tag($0) }
                }
                .labelsHidden().fixedSize()

                Spacer()
                if console.availability == .queue {
                    Label("Will queue", systemImage: "tray.and.arrow.down")
                        .foregroundStyle(.secondary)
                }
            }
            .font(.caption)
        }
        .padding(10)
        .background(.bar)
    }
}
