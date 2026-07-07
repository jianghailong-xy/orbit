import SwiftUI
import UniformTypeIdentifiers
import OrbitKit
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
import PhotosUI
#endif

#if os(macOS)
/// Bridges the composer's live focus + current-session attach action to the long-lived ⌘V paste
/// monitor. A monitor closure captures its values once at install, but the `console` swaps under
/// this view when the user switches sessions (ConsoleView carries no `.id`), so the monitor reads
/// the *current* console through this reference instead of a stale captured one. macOS-only: the
/// ⌘V key monitor is an AppKit `NSEvent` API; iOS paste is Phase D.
private final class ComposerPasteState {
    var focused = false
    var attach: ((Data) -> Void)?
}
#endif

struct ComposerView: View {
    @Environment(AppModel.self) private var app
    @Bindable var console: ConsoleModel
    /// Focus the field as soon as it appears — used by the draft "new session" composer, where the
    /// user came here to type. A live console leaves it false so opening a session doesn't grab focus.
    var autoFocus = false
    @State private var slashIndex = 0
    @State private var slashDismissed: String?
    @FocusState private var inputFocused: Bool
    #if os(macOS)
    @State private var pasteMonitor: Any?
    @State private var pasteState = ComposerPasteState()
    #endif
    #if os(iOS)
    @State private var showPhotoPicker = false
    @State private var showFileImporter = false
    @State private var pickedPhotos: [PhotosPickerItem] = []
    #endif

    // The composer bar is pinned to the screen bottom, so iOS opens this Menu upward and presents
    // its items in reverse. Feed the list reversed on iOS so it reads top-to-bottom (Fable → Haiku)
    // exactly like the web composer. macOS drops the menu down, so keep the source order there.
    private var modelMenuItems: [ModelOption] {
        #if os(iOS)
        Array(AgentDefaults.models.reversed())
        #else
        AgentDefaults.models
        #endif
    }

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
                        .font(.orbitLabel).lineLimit(1)
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
            HStack(alignment: .center, spacing: 6) {
                addMenu

                TextField(placeholder, text: $console.composerText, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(.orbitControl)
                    .lineLimit(1...6)
                    // Fill the available width; vertical centering comes from the HStack's .center
                    // alignment, so the placeholder, the + and the send button all sit on one
                    // centerline. The box hugs the content height (no forced minHeight that would
                    // strand the text at the top).
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .focused($inputFocused)
                    .onSubmit { onReturn() }
                    .onKeyPress(.upArrow) { moveSlash(-1) }
                    .onKeyPress(.downArrow) { moveSlash(1) }
                    .onKeyPress(.escape) {
                        if showSlash {
                            slashDismissed = console.slashToken
                            return .handled
                        }
                        // No slash menu open: blur the field and hand ↑/↓ back to the session list,
                        // so the user can keep switching sessions from the keyboard without having to
                        // click the list first.
                        inputFocused = false
                        app.focusSessionList()
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

                // Show the stop button off the session's AUTHORITATIVE status (the live control-plane
                // record the nav-bar title reads), NOT the stream-derived `console.state.status`:
                // opening an already-running session never replays a "running" event into the
                // reducer, so the stream status stays stale and the button would never appear. Web
                // parity — its `showStop` keys off `selected?.status === 'RUNNING'`.
                if ComposerLogic.showsInterrupt(session: app.session(id: console.sessionID)?.status,
                                                stream: console.state.status) {
                    Button { Task { await console.interrupt() } } label: {
                        Image(systemName: "stop.fill")
                            .font(sendGlyphFont)
                    }
                    .buttonStyle(.plain)
                    .help("Interrupt the current turn")
                }
                Button { Task { await console.send() } } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(sendGlyphFont)
                        .foregroundStyle(console.canSend ? Color.accentColor : Color.secondary)
                }
                .buttonStyle(.plain)
                .disabled(!console.canSend)
            }
            .padding(.vertical, 9)
            .padding(.horizontal, 12)
            // Elevated, softly-rounded surface so the field reads as a premium floating card
            // rather than a hairline box: a `.continuous` (squircle) curve, an own fill, and a
            // soft drop shadow. Focus deepens the border toward the accent and lifts the shadow
            // a touch instead of flipping to a hard blue outline.
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color.editorSurface)
                    .shadow(color: .black.opacity(inputFocused ? 0.12 : 0.06),
                            radius: inputFocused ? 7 : 4, y: 1.5)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(Color.primary.opacity(inputFocused ? 0.22 : 0.10), lineWidth: 1)
            }
            .animation(.easeOut(duration: 0.15), value: inputFocused)

            // Footer controls, laid out like the web composer: permission mode on the left,
            // then the agent identity · model · effort · plan-usage cluster on the right. Each
            // control is a borderless "text · chevron" menu (web parity, like the reference
            // composer's "Auto") rather than a macOS bordered popup button. A change on a live
            // session is pushed immediately in the menu action (applyConfig → PATCH /config);
            // doing it there instead of via .onChange means a server config sync writing these
            // values back doesn't echo a redundant PATCH.
            HStack(spacing: 10) {
                Menu {
                    ForEach(AgentDefaults.permissionModes, id: \.self) { mode in
                        Button {
                            console.permissionMode = mode
                            Task { await console.applyConfig(permissionMode: mode.rawValue) }
                        } label: {
                            menuItemLabel(AgentDefaults.label(mode), selected: mode == console.permissionMode)
                        }
                    }
                } label: {
                    menuLabel(AgentDefaults.label(console.permissionMode))
                }
                .borderlessMenuStyle().menuIndicator(.hidden).fixedSize()

                Spacer()

                if let name = console.agentName {
                    Text(name).foregroundStyle(.secondary).lineLimit(1)
                }

                Menu {
                    ForEach(modelMenuItems) { m in
                        Button {
                            console.modelID = m.id
                            Task { await console.applyConfig(model: m.id) }
                        } label: {
                            menuItemLabel(m.name, selected: m.id == console.modelID)
                        }
                    }
                } label: {
                    menuLabel(AgentDefaults.models.first { $0.id == console.modelID }?.name ?? console.modelID)
                }
                .borderlessMenuStyle().menuIndicator(.hidden).fixedSize()

                Menu {
                    ForEach(Effort.allCases) { e in
                        Button {
                            console.effort = e
                            Task { await console.applyConfig(effort: e.rawValue) }
                            // Remember this as the account default so the next new session (here or
                            // on web) starts at it — the cross-device port of web's localStorage write.
                            app.rememberDefaultEffort(e.rawValue)
                        } label: {
                            menuItemLabel(e.label, selected: e == console.effort)
                        }
                    }
                } label: {
                    menuLabel(console.effort.label)
                }
                .borderlessMenuStyle().menuIndicator(.hidden).fixedSize()

                if let usage = console.planUsage {
                    PlanUsageIndicator(usage: usage)
                }
            }
            // Footer pickers are tappable controls, not metadata — list-subtitle size on iOS (15pt)
            // for comfortable targets; macOS keeps the dense web-parity caption.
            .font(.orbitListSubtitle)
        }
        .padding(10)
        .background(.bar)
        // A focused field editor consumes ⌘V before any SwiftUI .onPasteCommand fires, so intercept
        // the keystroke here: when the composer is focused and the clipboard holds an image, attach
        // it (web parity) and swallow the paste; anything else falls through to normal text paste.
        .onAppear {
            if autoFocus { inputFocused = true }
            #if os(macOS)
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
            #endif
        }
        #if os(macOS)
        .onDisappear {
            if let monitor = pasteMonitor { NSEvent.removeMonitor(monitor); pasteMonitor = nil }
        }
        .onChange(of: inputFocused) { _, focused in pasteState.focused = focused }
        // Rebind the attach action to the *current* console — it swaps under this view on a session
        // switch; `initial` seeds it on first appearance.
        .onChange(of: console.sessionID, initial: true) { _, _ in
            pasteState.attach = { png in Task { @MainActor in await console.attachPastedImage(pngData: png) } }
        }
        #endif
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
            Button {
                #if os(iOS)
                showPhotoPicker = true
                #else
                pickFiles(images: true)
                #endif
            } label: { Label("Attach image", systemImage: "photo") }
            Button {
                #if os(iOS)
                showFileImporter = true
                #else
                pickFiles(images: false)
                #endif
            } label: { Label("Upload file", systemImage: "paperclip") }
        } label: {
            Image(systemName: "plus")
                .font(.orbitGlyph)
                .foregroundStyle(.secondary)
                #if os(iOS)
                // The bare 15pt glyph gives a tap target far under the 44pt HIG minimum, and the
                // Menu's `.fixedSize()` hugs it. On touch, give it a 26×34 hit area with the whole
                // rect tappable and the glyph centered — so it reads as a padded target with even
                // spacing, not a flush-left icon with a lopsided gap before the field. Height matches
                // the send glyph's row so the composer box doesn't grow taller. macOS (pointer input)
                // keeps the tight glyph.
                .frame(width: 26, height: 34)
                .contentShape(Rectangle())
                #endif
        }
        .borderlessMenuStyle()
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Add a command, skill, shell command, or attachment")
        #if os(iOS)
        .photosPicker(isPresented: $showPhotoPicker, selection: $pickedPhotos,
                      maxSelectionCount: 5, matching: .images)
        .onChange(of: pickedPhotos) { _, items in
            guard !items.isEmpty else { return }
            Task { await attachPhotos(items); pickedPhotos = [] }
        }
        .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.item],
                      allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { Task { await attachFiles(urls) } }
        }
        #endif
    }

    // MARK: borderless footer menus (mirror the web composer's plain dropdowns)

    /// The "text · chevron" trigger for a footer menu, styled like the reference composer's "Auto"
    /// instead of macOS's default bordered popup button.
    private func menuLabel(_ text: String) -> some View {
        HStack(spacing: 3) {
            Text(text).lineLimit(1)
            Image(systemName: "chevron.up.chevron.down")
                .font(.orbitMeta)
                .foregroundStyle(.tertiary)
        }
        .foregroundStyle(.secondary)
        .contentShape(Rectangle())
    }

    /// A menu row with a leading checkmark on the current selection — a Picker draws this for free,
    /// a Menu of Buttons has to render it explicitly.
    @ViewBuilder
    private func menuItemLabel(_ text: String, selected: Bool) -> some View {
        if selected { Label(text, systemImage: "checkmark") } else { Text(text) }
    }

    // MARK: staged attachment chips (mirror the web composer's image thumbnails / file chips)

    @ViewBuilder
    private func attachmentChip(_ att: PendingAttachment) -> some View {
        if let data = att.previewImageData, let image = PlatformImage(data: data) {
            // Inline image: a 48×48 thumbnail with a corner remove button (web's .composer-attach).
            Image(platformImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: 48, height: 48)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(.primary.opacity(0.08)) }
                // iOS: tap the staged thumbnail to open the full-screen viewer before sending
                // (the tiny 48² chip is hard to read otherwise). Preview the full-resolution bytes
                // seeded in the shared store at attach time — the same source the sent bubble uses —
                // not the downsampled `previewImageData`, so the viewer looks identical to the bubble.
                // The remove button is overlaid *after* this, so it stays on top and its taps aren't
                // captured by the preview.
                .modifier(ComposerImageTap(image: console.attachments.image(for: att.id) ?? image))
                .overlay(alignment: .topTrailing) {
                    Button { console.removeAttachment(att) } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.orbitMeta)
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
            .font(.orbitLabel)
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
                            .font(.orbitMeta).foregroundStyle(.secondary)
                        if let d = item.description, !d.isEmpty {
                            Text(d).font(.orbitLabel).foregroundStyle(.secondary).lineLimit(1)
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
        #if os(macOS)
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        if images { panel.allowedContentTypes = [.png, .jpeg, .webP, .gif] }
        guard panel.runModal() == .OK else { return }
        for url in panel.urls { Task { await console.attachFile(url: url) } }
        #endif
        // iOS uses the SwiftUI `.photosPicker` / `.fileImporter` on the + menu (see addMenu) rather
        // than an imperative panel — the pick is handled by attachPhotos / attachFiles below.
    }

    #if os(iOS)
    /// Photos-library picks: PhotosUI hands back the original bytes (often HEIC/JPEG); normalize to
    /// PNG — one of the server's inline-image types — before uploading via the shared attach path.
    private func attachPhotos(_ items: [PhotosPickerItem]) async {
        for item in items {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            let png = PlatformImage(data: data)?.orbitPNGData() ?? data
            await console.attach(filename: "photo.png", mimeType: "image/png", data: png)
        }
    }

    /// Document-picker files: the URLs are security-scoped, so hold access across the read that
    /// `attachFile` does (it derives the MIME from the extension and enforces the size cap).
    private func attachFiles(_ urls: [URL]) async {
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            await console.attachFile(url: url)
            if scoped { url.stopAccessingSecurityScopedResource() }
        }
    }
    #endif
}

/// iOS: make a staged composer image thumbnail tappable to open the shared full-screen viewer
/// (`FullScreenImageView` from ConsoleView) — parity with the sent-message thumbnails and web's
/// tap-to-preview. macOS: no-op, matching the transcript thumbnails there.
private struct ComposerImageTap: ViewModifier {
    let image: PlatformImage
    #if os(iOS)
    @State private var preview = false
    #endif

    func body(content: Content) -> some View {
        #if os(iOS)
        content
            .contentShape(Rectangle())
            .onTapGesture { preview = true }
            .fullScreenCover(isPresented: $preview) { FullScreenImageView(image: image) }
        #else
        content
        #endif
    }
}

/// Compact plan-usage pill for the composer footer (mirrors web's PlanUsageIndicator): a mini
/// 5-hour bar + percent; tapping opens the per-window detail, like `/usage`.
private struct PlanUsageIndicator: View {
    let usage: PlanUsageSnapshot
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
            .modifier(PlanUsageDetailPresentation(isPresented: $showDetail, usage: usage))
        }
    }
}

/// Presents the plan-usage detail per platform. macOS gets a tight anchored popover sized to its
/// content. iOS gets a fitted bottom sheet — a bare `.popover` there auto-promotes to a full-screen
/// modal that strands two short rows mid-screen, so we show a proper sheet: a grabber, a top-anchored
/// title with Done, and a detent sized to the row count so there's no wasted space.
private struct PlanUsageDetailPresentation: ViewModifier {
    @Binding var isPresented: Bool
    let usage: PlanUsageSnapshot

    func body(content: Content) -> some View {
        #if os(macOS)
        content.popover(isPresented: $isPresented, arrowEdge: .top) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Plan usage").font(.headline)
                PlanUsageDetailRows(rows: usage.rows, compact: true)
            }
            .padding(14)
            .frame(width: 260)
        }
        #else
        content.sheet(isPresented: $isPresented) {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("Plan usage").font(.title3.weight(.semibold))
                    Spacer()
                    Button("Done") { isPresented = false }
                }
                .padding(.bottom, 16)
                PlanUsageDetailRows(rows: usage.rows)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 20)
            .padding(.top, 24)
            .padding(.bottom, 20)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .presentationDetents([.height(CGFloat(120 + usage.rows.count * 66))])
            .presentationDragIndicator(.visible)
        }
        #endif
    }
}

/// The per-window rows shared by the macOS popover and the iOS sheet. `compact` shrinks the type and
/// bar for the tight popover; the iOS sheet uses the roomier, touch-friendly sizing.
private struct PlanUsageDetailRows: View {
    let rows: [PlanUsageRow]
    var compact: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 12 : 18) {
            ForEach(rows) { row in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(row.label)
                        Spacer()
                        Text("\(row.percent)%").foregroundStyle(.secondary)
                    }
                    .font(compact ? .caption : .subheadline)
                    UsageBar(percent: row.percent).frame(height: compact ? 5 : 8)
                    if let reset = row.window.resetsAt.flatMap(formatReset) {
                        Text("Resets \(reset)")
                            .font(compact ? .caption2 : .caption)
                            .foregroundStyle(.tertiary)
                    }
                }
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

// The send/stop glyph is the composer's primary action, so on iOS it's sized up to read as the CTA
// against the smaller, secondary `+`. macOS keeps the tighter `.title2` — the desktop bar stays compact.
#if os(iOS)
private let sendGlyphFont: Font = .title
#else
private let sendGlyphFont: Font = .title2
#endif
