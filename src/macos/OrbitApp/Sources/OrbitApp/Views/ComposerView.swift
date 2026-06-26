import SwiftUI
import AppKit
import UniformTypeIdentifiers
import OrbitKit

struct ComposerView: View {
    @Bindable var console: ConsoleModel
    @State private var slashIndex = 0
    @State private var slashDismissed: String?
    @FocusState private var inputFocused: Bool

    // Show the `/` hint menu while the cursor sits on a `/token` that hasn't been Escape-dismissed.
    private var showSlash: Bool {
        guard let t = console.slashToken else { return false }
        return t != slashDismissed && !console.slashMatches.isEmpty
    }

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

            if showSlash { slashMenu }

            HStack(alignment: .bottom, spacing: 8) {
                addMenu

                Toggle(isOn: $console.shellMode) {
                    Image(systemName: "terminal")
                }
                .toggleStyle(.button)
                .help("Run as a shell command")

                TextField(console.shellMode ? "Shell command…" : "Message…",
                          text: $console.composerText, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...6)
                    .focused($inputFocused)
                    .onSubmit { onReturn() }
                    .onKeyPress(.upArrow) { moveSlash(-1) }
                    .onKeyPress(.downArrow) { moveSlash(1) }
                    .onKeyPress(.escape) {
                        guard showSlash else { return .ignored }
                        slashDismissed = console.slashToken
                        return .handled
                    }
                    .onChange(of: console.slashToken) { _, new in
                        slashIndex = 0
                        if new == nil { console.slashScope = nil }
                    }

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

    // MARK: + menu (mirrors the web composer's `+` dropdown)

    private var addMenu: some View {
        Menu {
            Button { console.openSlash(scope: "command") } label: {
                Label("Command", systemImage: "chevron.left.forwardslash.chevron.right")
            }
            .disabled(!console.hasCommands)
            Button { console.openSlash(scope: "skill") } label: {
                Label("Skill", systemImage: "bolt")
            }
            .disabled(!console.hasSkills)
            Button { console.shellMode = true } label: {
                Label("Shell", systemImage: "terminal")
            }
            Divider()
            Button { pickFiles(images: true) } label: { Label("Attach image", systemImage: "photo") }
            Button { pickFiles(images: false) } label: { Label("Upload file", systemImage: "paperclip") }
        } label: {
            Image(systemName: "plus")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Add a command, skill, shell command, or attachment")
    }

    // MARK: `/` autocomplete menu

    private var slashMenu: some View {
        let matches = console.slashMatches
        let highlightID = matches.indices.contains(slashIndex) ? matches[slashIndex].id : matches.first?.id
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(matches) { item in
                Button {
                    console.pickSlash(item.name)
                    slashDismissed = nil
                    inputFocused = true
                } label: {
                    HStack(spacing: 6) {
                        Text("/\(item.name)").font(.callout.monospaced())
                        Text(item.type == "skill" ? "skill" : "cmd")
                            .font(.caption2).foregroundStyle(.secondary)
                        if let d = item.description, !d.isEmpty {
                            Text(d).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(item.id == highlightID ? Color.accentColor.opacity(0.18) : .clear)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(4)
        .background(.background, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(.gray.opacity(0.25)))
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: keyboard + pickers

    private func onReturn() {
        if showSlash {
            let matches = console.slashMatches
            guard !matches.isEmpty else { return }
            console.pickSlash(matches[min(slashIndex, matches.count - 1)].name)
            slashDismissed = nil
        } else {
            Task { await console.send() }
        }
    }

    private func moveSlash(_ delta: Int) -> KeyPress.Result {
        guard showSlash else { return .ignored }
        let count = console.slashMatches.count
        guard count > 0 else { return .ignored }
        slashIndex = (min(slashIndex, count - 1) + delta + count) % count
        return .handled
    }

    private func pickFiles(images: Bool) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        if images { panel.allowedContentTypes = [.png, .jpeg, .webP, .gif] }
        guard panel.runModal() == .OK else { return }
        for url in panel.urls { Task { await console.attachFile(url: url) } }
    }
}
