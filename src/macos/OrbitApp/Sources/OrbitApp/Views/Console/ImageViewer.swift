import SwiftUI
import OrbitKit

// The full-screen image viewers a transcript (or composer) thumbnail opens, and the presentation
// helper that hosts them. iOS-only behind `#if os(iOS)` — on macOS thumbnails aren't tappable, so
// the helper is a no-op there. Split out of ConsoleView.swift.

/// The image a tap opened the full-screen pager on: `index` seeds the starting page; `id` (the tapped
/// attachment's id) is the iOS-18 zoom-transition source so the viewer zooms back to the right tile.
struct ImagePreviewTarget: Identifiable {
    let index: Int
    let id: String
}

extension View {
    /// iOS: present the full-screen image pager for `target`, zooming out of the tapped thumbnail on
    /// iOS 18+. macOS: no-op (thumbnails aren't tappable there, so `target` never becomes non-nil).
    @ViewBuilder
    func imagePreview(_ target: Binding<ImagePreviewTarget?>, images: [TurnAttachment],
                      ns: Namespace.ID, store: AttachmentImageStore) -> some View {
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
}

#if os(iOS)
/// Single-image full-screen viewer for an in-memory `PlatformImage` (the composer's staged draft
/// thumbnails, which aren't attachment-backed yet). Pinch or double-tap to zoom, drag to pan while
/// zoomed; drag down at fit scale to dismiss with the image shrinking as the backdrop fades. The
/// sent-turn transcript uses `ImagePagerView` (swipe between a turn's images) instead.
struct FullScreenImageView: View {
    let image: PlatformImage
    @Environment(\.dismiss) private var dismiss

    @GestureState private var pinch: CGFloat = 1
    @State private var scale: CGFloat = 1
    @State private var offset: CGSize = .zero   // committed pan, only meaningful while zoomed
    @State private var drag: CGSize = .zero      // live drag translation

    private var liveScale: CGFloat { max(1, scale * pinch) }
    private var zoomed: Bool { liveScale > 1.01 }
    // 0 while zoomed or idle; 0→1 as a fit-scale downward drag approaches the dismiss threshold.
    private var dismissProgress: CGFloat { zoomed ? 0 : min(1, max(0, drag.height) / 260) }

    var body: some View {
        let magnify = MagnificationGesture()
            .updating($pinch) { value, state, _ in state = value }
            .onEnded { value in scale = min(max(1, scale * value), 6) }

        let pan = DragGesture()
            .onChanged { value in drag = value.translation }
            .onEnded { value in
                if zoomed {
                    offset.width += value.translation.width      // commit the pan
                    offset.height += value.translation.height
                    drag = .zero
                } else if value.translation.height > 150 {
                    dismiss()
                } else {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.86)) { drag = .zero }
                }
            }

        ZStack {
            Color.black.opacity(1 - dismissProgress).ignoresSafeArea()

            Image(platformImage: image)
                .resizable()
                .scaledToFit()
                .scaleEffect(liveScale * (1 - dismissProgress * 0.12))
                .offset(x: offset.width + drag.width, y: offset.height + drag.height)
                .frame(maxWidth: .infinity, maxHeight: .infinity)   // fill → scaledToFit centres it
                .contentShape(Rectangle())
                .gesture(pan)
                .simultaneousGesture(magnify)
                .onTapGesture(count: 2) {
                    withAnimation(.easeOut(duration: 0.22)) {
                        if zoomed { scale = 1; offset = .zero } else { scale = 2.6 }
                    }
                }
                // A single tap anywhere dismisses the preview (no on-screen close button).
                .onTapGesture { dismiss() }
        }
        .ignoresSafeArea()
        .statusBarHidden(true)
        .presentationBackground(.clear)
    }
}

/// Full-screen, swipeable viewer for the images in a user turn — opened by tapping any transcript
/// thumbnail. Swipe left/right to move between the turn's images; pinch or double-tap to zoom, drag
/// to pan while zoomed; drag down at fit scale to dismiss (the image shrinks and the transcript shows
/// through). A single `DragGesture` routes by direction — horizontal ⇒ page, vertical ⇒ dismiss, any
/// drag while zoomed ⇒ pan — so paging, dismissing and panning never fight each other.
struct ImagePagerView: View {
    let images: [TurnAttachment]
    @Environment(AttachmentImageStore.self) private var store
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

    init(images: [TurnAttachment], startIndex: Int) {
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
                    ForEach(Array(images.enumerated()), id: \.element.id) { i, att in
                        page(att, isCurrent: i == index, size: geo.size)
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
    private func page(_ att: TurnAttachment, isCurrent: Bool, size: CGSize) -> some View {
        Group {
            if let img = store.image(for: att.id) {
                Image(platformImage: img)
                    .resizable()
                    .scaledToFit()
                    .scaleEffect(isCurrent ? liveScale : 1)
                    .offset(isCurrent
                            ? CGSize(width: pan.width + panLive.width, height: pan.height + panLive.height)
                            : .zero)
            } else {
                ProgressView().tint(.white)
            }
        }
        .frame(width: size.width, height: size.height)
        .task(id: att.id) { await store.load(att.id) }
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
