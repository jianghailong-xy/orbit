import SwiftUI
import OrbitKit
#if os(iOS)
import Photos
#endif

// The full-screen image viewer any console thumbnail opens, the presentation helper that hosts it,
// and the menu a long press on its image opens. iOS-only behind `#if os(iOS)` — on macOS thumbnails
// aren't tappable, so both helpers are no-ops there. Split out of ConsoleView.swift.

/// One page of the full-screen viewer. An attachment resolves through the shared
/// `AttachmentImageStore` — the pager may open on a page whose bytes the bounded cache evicted, and
/// only the store can fetch them back. A tool-result image and a staged composer draft already hold
/// their decoded bytes, so they carry them directly.
enum PreviewImage: Identifiable {
    /// `id` names the page (spelled as `SessionPreviewImages` spells it); `attachmentID` is the store's.
    case attachment(id: String, attachmentID: String)
    case inline(id: String, image: PlatformImage)

    /// Doubles as the iOS-18 zoom-transition source id, so it has to match the `imageTap` of the
    /// thumbnail this page belongs to.
    var id: String {
        switch self {
        case .attachment(let id, _): return id
        case .inline(let id, _): return id
        }
    }

    /// The decoded bytes, for a page that already carries them. Nil for a store-backed attachment,
    /// whose image is whatever the store currently holds.
    var inlineImage: PlatformImage? {
        if case .inline(_, let image) = self { return image }
        return nil
    }

    /// A page of the session's viewer. Nil for tool-result bytes that don't decode as an image, which
    /// the card shows no thumbnail for either.
    init?(_ ref: PreviewImageRef) {
        switch ref.source {
        case .attachment(let attachmentID):
            self = .attachment(id: ref.key, attachmentID: attachmentID)
        case .data(let data):
            guard let image = PlatformImage(data: data) else { return nil }
            self = .inline(id: ref.key, image: image)
        }
    }
}

/// The image a tap opened the full-screen pager on: `index` seeds the starting page; `id` (the
/// tapped image's `PreviewImage.id`) is the iOS-18 zoom-transition source so the viewer zooms back
/// to the right thumbnail.
struct ImagePreviewTarget: Identifiable {
    let index: Int
    let id: String
}

/// The console's one full-screen viewer, handed down its transcript. A thumbnail there opens it over
/// every image in the session — paging across messages, tool calls and thinking blocks — instead of
/// hosting a pager over its own message's images. Absent outside the console (task pages, the
/// composer's drafts), where a thumbnail keeps its own.
struct SessionImagePreview: Equatable {
    /// The console this viewer belongs to, and — with `ns` — all of its identity. The console rebuilds
    /// this value on every render, which while a reply streams is several times a second; compared by
    /// its closures it would never be equal, and every thumbnail and tool card reading it would
    /// re-render with the console.
    let consoleID: ObjectIdentifier
    /// The zoom-transition namespace the viewer presents in; a thumbnail marks itself in it.
    let ns: Namespace.ID
    /// Opens on the page `key` names. A thumbnail the session's images don't list — Markdown in a tool
    /// card or an approval, a message still queued — pages through `fallback` from `fallbackIndex`.
    let open: (_ key: String, _ fallback: [PreviewImage], _ fallbackIndex: Int) -> Void
    /// An open tool card hands over the screenshot bytes it fetched back, so they join the pages.
    let rememberToolImages: (_ cardID: String, _ images: [Data]) -> Void

    static func == (lhs: SessionImagePreview, rhs: SessionImagePreview) -> Bool {
        lhs.consoleID == rhs.consoleID && lhs.ns == rhs.ns
    }
}

private struct SessionImagePreviewKey: EnvironmentKey {
    static let defaultValue: SessionImagePreview? = nil
}

/// The transcript item whose Markdown is being rendered, so an image in it can name its page.
private struct PreviewOwnerIDKey: EnvironmentKey {
    static let defaultValue: String? = nil
}

extension EnvironmentValues {
    var sessionImagePreview: SessionImagePreview? {
        get { self[SessionImagePreviewKey.self] }
        set { self[SessionImagePreviewKey.self] = newValue }
    }

    var previewOwnerID: String? {
        get { self[PreviewOwnerIDKey.self] }
        set { self[PreviewOwnerIDKey.self] = newValue }
    }
}

extension View {
    /// iOS: present the full-screen image pager for `target`, zooming out of the tapped thumbnail on
    /// iOS 18+. Every tappable image in the console is presented through here, so the transition is
    /// the same wherever you tap; what differs is only how far you can swipe — the console's viewer
    /// spans the whole session (`SessionImagePreview`), a pager elsewhere the images of the one surface
    /// you tapped into (the staged drafts, a task's Markdown). `store` is needed only for
    /// `.attachment` pages; a list of already-decoded images passes nil. macOS: no-op (thumbnails
    /// aren't tappable there, so `target` never becomes non-nil).
    @ViewBuilder
    func imagePreview(_ target: Binding<ImagePreviewTarget?>, images: [PreviewImage],
                      ns: Namespace.ID, store: AttachmentImageStore? = nil) -> some View {
        #if os(iOS)
        self.fullScreenCover(item: target) { t in
            Group {
                if #available(iOS 18.0, *) {
                    ImagePagerView(images: images, startIndex: t.index)
                        .navigationTransition(.zoom(sourceID: t.id, in: ns))
                } else {
                    ImagePagerView(images: images, startIndex: t.index)
                }
            }
            .environment(store)
        }
        #else
        self
        #endif
    }

    /// iOS: make an image thumbnail tappable to open the full-screen pager, and (iOS 18+) mark it as
    /// the zoom-transition source so the preview grows out of / shrinks back into this thumbnail —
    /// the WeChat-style expand animation. macOS: no-op — the thumbnail stays a static image.
    @ViewBuilder
    func imageTap(_ onTap: @escaping () -> Void, sourceID: String, ns: Namespace.ID) -> some View {
        #if os(iOS)
        let tappable = self.contentShape(Rectangle()).onTapGesture(perform: onTap)
        if #available(iOS 18.0, *) {
            tappable.matchedTransitionSource(id: sourceID, in: ns)
        } else {
            tappable
        }
        #else
        self
        #endif
    }
}

#if os(iOS)
/// Full-screen, swipeable viewer over a group of images — in the console every image in the session,
/// elsewhere the images of the surface tapped. Swipe left/right to move between them; pinch or
/// double-tap to zoom, drag to pan while zoomed; drag down at fit scale to dismiss (the image shrinks
/// and the transcript shows through). A single `DragGesture` routes by direction — horizontal ⇒ page,
/// vertical ⇒ dismiss (or scroll, on a long image), any drag while zoomed ⇒ pan — so paging, dismissing
/// and panning never fight each other.
///
/// An image proportionally taller than the screen — a long screenshot — opens filling the width, top
/// edge first, since fitted whole it would be a sliver down the middle. A vertical drag scrolls it, and
/// only a pull down from its top dismisses (`ImageViewerGeometry` has the arithmetic). Holding a finger
/// on the image opens the image menu: Save to Photos, Copy, Share.
struct ImagePagerView: View {
    let images: [PreviewImage]
    /// Only `.attachment` pages need it, so it's read optionally: a pager over in-memory images is
    /// presented without a store in its environment.
    @Environment(AttachmentImageStore.self) private var store: AttachmentImageStore?
    @Environment(\.dismiss) private var dismiss

    @State private var index: Int
    @State private var pageDX: CGFloat = 0      // live horizontal paging drag
    @State private var dismissDY: CGFloat = 0   // live downward dismiss drag (fit scale only)
    @GestureState private var pinch: CGFloat = 1
    @State private var scale: CGFloat = 1        // committed zoom of the current page
    @State private var pan: CGSize = .zero       // committed pan of the current page, from where it rests
    @State private var panLive: CGSize = .zero   // live pan translation
    @State private var mode: DragMode = .idle
    /// Set when a long press opens the image menu. Lifting that finger can still complete the single
    /// tap, which would close the viewer — and the menu with it — the moment the menu appears.
    @State private var swallowTap = false
    @State private var notice: SaveNotice?

    private enum DragMode { case idle, page, dismiss, pan, scroll }
    private static let gap: CGFloat = 24

    init(images: [PreviewImage], startIndex: Int) {
        self.images = images
        _index = State(initialValue: startIndex)
    }

    private var liveScale: CGFloat { max(1, scale * pinch) }
    private var zoomed: Bool { liveScale > 1.01 }
    private var dismissProgress: CGFloat { min(1, dismissDY / 260) }

    /// The current page's image, once its bytes have landed.
    private var currentImage: PlatformImage? {
        switch images[index] {
        case .attachment(_, let attachmentID): return store?.image(for: attachmentID)
        case .inline(_, let image): return image
        }
    }

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let stride = w + Self.gap
            let fit = Self.geometry(currentImage, in: geo.size)

            let drag = DragGesture()
                .onChanged { v in
                    if mode == .idle {
                        if zoomed { mode = .pan }
                        else if abs(v.translation.width) > abs(v.translation.height) { mode = .page }
                        // A long image scrolls — until it's back at its top, where pulling down dismisses.
                        else if fit.travel > 0, v.translation.height < 0 || pan.height < -0.5 { mode = .scroll }
                        else if v.translation.height > 0 { mode = .dismiss }
                        else { mode = .page }
                    }
                    switch mode {
                    case .page:
                        var dx = v.translation.width
                        if (index == 0 && dx > 0) || (index == images.count - 1 && dx < 0) { dx *= 0.35 }
                        pageDX = dx
                    case .dismiss: dismissDY = max(0, v.translation.height)
                    case .pan: panLive = v.translation
                    case .scroll:
                        let y = fit.rubberBanded(Double(pan.height + v.translation.height))
                        panLive = CGSize(width: 0, height: CGFloat(y) - pan.height)
                    case .idle: break
                    }
                }
                .onEnded { v in
                    switch mode {
                    case .page:
                        var next = index
                        if v.translation.width < -w * 0.25, index < images.count - 1 { next += 1 }
                        else if v.translation.width > w * 0.25, index > 0 { next -= 1 }
                        if next != index { scale = 1; pan = .zero; panLive = .zero }
                        withAnimation(.interactiveSpring(response: 0.34, dampingFraction: 0.86)) {
                            index = next
                            pageDX = 0
                        }
                    case .dismiss:
                        if v.translation.height > 150 { dismiss() }
                        else { withAnimation(.spring(response: 0.3, dampingFraction: 0.86)) { dismissDY = 0 } }
                    case .pan:
                        pan.width += panLive.width
                        pan.height += panLive.height
                        panLive = .zero
                    case .scroll:
                        // A flick carries on the way a scroll view's does, and stops at either end.
                        let y = fit.clampedScroll(Double(pan.height + v.predictedEndTranslation.height))
                        withAnimation(.spring(response: 0.45, dampingFraction: 0.9)) {
                            pan.height = CGFloat(y)
                            panLive = .zero
                        }
                    case .idle: break
                    }
                    mode = .idle
                }

            // Committed without animation: `pinch` snaps back to 1 in the same frame, so animating
            // `scale` would first shrink the image back and then grow it again.
            let magnify = MagnificationGesture()
                .updating($pinch) { value, state, _ in state = value }
                .onEnded { value in
                    let next = min(max(1, scale * value), 6)
                    zoom(to: next < 1.01 ? 1 : next, fit: fit)
                }

            // Held still for a moment, a finger opens the image menu. Simultaneous like the pinch:
            // left to compete, it would lose the touch to the drag and taps and never fire.
            let longPress = LongPressGesture(minimumDuration: 0.4)
                .onEnded { _ in
                    guard let image = currentImage else { return }
                    swallowTap = true
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    presentImageActionSheet(image,
                                            onClose: { swallowTap = false },
                                            onSaved: { notice = SaveNotice(saved: $0) })
                }

            ZStack {
                // Fades out as the dismiss drag progresses; presentationBackground(.clear) lets the
                // transcript show through so the swipe reads as peeling the image away.
                Color.black.opacity(1 - dismissProgress).ignoresSafeArea()

                HStack(spacing: Self.gap) {
                    ForEach(Array(images.enumerated()), id: \.element.id) { i, item in
                        Group {
                            // Only the page on screen and the two a swipe can reveal are built: over a
                            // whole session, every page would fetch and decode its image on opening.
                            if abs(i - index) <= 1 {
                                page(item, isCurrent: i == index, size: geo.size)
                            } else {
                                Color.clear
                            }
                        }
                        .frame(width: w, height: geo.size.height)
                    }
                }
                .offset(x: -CGFloat(index) * stride + pageDX)   // slide content within the fixed window
                .frame(width: w, height: geo.size.height, alignment: .leading)
                .offset(y: dismissDY)                            // dismiss drag moves the window down
                .scaleEffect(1 - dismissProgress * 0.12)
            }
            .contentShape(Rectangle())
            .gesture(drag)
            .simultaneousGesture(magnify)
            .simultaneousGesture(longPress)
            .onTapGesture(count: 2) {
                withAnimation(.easeOut(duration: 0.22)) {
                    zoom(to: zoomed ? 1 : 2.6, fit: fit)
                }
            }
            // A single tap anywhere dismisses the preview (no on-screen close button).
            .onTapGesture {
                if swallowTap { swallowTap = false } else { dismiss() }
            }
        }
        .ignoresSafeArea()
        .overlay(alignment: .bottom) { pageCounter }
        .overlay(alignment: .top) { noticeCard }
        .statusBarHidden(true)
        .presentationBackground(.clear)
        .onChange(of: notice) { _, new in
            if let new { AccessibilityNotification.Announcement(new.message).post() }
        }
    }

    /// Commits a new zoom for the current page, keeping the point at the centre of the screen where
    /// it is.
    private func zoom(to next: CGFloat, fit: ImageViewerGeometry) {
        let p = fit.pan(x: Double(pan.width), y: Double(pan.height),
                        rescaledFrom: Double(scale), to: Double(next))
        pan = CGSize(width: p.x, height: p.y)
        scale = next
    }

    private static func geometry(_ image: PlatformImage?, in size: CGSize) -> ImageViewerGeometry {
        ImageViewerGeometry(imageWidth: Double(image?.size.width ?? 0),
                            imageHeight: Double(image?.size.height ?? 0),
                            viewportWidth: Double(size.width),
                            viewportHeight: Double(size.height))
    }

    @ViewBuilder
    private func page(_ item: PreviewImage, isCurrent: Bool, size: CGSize) -> some View {
        Group {
            switch item {
            case .attachment(_, let attachmentID): attachmentPage(attachmentID, isCurrent: isCurrent, size: size)
            case .inline(_, let img): pageBody(img, isCurrent: isCurrent, size: size)
            }
        }
        .frame(width: size.width, height: size.height)
    }

    /// A store-backed page: shows a spinner until the bytes land, and keeps asking for them for as
    /// long as the page exists (the cache is bounded and may have dropped this id).
    @ViewBuilder
    private func attachmentPage(_ attachmentID: String, isCurrent: Bool, size: CGSize) -> some View {
        if let store {
            Group {
                if let img = store.image(for: attachmentID) {
                    pageBody(img, isCurrent: isCurrent, size: size)
                } else {
                    ProgressView().tint(.white)
                }
            }
            .loadsAttachmentImage(attachmentID, from: store)
        } else {
            ProgressView().tint(.white)
        }
    }

    private func pageBody(_ img: PlatformImage, isCurrent: Bool, size: CGSize) -> some View {
        let fit = Self.geometry(img, in: size)
        return Image(platformImage: img)
            .resizable()
            .frame(width: CGFloat(fit.restWidth), height: CGFloat(fit.restHeight))
            .scaleEffect(isCurrent ? liveScale : 1)
            .offset(isCurrent ? liveOffset(fit) : CGSize(width: 0, height: CGFloat(fit.restOffsetY)))
    }

    /// Where the current page draws: its rest position plus the committed pan — carried through a
    /// live pinch so the point at the centre of the screen stays put — plus any drag under way.
    private func liveOffset(_ fit: ImageViewerGeometry) -> CGSize {
        let k = liveScale / scale
        let rest = CGFloat(fit.restOffsetY)
        return CGSize(width: pan.width * k + panLive.width,
                      height: (rest + pan.height) * k + panLive.height)
    }

    /// "3 / 12" under the image. A counter rather than a dot per page: a session's images outrun the
    /// width of the screen long before they outrun a number.
    @ViewBuilder
    private var pageCounter: some View {
        if images.count > 1 {
            Text("\(index + 1) / \(images.count)")
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(.white.opacity(0.92))
                .padding(.horizontal, 12)
                .padding(.vertical, 4)
                .background(.white.opacity(0.16), in: Capsule())
                .padding(.bottom, 30)
                .opacity(1 - dismissProgress)
                .accessibilityLabel("Image \(index + 1) of \(images.count)")
        }
    }

    /// What a save from the image menu came to.
    private struct SaveNotice: Equatable {
        let saved: Bool
        let id = UUID()
        var message: String { saved ? "Saved to Photos" : "Couldn't Save Image" }
    }

    /// The card a save leaves at the top of the viewer — the look of `ToastHost`'s, which can't show
    /// here: it floats at the shell root, underneath this full-screen cover. Dark to match the black
    /// backdrop, pass-through, and gone after two seconds.
    private var noticeCard: some View {
        ZStack(alignment: .top) {
            if let notice {
                HStack(spacing: 12) {
                    Image(systemName: notice.saved ? "checkmark.circle.fill" : "xmark.circle.fill")
                        .font(.title3)
                        .foregroundStyle(notice.saved ? Color.green : Color.red)
                        .accessibilityHidden(true)
                    Text(notice.message)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 12)
                .background {
                    let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)
                    shape.fill(.regularMaterial)
                        .overlay(shape.strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.7))
                        .shadow(color: .black.opacity(0.18), radius: 12, y: 4)
                }
                .frame(maxWidth: 560)
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .environment(\.colorScheme, .dark)
                .transition(.move(edge: .top).combined(with: .opacity))
                .task(id: notice.id) {
                    do {
                        try await Task.sleep(for: .seconds(2))
                        self.notice = nil
                    } catch {
                        // Cancelled: a newer notice replaced this one and runs its own clock.
                    }
                }
            }
        }
        .animation(.snappy, value: notice)
        .allowsHitTesting(false)
    }
}

/// Presents the image menu a long press opens in the full-screen viewer: the system action sheet from
/// the bottom of the screen — the convention for a full-screen photo — with Save to Photos, Copy and
/// Share. UIKit on purpose: SwiftUI's `.confirmationDialog`, presented from inside the viewer's
/// clear-background `fullScreenCover`, renders as a centred card with no Cancel instead.
/// `onClose` runs whichever way the sheet goes; `onSaved` reports whether a save landed.
@MainActor
func presentImageActionSheet(_ image: UIImage, onClose: @escaping () -> Void,
                             onSaved: @escaping (Bool) -> Void) {
    guard let host = frontmostViewController() else {
        onClose()
        return
    }
    let sheet = UIAlertController(title: nil, message: nil, preferredStyle: .actionSheet)
    sheet.addAction(UIAlertAction(title: "Save to Photos", style: .default) { _ in
        onClose()
        Task { await saveToPhotos(image, from: host, onSaved: onSaved) }
    })
    sheet.addAction(UIAlertAction(title: "Copy", style: .default) { _ in
        onClose()
        UIPasteboard.general.image = image
        PlatformHaptics.success()
    })
    sheet.addAction(UIAlertAction(title: "Share…", style: .default) { _ in
        onClose()
        let share = UIActivityViewController(activityItems: [image], applicationActivities: nil)
        anchorAtBottom(share.popoverPresentationController, of: host.view)
        host.present(share, animated: true)
    })
    sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in onClose() })
    // The viewer is black whatever the app's appearance, so the sheet is dark to sit on it.
    sheet.overrideUserInterfaceStyle = .dark
    anchorAtBottom(sheet.popoverPresentationController, of: host.view)
    host.present(sheet, animated: true)
}

/// Adds the image to the photo library, asking for add-only access the first time — all a save needs
/// (`NSPhotoLibraryAddUsageDescription` in Info.plist). A refusal gets the way to Settings rather than
/// nothing, since it's the one failure the user can fix.
@MainActor
private func saveToPhotos(_ image: UIImage, from host: UIViewController,
                          onSaved: @escaping (Bool) -> Void) async {
    let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
    guard status == .authorized || status == .limited else {
        let alert = UIAlertController(title: "Can't Save to Photos",
                                      message: "Allow Orbit to add photos in Settings.",
                                      preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Open Settings", style: .default) { _ in
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url)
            }
        })
        host.present(alert, animated: true)
        return
    }
    do {
        try await PHPhotoLibrary.shared().performChanges {
            PHAssetChangeRequest.creationRequestForAsset(from: image)
        }
        PlatformHaptics.success()
        onSaved(true)
    } catch {
        onSaved(false)
    }
}

/// The topmost presented view controller of the active window — the viewer's own cover while it's up.
@MainActor
private func frontmostViewController() -> UIViewController? {
    let scene = UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
        .first { $0.activationState == .foregroundActive }
    guard let window = scene?.windows.first(where: { $0.isKeyWindow }) ?? scene?.windows.first,
          var top = window.rootViewController else { return nil }
    while let presented = top.presentedViewController { top = presented }
    return top
}

/// iPad shows an action or share sheet as a popover, which traps without an anchor: pin it, arrowless,
/// to the bottom centre so it still rises from the bottom of the image. A no-op on iPhone.
@MainActor
private func anchorAtBottom(_ popover: UIPopoverPresentationController?, of view: UIView) {
    guard let popover else { return }
    popover.sourceView = view
    popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.maxY - 1, width: 1, height: 1)
    popover.permittedArrowDirections = []
}
#endif
