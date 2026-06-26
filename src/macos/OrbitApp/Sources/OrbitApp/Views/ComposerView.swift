import SwiftUI
import AppKit
import UniformTypeIdentifiers
import OrbitKit

/// Bridges the composer's live focus + current-session attach action to the long-lived ⌘V paste
/// monitor. A monitor closure captures its values once at install, but the `console` swaps under
/// this view when the user switches sessions (ConsoleView carries no `.id`), so the monitor reads
/// the *current* console through this reference instead of a stale captured one.
private final class ComposerPasteState {
    var focused = false
    var attach: ((Data) -> Void)?
}

struct ComposerView: View {
    @Bindable var console: ConsoleModel
    @State private var slashIndex = 0
    @State private var slashDismissed: String?
    @FocusState private var inputFocused: Bool
    @State private var pasteMonitor: Any?
    @State private var pasteState = ComposerPasteState()

    // Show the `/` hint menu while the cursor sits on a `/token` that hasn't been Escape-dismissed.
    private var showSlash: Bool {
        guard let t = console.slashToken else { return false }
        return t != slashDismissed && !console.slashMatches.isEmpty
    }

    private var placeholder: String {
        console.replyContext != nil ? "Type your reply to Claude…" : "Message…"
    }

    var body: some View {
        VStack(spacing: 6) {
            if let reply = console.replyContext {
                HStack(spacing: 6) {
                    Image(systemName: "bubble.left.and.bubble.right.fill").foregroundStyle(.blue)
                    Text(reply.question.isEmpty ? "Replying to Claude’s question"
                                                : "Replying to Claude’s question: \(reply.question)")
                        .font(.caption).lineLimit(1)
                    Spacer()
                    Button { console.cancelChatReply() } label: { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.plain).foregroundStyle(.secondary)
                }
                .padding(.horizontal, 8).padding(.vertical, 4)
                .background(.blue.opacity(0.1), in: Capsule())
            }

            if !console.pendingAttachments.isEmpty {
                HStack(alignment: .top, spacing: 8) {
                    ForEach(console.pendingAttachments) { attachmentChip($0) }
                    Spacer(minLength: 0)
                }
            }

            if showSlash { slashMenu }

            // One rounded box wrapping the + menu, the growing field, and send — mirrors the web
            // composer's single bordered `.composer-box` instead of three separate controls. Shell
            // mode is reached by a `!` prefix (the + menu's Shell item inserts it), not a toggle.
            HStack(alignment: .bottom, spacing: 6) {
                addMenu

                TextField(placeholder, text: $console.composerText, axis: .vertical)
                    .textFieldStyle(.plain)
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
                    .onChange(of: console.replyContext) { if console.replyContext != nil { inputFocused = true } }
                    // Clamp input length: an oversized prompt freezes SwiftUI's synchronous
                    // text layout. Pasting past the cap truncates; big content is a file upload.
                    .onChange(of: console.composerText) { _, text in
                        if text.count > ComposerLogic.maxPromptChars {
                            console.composerText = String(text.prefix(ComposerLogic.maxPromptChars))
                        }
                    }

                if console.state.status == .running {
                    Button { Task { await console.interrupt() } } label: {
                        Image(systemName: "stop.fill")
                    }
                    .buttonStyle(.plain)
                    .help("Interrupt the current turn")
                }
                Button { Task { await console.send() } } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.title2)
                }
                .buttonStyle(.plain)
                .disabled(!console.canSend)
            }
            .padding(.vertical, 5)
            .padding(.horizontal, 8)
            .overlay {
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(inputFocused ? Color.accentColor : Color.secondary.opacity(0.35),
                                  lineWidth: 1)
            }

            // Footer controls, laid out like the web composer: permission mode on the left,
            // then the agent identity · model · effort · plan-usage cluster on the right. A
            // change on a live session is pushed immediately (applyConfig → PATCH /config).
            HStack(spacing: 8) {
                Picker("", selection: $console.permissionMode) {
                    ForEach(AgentDefaults.permissionModes, id: \.self) { Text(AgentDefaults.label($0)).tag($0) }
                }
                .labelsHidden().fixedSize()
                .onChange(of: console.permissionMode) { _, m in
                    Task { await console.applyConfig(permissionMode: m.rawValue) }
                }

                if console.availability == .queue {
                    Label("Will queue", systemImage: "tray.and.arrow.down")
                        .foregroundStyle(.secondary)
                }

                Spacer()

                if let name = console.agentName {
                    Text(name).foregroundStyle(.secondary).lineLimit(1)
                }

                Picker("", selection: $console.modelID) {
                    ForEach(AgentDefaults.models) { Text($0.name).tag($0.id) }
                }
                .labelsHidden().fixedSize()
                .onChange(of: console.modelID) { _, m in
                    Task { await console.applyConfig(model: m) }
                }

                Picker("", selection: $console.effort) {
                    ForEach(Effort.allCases) { Text($0.label).tag($0) }
                }
                .labelsHidden().fixedSize()
                .onChange(of: console.effort) { _, e in
                    Task { await console.applyConfig(effort: e.rawValue) }
                }

                if let usage = console.planUsage {
                    PlanUsageIndicator(usage: usage)
                }
            }
            .font(.caption)
        }
        .padding(10)
        .background(.bar)
        // A focused field editor consumes ⌘V before any SwiftUI .onPasteCommand fires, so intercept
        // the keystroke here: when the composer is focused and the clipboard holds an image, attach
        // it (web parity) and swallow the paste; anything else falls through to normal text paste.
        .onAppear {
            guard pasteMonitor == nil else { return }
            pasteMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
                guard pasteState.focused,
                      event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
                      event.charactersIgnoringModifiers?.lowercased() == "v",
                      let attach = pasteState.attach,
                      NSPasteboard.general.canReadObject(forClasses: [NSImage.self], options: nil),
                      let image = NSImage(pasteboard: NSPasteboard.general),
                      let png = image.orbitPNGData()
                else { return event }
                attach(png)
                return nil
            }
        }
        .onDisappear {
            if let monitor = pasteMonitor { NSEvent.removeMonitor(monitor); pasteMonitor = nil }
        }
        .onChange(of: inputFocused) { _, focused in pasteState.focused = focused }
        // Rebind the attach action to the *current* console — it swaps under this view on a session
        // switch; `initial` seeds it on first appearance.
        .onChange(of: console.sessionID, initial: true) { _, _ in
            pasteState.attach = { png in Task { @MainActor in await console.attachPastedImage(pngData: png) } }
        }
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
            Button { console.insertShell() } label: {
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

    // MARK: staged attachment chips (mirror the web composer's image thumbnails / file chips)

    @ViewBuilder
    private func attachmentChip(_ att: PendingAttachment) -> some View {
        if let data = att.previewImageData, let image = NSImage(data: data) {
            // Inline image: a 48×48 thumbnail with a corner remove button (web's .composer-attach).
            Image(nsImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: 48, height: 48)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(.primary.opacity(0.08)) }
                .overlay(alignment: .topTrailing) {
                    Button { console.removeAttachment(att) } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.caption2)
                            .foregroundStyle(.white, .black.opacity(0.55))
                    }
                    .buttonStyle(.plain)
                    .padding(2)
                    .help("Remove image")
                }
        } else {
            // Other file: a name + size chip (web's .composer-file).
            HStack(spacing: 6) {
                Image(systemName: "paperclip").foregroundStyle(.secondary)
                Text(att.filename).lineLimit(1).truncationMode(.middle)
                Text(byteString(att.byteCount)).foregroundStyle(.secondary)
                Button { console.removeAttachment(att) } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help("Remove file")
            }
            .font(.caption)
            .padding(.vertical, 4).padding(.horizontal, 8)
            .frame(maxWidth: 220, alignment: .leading)
            .background(.gray.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
        }
    }

    private func byteString(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
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

private extension NSImage {
    /// Re-encode to PNG. The clipboard commonly carries TIFF (or JPEG), neither of which the
    /// server accepts as an inline image; PNG is in `Attachments.allowedImageTypes`.
    func orbitPNGData() -> Data? {
        guard let tiff = tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return rep.representation(using: .png, properties: [:])
    }
}

/// Compact plan-usage pill for the composer footer (mirrors web's PlanUsageIndicator): a mini
/// 5-hour bar + percent; tapping opens a popover with every subscription window, like `/usage`.
private struct PlanUsageIndicator: View {
    let usage: PlanUsage
    @State private var showDetail = false

    var body: some View {
        if let pct = usage.primaryPercent {
            Button { showDetail.toggle() } label: {
                HStack(spacing: 5) {
                    UsageBar(percent: pct).frame(width: 26, height: 4)
                    Text("\(pct)%").foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)
            .help("Plan usage \(pct)%")
            .popover(isPresented: $showDetail, arrowEdge: .top) {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Plan usage").font(.headline)
                    ForEach(usage.rows) { row in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(row.label)
                                Spacer()
                                Text("\(row.percent)%").foregroundStyle(.secondary)
                            }
                            .font(.caption)
                            UsageBar(percent: row.percent).frame(height: 5)
                            if let reset = row.window.resetsAt.flatMap(formatReset) {
                                Text("Resets \(reset)").font(.caption2).foregroundStyle(.tertiary)
                            }
                        }
                    }
                }
                .padding(14)
                .frame(width: 260)
            }
        }
    }
}

/// A horizontal utilization gauge that fills its frame; turns amber past 90% (like the web bar).
private struct UsageBar: View {
    let percent: Int
    private var fraction: CGFloat { CGFloat(min(100, max(0, percent))) / 100 }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(.quaternary)
                Capsule().fill(percent >= 90 ? Color.orange : Color.accentColor)
                    .frame(width: geo.size.width * fraction)
            }
        }
    }
}

/// Best-effort format of an ISO-8601 reset timestamp → "Jun 26, 10:00 AM"; raw string on failure.
private func formatReset(_ iso: String) -> String? {
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    var date = parser.date(from: iso)
    if date == nil {   // some payloads omit fractional seconds
        parser.formatOptions = [.withInternetDateTime]
        date = parser.date(from: iso)
    }
    guard let date else { return iso }
    let out = DateFormatter()
    out.dateFormat = "MMM d, h:mm a"
    return out.string(from: date)
}
