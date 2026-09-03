import SwiftUI
import OrbitKit

// The full-screen image viewer any console thumbnail opens, and the presentation helper that hosts
// it. iOS-only behind `#if os(iOS)` — on macOS thumbnails aren't tappable, so both helpers are
// no-ops there. Split out of ConsoleView.swift.

/// One page of the full-screen viewer. A sent turn's attachment resolves through the shared
/// `AttachmentImageStore` — the pager may open on a page whose bytes the bounded cache evicted, and
/// only the store can fetch them back. A tool-result image and a staged composer draft already hold
/// their decoded bytes, so they carry them directly.
enum PreviewImage: Identifiable {
    case attachment(TurnAttachment)
    case inline(id: String, image: PlatformImage)

    /// Doubles as the iOS-18 zoom-transition source id, so it has to match the `imageTap` of the
    /// thumbnail this page belongs to.
    var id: String {
        switch self {
        case .attachment(let att): return att.id
        case .inline(let id, _): return id
        }
    }

    /// The decoded bytes, for a page that already carries them. Nil for a store-backed attachment,
    /// whose image is whatever the store currently holds.
    var inlineImage: PlatformImage? {
        if case .inline(_, let image) = self { return image }
        return nil
    }
}

/// The image a tap opened the full-screen pager on: `index` seeds the starting page; `id` (the
/// tapped image's `PreviewImage.id`) is the iOS-18 zoom-transition source so the viewer zooms back
/// to the right thumbnail.
struct ImagePreviewTarget: Identifiable {
    let index: Int
    let id: String
}

extension View {
    /// iOS: present the full-screen image pager for `target`, zooming out of the tapped thumbnail on
    /// iOS 18+. Every tappable image in the console is presented through here, so the transition is
    /// the same wherever you tap; what differs per surface is only how far you can swipe — the pager
    /// spans the images of the one message you tapped into (a turn's attachments, a tool result's
    /// screenshots, the staged drafts). `store` is needed only for `.attachment` pages; a list of
    /// already-decoded images passes nil. macOS: no-op (thumbnails aren't tappable there, so
    /// `target` never becomes non-nil).
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
/// Full-screen, swipeable viewer for the images of one message — opened by tapping any console
/// thumbnail. Swipe left/right to move between them; pinch or double-tap to zoom, drag to pan while
/// zoomed; drag down at fit scale to dismiss (the image shrinks and the transcript shows through). A
/// single `DragGesture` routes by direction — horizontal ⇒ page, vertical ⇒ dismiss, any drag while
/// zoomed ⇒ pan — so paging, dismissing and panning never fight each other.
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
    @State private var pan: CGSize = .zero       // committed pan of the current page
    @State private var panLive: CGSize = .zero   // live pan translation
    @State private var mode: DragMode = .idle

    private enum DragMode { case idle, page, dismiss, pan }
    private static let gap: CGFloat = 24

    init(images: [PreviewImage], startIndex: Int) {
        self.images = images
        _index = State(initialValue: startIndex)
    }

    private var liveScale: CGFloat { max(1, scale * pinch) }
    private var zoomed: Bool { liveScale > 1.01 }
    private var dismissProgress: CGFloat { min(1, dismissDY / 260) }

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let stride = w + Self.gap

            let drag = DragGesture()
                .onChanged { v in
                    if mode == .idle {
                        if zoomed { mode = .pan }
                        else if abs(v.translation.width) > abs(v.translation.height) { mode = .page }
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
                    case .idle: break
                    }
                    mode = .idle
                }

            let magnify = MagnificationGesture()
                .updating($pinch) { value, state, _ in state = value }
                .onEnded { value in scale = min(max(1, scale * value), 6) }

            ZStack {
                // Fades out as the dismiss drag progresses; presentationBackground(.clear) lets the
                // transcript show through so the swipe reads as peeling the image away.
                Color.black.opacity(1 - dismissProgress).ignoresSafeArea()

                HStack(spacing: Self.gap) {
                    ForEach(Array(images.enumerated()), id: \.element.id) { i, item in
                        page(item, isCurrent: i == index, size: geo.size)
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
            .onTapGesture(count: 2) {
                withAnimation(.easeOut(duration: 0.22)) {
                    if zoomed { scale = 1; pan = .zero } else { scale = 2.6 }
                }
            }
            // A single tap anywhere dismisses the preview (no on-screen close button).
            .onTapGesture { dismiss() }
        }
        .ignoresSafeArea()
        .overlay(alignment: .bottom) { pageDots }
        .statusBarHidden(true)
        .presentationBackground(.clear)
    }

    @ViewBuilder
    private func page(_ item: PreviewImage, isCurrent: Bool, size: CGSize) -> some View {
        Group {
            switch item {
            case .attachment(let att): attachmentPage(att, isCurrent: isCurrent)
            case .inline(_, let img): pageBody(img, isCurrent: isCurrent)
            }
        }
        .frame(width: size.width, height: size.height)
    }

    /// A store-backed page: shows a spinner until the bytes land, and keeps asking for them for as
    /// long as the page exists (the cache is bounded and may have dropped this id).
    @ViewBuilder
    private func attachmentPage(_ att: TurnAttachment, isCurrent: Bool) -> some View {
        if let store {
            Group {
                if let img = store.image(for: att.id) {
                    pageBody(img, isCurrent: isCurrent)
                } else {
                    ProgressView().tint(.white)
                }
            }
            .loadsAttachmentImage(att.id, from: store)
        } else {
            ProgressView().tint(.white)
        }
    }

    private func pageBody(_ img: PlatformImage, isCurrent: Bool) -> some View {
        Image(platformImage: img)
            .resizable()
            .scaledToFit()
            .scaleEffect(isCurrent ? liveScale : 1)
            .offset(isCurrent
                    ? CGSize(width: pan.width + panLive.width, height: pan.height + panLive.height)
                    : .zero)
    }

    @ViewBuilder
    private var pageDots: some View {
        if images.count > 1 {
            HStack(spacing: 6) {
                ForEach(images.indices, id: \.self) { i in
                    Circle()
                        .fill(i == index ? Color.white : Color.white.opacity(0.4))
                        .frame(width: 6, height: 6)
                }
            }
            .padding(.bottom, 30)
            .opacity(1 - dismissProgress)
        }
    }
}
#endif
