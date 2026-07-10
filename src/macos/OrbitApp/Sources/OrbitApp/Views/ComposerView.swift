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
    #if os(macOS)
    @FocusState private var inputFocused: Bool
    @State private var pasteMonitor: Any?
    @State private var pasteState = ComposerPasteState()
    #endif
    #if os(iOS)
    // The iOS editor is a UITextView (GrowingTextEditor), not a @FocusState-bound SwiftUI field, so
    // its first-responder state rides this flag: set it to focus, read it for the box's focus ring.
    @State private var iosEditing = false
    @State private var showPhotoPicker = false
    @State private var showFileImporter = false
    @State private var pickedPhotos: [PhotosPickerItem] = []
    #endif

    // The composer bar is pinned to the screen bottom, so iOS opens this Menu upward and presents
    // its items in reverse. Feed the list reversed on iOS so it reads top-to-bottom (Fable → Haiku)
    // exactly like the web composer. macOS drops the menu down, so keep the source order there.
    private var modelMenuItems: [ModelOption] {
        let models = AgentDefaults.models(for: console.provider, catalog: console.modelCatalog)
        #if os(iOS)
        return Array(models.reversed())
        #else
        return models
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

    // Whether the composer box should draw its focused ring/shadow. macOS keys off the field's
    // @FocusState; iOS off the UITextView editor's begin/end-editing (mirrored into `iosEditing`).
    private var boxFocused: Bool {
        #if os(iOS)
        iosEditing
        #else
        inputFocused
        #endif
    }

    /// Focus the input — from autofocus, a reply, or a slash pick. macOS drives @FocusState; iOS
    /// sets the flag the UITextView editor observes to become first responder.
    private func requestFocus() {
        #if os(iOS)
        iosEditing = true
        #else
        inputFocused = true
        #endif
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

                inputField
                    .onChange(of: console.slashToken) { _, new in
                        slashIndex = 0
                        if new == nil { console.slashScope = nil }
                    }
                    .onChange(of: console.replyContext) { if console.replyContext != nil { requestFocus() } }
                    // Clamp input length: an oversized prompt freezes SwiftUI's synchronous
                    // text layout. Pasting past the cap truncates; big content is a file upload.
                    .onChange(of: console.composerText) { _, text in
                        if text.count > ComposerLogic.maxPromptChars {
                            console.composerText = String(text.prefix(ComposerLogic.maxPromptChars))
                        }
                    }

                // One primary button that morphs between Send and Stop, mirroring the web composer
                // (`showStop`): while a turn is running and there's nothing staged to send it's a
                // Stop (interrupt); the moment the user types a follow-up it becomes Send again so
                // the message can queue mid-turn. The running check reads the session's AUTHORITATIVE
                // status (the live control-plane record the nav-bar title uses), not the stream-
                // derived `console.state.status` — that never reaches `.running` on a cold open of an
                // already-running session, so the stop affordance used to never appear.
                if ComposerLogic.showsInterrupt(
                    session: app.session(id: console.sessionID)?.status,
                    stream: console.state.status,
                    hasText: !console.composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                    hasAttachments: !console.pendingAttachments.isEmpty,
                    replying: console.replyContext != nil) {
                    Button { Task { await console.interrupt() } } label: {
                        Image(systemName: "stop.circle.fill")
                            .font(sendGlyphFont)
                            .foregroundStyle(Color.accentColor)
                    }
                    .buttonStyle(.plain)
                    .help("Stop the current turn")
                } else {
                    Button { Task { await console.send() } } label: {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(sendGlyphFont)
                            .foregroundStyle(console.canSend ? Color.accentColor : Color.secondary)
                    }
                    .buttonStyle(.plain)
                    .disabled(!console.canSend)
                }
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
                    .shadow(color: .black.opacity(boxFocused ? 0.12 : 0.06),
                            radius: boxFocused ? 7 : 4, y: 1.5)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(Color.primary.opacity(boxFocused ? 0.22 : 0.10), lineWidth: 1)
            }
            .animation(.easeOut(duration: 0.15), value: boxFocused)

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
                .footerMenuChrome()

                Spacer()

                if let name = console.agentName {
                    // Secondary metadata: yield space before the model/effort controls and usage
                    // gauges when the footer is tight on a narrow iPhone, so the name truncates
                    // rather than pushing a control or the "%" pill onto a second line.
                    Text(name).foregroundStyle(.secondary).lineLimit(1).layoutPriority(-1)
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
                    menuLabel(AgentDefaults.friendlyName(console.modelID, catalog: console.modelCatalog))
                }
                .footerMenuChrome()

                Menu {
                    ForEach(AgentDefaults.efforts(for: console.provider)) { e in
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
                .footerMenuChrome()

                if let ctx = console.state.contextTokens, ctx > 0 {
                    ContextWindowIndicator(tokens: ctx, model: console.modelID, modelCatalog: console.modelCatalog)
                }

                if let usage = console.planUsage {
                    PlanUsageIndicator(usage: usage)
                }
            }
            // Footer pickers are tappable controls, not metadata — list-subtitle size on iOS (15pt)
            // for comfortable targets; macOS keeps the dense web-parity caption.
            .font(.orbitListSubtitle)
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(.bar)
        // A focused field editor consumes ⌘V before any SwiftUI .onPasteCommand fires, so intercept
        // the keystroke here: when the composer is focused and the clipboard holds an image, attach
        // it (web parity) and swallow the paste; anything else falls through to normal text paste.
        .onAppear {
            if autoFocus { requestFocus() }
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

    // The growing multiline input. iOS uses a UITextView-backed editor (`GrowingTextEditor`) because
    // SwiftUI's `TextField(axis: .vertical)` grows only intermittently as text soft-wraps — the box
    // stays a line tall while wrapped (most visibly CJK) text spills. macOS keeps the native vertical
    // TextField: its AppKit backing grows reliably and carries the hardware-keyboard slash navigation.
    @ViewBuilder
    private var inputField: some View {
        #if os(iOS)
        GrowingTextEditor(text: $console.composerText, placeholder: placeholder,
                          maxLines: 6, isEditing: $iosEditing)
            .frame(maxWidth: .infinity)
        #else
        TextField(placeholder, text: $console.composerText, axis: .vertical)
            .textFieldStyle(.plain)
            .font(.orbitControl)
            .lineLimit(1...6)
            // Fill the available width; vertical centering comes from the HStack's .center alignment,
            // so the placeholder, the + and the send button all sit on one centerline.
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
                // No slash menu open: blur the field and hand ↑/↓ back to the session list, so the
                // user can keep switching sessions from the keyboard without clicking the list first.
                inputFocused = false
                app.focusSessionList()
                return .handled
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
            } label: { Label("Image", systemImage: "photo") }
            Button {
                #if os(iOS)
                showFileImporter = true
                #else
                pickFiles(images: false)
                #endif
            } label: { Label("File", systemImage: "paperclip") }
            #if os(iOS)
            // Paste an image from the clipboard (macOS does this via the ⌘V monitor above). Only
            // shown when the clipboard actually holds an image — `hasImages` is a non-consuming
            // check, so it doesn't trigger the paste-access banner until the user taps to paste.
            if UIPasteboard.general.hasImages {
                Button {
                    if let img = UIPasteboard.general.image {
                        Task { await attachClipboardImage(img) }
                    }
                } label: { Label("Paste image", systemImage: "doc.on.clipboard") }
            }
            #endif
        } label: {
            Image(systemName: "plus")
                .font(addGlyphFont)
                .foregroundStyle(.secondary)
                #if os(iOS)
                // Even bumped up, the glyph alone sits under the 44pt HIG tap minimum and the Menu's
                // `.fixedSize()` hugs it. On touch, give it a 34×34 square hit area with the whole
                // rect tappable and the glyph centered — even padding all round, no lopsided gap
                // before the field. The 34pt height matches the send glyph's row so the composer box
                // doesn't grow taller. macOS (pointer input) keeps the tight glyph.
                .frame(width: 34, height: 34)
                .contentShape(Rectangle())
                #endif
        }
        .borderlessMenuStyle()
        .menuIndicator(.hidden)
        .fixedSize()
        // The `+` renders accent-blue by default on iOS (same menu-tint fallback as the footer
        // pickers); keep it neutral so the send button stays the composer box's only accent.
        .neutralMenuTint(.secondary)
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

    /// The text trigger for a footer menu, styled like the reference composer's "Auto" instead of
    /// macOS's default bordered popup button. No dropdown chevron — the footer is tight on iPhone, so
    /// the labels stand alone (on iOS a medium weight marks them as the set, tappable values).
    private func menuLabel(_ text: String) -> some View {
        Text(text)
            #if os(iOS)
            // The current value now carries the emphasis on its own — the trigger is neutral (no
            // accent color), so a medium weight reads as "this is the set value" against the
            // regular-weight agent name without reintroducing a second color. macOS keeps the
            // lighter secondary label its `.borderlessButton` chrome already draws.
            .fontWeight(.medium)
            #endif
            .lineLimit(1)
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
                // While the background upload runs, dim the thumbnail and show a spinner (web
                // parity: the `composer-attach-spin` badge). It clears the instant the id lands.
                .overlay {
                    if att.isUploading {
                        RoundedRectangle(cornerRadius: 8).fill(.black.opacity(0.35))
                        ProgressView().controlSize(.small).tint(.white)
                    }
                }
                // iOS: tap the staged thumbnail to open the full-screen viewer before sending
                // (the tiny 48² chip is hard to read otherwise). Preview the full-resolution bytes
                // seeded in the shared store when the upload finishes — the same source the sent
                // bubble uses — falling back to the downsampled thumbnail while still uploading.
                // The remove button is overlaid *after* this, so it stays on top and its taps aren't
                // captured by the preview.
                .modifier(ComposerImageTap(image: att.remoteID.flatMap { console.attachments.image(for: $0) } ?? image))
                .overlay(alignment: .topTrailing) {
                    Button { console.removeAttachment(att) } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(removeGlyphFont)
                            .foregroundStyle(.white, .black.opacity(0.55))
                            #if os(iOS)
                            // A .plain button's hit area is only its glyph, so the 11pt caption2 ✕ gave
                            // a ~13pt target — under a third of HIG's 44pt and the composer's hardest
                            // control to tap. Enlarge the *touchable* area to 30pt (glyph stays a small
                            // corner badge) and nudge it up/right so that area reaches into empty space
                            // past the 48pt thumb instead of blanketing the image — a full 44pt box would
                            // cover it and steal its tap-to-preview. macOS (pointer) keeps the tight badge.
                            .frame(width: 30, height: 30)
                            .contentShape(Rectangle())
                            .offset(x: 7, y: -7)
                            #endif
                    }
                    .buttonStyle(.plain)
                    #if os(macOS)
                    .padding(2)
                    #endif
                    .help("Remove image")
                }
        } else {
            // Other file: a name + size chip (web's .composer-file). The leading icon spins while
            // the upload is in flight, then settles to a paperclip (web parity).
            HStack(spacing: 6) {
                if att.isUploading {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "paperclip").foregroundStyle(.secondary)
                }
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
                    requestFocus()
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
            console.attach(filename: "photo.png", mimeType: "image/png", data: png)
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

    /// Clipboard image → PNG (the server's inline-image type) → the shared attach path.
    private func attachClipboardImage(_ image: UIImage) async {
        guard let png = image.orbitPNGData() else { return }
        console.attach(filename: "pasted.png", mimeType: "image/png", data: png)
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

#if os(iOS)
/// A `UITextView`-backed multiline input that grows with its content up to `maxLines`, then scrolls
/// internally. The iOS composer needs this because SwiftUI's `TextField(axis: .vertical)` grows only
/// intermittently as text soft-wraps: its reported height lags a layout pass, so a wrapped line —
/// most visibly with CJK text, which wraps mid-run rather than at spaces — often fails to push the box
/// taller until the next keystroke. `UITextView` lays out its text synchronously, so measuring it each
/// change tracks the wrapped height reliably (web-composer parity). Focus is two-way: an external
/// `isEditing = true` (autofocus, a reply, a slash pick) makes it first responder, and begin/end
/// editing report back so the composer box's focus ring follows.
private struct GrowingTextEditor: UIViewRepresentable {
    @Binding var text: String
    let placeholder: String
    let maxLines: Int
    @Binding var isEditing: Bool

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> PlaceholderTextView {
        let view = PlaceholderTextView(frame: .zero, textContainer: nil)
        // Touching `layoutManager` opts the field into TextKit 1, whose `sizeThatFits` measures the
        // wrapped height synchronously and predictably across iOS versions — the whole point here.
        // (TextKit 2's async layout is what leaves the height stale for a pass.) A plain composer
        // needs none of TextKit 2's features, so this trade is free.
        _ = view.layoutManager
        view.delegate = context.coordinator
        view.font = UIFont.preferredFont(forTextStyle: .body)   // matches Font.orbitControl (.body) on iOS
        view.adjustsFontForContentSizeCategory = true
        view.backgroundColor = .clear
        view.textColor = .label
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        // Height is driven by `sizeThatFits` (capped at maxLines); scrolling stays on so the text
        // scrolls within that cap once it's exceeded rather than clipping.
        view.isScrollEnabled = true
        view.placeholderLabel.font = view.font
        return view
    }

    func updateUIView(_ view: PlaceholderTextView, context: Context) {
        context.coordinator.parent = self
        if view.text != text { view.text = text }
        view.placeholderLabel.text = placeholder
        view.placeholderLabel.isHidden = !text.isEmpty
        view.setNeedsLayout()
        // Drive focus from the binding, but never fight the field's own responder state.
        if isEditing, !view.isFirstResponder { view.becomeFirstResponder() }
        else if !isEditing, view.isFirstResponder { view.resignFirstResponder() }
    }

    /// Height for the proposed width, capped at `maxLines`. `UITextView.sizeThatFits` measures the
    /// wrapped text from its layout manager, so this is the reliable growth the vertical TextField lacks.
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: PlaceholderTextView, context: Context) -> CGSize? {
        let width = proposal.width ?? uiView.bounds.width
        guard width.isFinite, width > 0 else { return nil }
        let fit = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        let line = uiView.font?.lineHeight ?? UIFont.preferredFont(forTextStyle: .body).lineHeight
        return CGSize(width: width, height: ceil(min(fit.height, line * CGFloat(maxLines))))
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: GrowingTextEditor
        init(_ parent: GrowingTextEditor) { self.parent = parent }

        func textViewDidChange(_ view: UITextView) {
            if parent.text != view.text { parent.text = view.text }
            (view as? PlaceholderTextView)?.placeholderLabel.isHidden = !view.text.isEmpty
            // Nudge SwiftUI to re-run `sizeThatFits` so the box tracks the new line count immediately.
            view.invalidateIntrinsicContentSize()
        }
        func textViewDidBeginEditing(_ view: UITextView) {
            if !parent.isEditing { parent.isEditing = true }
        }
        func textViewDidEndEditing(_ view: UITextView) {
            if parent.isEditing { parent.isEditing = false }
        }
    }
}

/// A `UITextView` with a leading placeholder label (UIKit has none built in), laid out to sit exactly
/// where typed text begins given the zeroed text-container insets.
private final class PlaceholderTextView: UITextView {
    let placeholderLabel = UILabel()

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        placeholderLabel.numberOfLines = 0
        placeholderLabel.textColor = .placeholderText
        addSubview(placeholderLabel)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        let available = max(bounds.width - textContainerInset.left - textContainerInset.right, 0)
        let size = placeholderLabel.sizeThatFits(CGSize(width: available, height: .greatestFiniteMagnitude))
        placeholderLabel.frame = CGRect(x: textContainerInset.left, y: textContainerInset.top,
                                        width: available, height: size.height)
    }
}
#endif

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
                    // fixedSize keeps the pill at its ideal width: an unbounded Text is the most
                    // flexible view in the footer, so without this a tight row wraps "12%" onto
                    // two lines instead of truncating the (lineLimit-1) name/menu labels.
                    Text("\(pct)%").foregroundStyle(.secondary).fixedSize()
                }
            }
            .buttonStyle(.plain)
            .help("Plan usage \(pct)%")
            .modifier(PlanUsageDetailPresentation(isPresented: $showDetail, usage: usage))
        }
    }
}

/// 94_000 → "94k", 1_000_000 → "1M". Compact token count for the context gauge. Context
/// windows are whole millions and tokens never exceed the window, so integer M suffices.
private func fmtTokens(_ n: Int) -> String {
    if n >= 1_000_000 { return "\(n / 1_000_000)M" }
    if n >= 1000 { return "\(Int((Double(n) / 1000).rounded()))k" }
    return "\(n)"
}

/// Context-window gauge for the composer footer (mirrors PlanUsageIndicator): a mini bar +
/// percent of the model's context window filled by the latest turn; tapping shows the token
/// counts. Distinct from plan usage — that's the subscription rate limit, this is the session's
/// live context occupancy (the figure Claude Code's own gauge shows).
private struct ContextWindowIndicator: View {
    let tokens: Int
    let model: String
    let modelCatalog: RunnerModelCatalog?
    @State private var showDetail = false

    private var window: Int { AgentDefaults.contextWindow(for: model, catalog: modelCatalog) }
    private var pct: Int { window > 0 ? min(100, Int((Double(tokens) / Double(window) * 100).rounded())) : 0 }

    var body: some View {
        Button { showDetail.toggle() } label: {
            HStack(spacing: 5) {
                UsageBar(percent: pct).frame(width: 26, height: 4)
                // See PlanUsageIndicator: pin the pill to its ideal width so a tight footer never
                // wraps the "%" onto a second line.
                Text("\(pct)%").foregroundStyle(.secondary).fixedSize()
            }
        }
        .buttonStyle(.plain)
        .help("Context window \(pct)% · \(fmtTokens(tokens)) / \(fmtTokens(window))")
        .modifier(ContextWindowDetailPresentation(isPresented: $showDetail, tokens: tokens, window: window, pct: pct))
    }
}

/// Presents the context-window detail per platform (matches PlanUsageDetailPresentation): a tight
/// anchored popover on macOS, a fitted bottom sheet on iOS.
private struct ContextWindowDetailPresentation: ViewModifier {
    @Binding var isPresented: Bool
    let tokens: Int
    let window: Int
    let pct: Int

    private var detail: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Context window").foregroundStyle(.secondary)
                Spacer()
                Text("\(pct)%").monospacedDigit()
            }
            UsageBar(percent: pct).frame(height: 4)
            Text("\(fmtTokens(tokens)) / \(fmtTokens(window)) tokens")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    func body(content: Content) -> some View {
        #if os(macOS)
        content.popover(isPresented: $isPresented, arrowEdge: .top) {
            detail.padding(14).frame(width: 220)
        }
        #else
        content.sheet(isPresented: $isPresented) {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("Context").font(.title3.weight(.semibold))
                    Spacer()
                    Button("Done") { isPresented = false }
                }
                .padding(.bottom, 16)
                detail
                Spacer(minLength: 0)
            }
            .padding(20)
            .presentationDetents([.height(160)])
            .presentationDragIndicator(.visible)
        }
        #endif
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

// The `+` add-menu glyph. On iOS it's bumped up from the 15pt row-scale `.orbitGlyph` to `.title3`
// (20pt) so it reads as a clearly tappable control rather than a faint hairline — but kept a clear step
// below the 28pt send CTA so the primary-action hierarchy holds, and stays a semantic style so it tracks
// Dynamic Type (a bare fixed-size font would also fail the font-tokens CI audit). macOS keeps the tight
// `.orbitGlyph` for its pointer-precise bar.
#if os(iOS)
private let addGlyphFont: Font = .title3
#else
private let addGlyphFont: Font = .orbitGlyph
#endif

// The staged-attachment remove (✕) badge. On iOS it steps up from the 11pt caption2 metadata size so
// the glyph reads on a phone, staying a clear step under the 20pt + and 28pt send glyphs so the action
// hierarchy holds; the real touch fix is the 30pt hit area it's paired with. macOS keeps the tight
// pointer-precise corner badge at the metadata size.
#if os(iOS)
private let removeGlyphFont: Font = .subheadline
#else
private let removeGlyphFont: Font = .orbitMeta
#endif
