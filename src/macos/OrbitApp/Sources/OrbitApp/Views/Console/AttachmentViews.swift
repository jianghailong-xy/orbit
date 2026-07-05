import SwiftUI
import OrbitKit

// A user turn's attachment views: the large fitted image thumbnail, the uniform square grid tile,
// the non-image file chip, and the wrapping FlowLayout that arranges them. Split out of
// ConsoleView.swift; the full-screen viewer a thumbnail tap opens lives in ImageViewer.swift.

/// A user-turn image attachment: fetched once via the shared cache and shown as a rounded thumbnail
/// (web's `.chat-image`). Falls back to a file chip if the bytes don't decode as an image. On iOS,
/// tapping the thumbnail opens a full-screen, pinch-to-zoom viewer (web-preview parity).
struct ChatAttachmentImage: View {
    let attachment: TurnAttachment
    var onTap: () -> Void
    var sourceID: String
    var ns: Namespace.ID
    @Environment(AttachmentImageStore.self) private var store

    // Thumbnail cap. iOS enlarges the sent image so a screenshot reads on a phone, and allows extra
    // height so a portrait shot isn't squeezed into a thin sliver; macOS keeps a compact 220² since
    // thumbnails sit in a wide window. A tap opens the full-screen viewer for anything finer.
    #if os(iOS)
    private static let cap = CGSize(width: 300, height: 360)
    #else
    private static let cap = CGSize(width: 220, height: 220)
    #endif

    /// Scale the source down (or up) to touch the cap while keeping its aspect ratio, and give the
    /// thumbnail that exact size. A `maxWidth/maxHeight` frame is greedy — it fills the whole cap box
    /// and letterboxes a mismatched-aspect image inside, so the rounded border wraps empty space
    /// around a portrait shot. An exact frame makes the border hug the image with no blank margin.
    private static func fitted(_ src: CGSize) -> CGSize {
        guard src.width > 0, src.height > 0 else { return cap }
        let k = min(cap.width / src.width, cap.height / src.height)
        return CGSize(width: src.width * k, height: src.height * k)
    }

    var body: some View {
        Group {
            if let img = store.image(for: attachment.id) {
                let size = Self.fitted(img.size)
                Image(platformImage: img)
                    .resizable().scaledToFit()
                    .frame(width: size.width, height: size.height)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(.primary.opacity(0.08)) }
                    .imageTap(onTap, sourceID: sourceID, ns: ns)
            } else if store.isNotImage(attachment.id) {
                ChatAttachmentFile(attachment: attachment)   // not an image after all
            } else {
                RoundedRectangle(cornerRadius: 8)
                    .fill(.quaternary)
                    .frame(width: 120, height: 90)
            }
        }
        .task(id: attachment.id) { await store.load(attachment.id) }
    }
}

/// A non-image attachment: a name chip (web's `.chat-file`).
struct ChatAttachmentFile: View {
    let attachment: TurnAttachment

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "paperclip").foregroundStyle(.secondary)
            Text(attachment.name ?? "file").lineLimit(1).truncationMode(.middle)
        }
        .font(.caption)
        .padding(.vertical, 4).padding(.horizontal, 8)
        .frame(maxWidth: 220, alignment: .leading)
        .background(.gray.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
    }
}

/// A user-turn image attachment rendered as a uniform square thumbnail — the tile used when a turn
/// carries two or more images (WeChat-style grid). A single image keeps `ChatAttachmentImage`'s
/// larger fitted look. Falls back to a file chip if the bytes don't decode.
struct ChatAttachmentThumb: View {
    let attachment: TurnAttachment
    var onTap: () -> Void
    var sourceID: String
    var ns: Namespace.ID
    @Environment(AttachmentImageStore.self) private var store

    #if os(iOS)
    private static let side: CGFloat = 104
    #else
    private static let side: CGFloat = 96
    #endif

    var body: some View {
        Group {
            if let img = store.image(for: attachment.id) {
                Image(platformImage: img)
                    .resizable()
                    .scaledToFill()
                    .frame(width: Self.side, height: Self.side)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(.primary.opacity(0.08)) }
                    .imageTap(onTap, sourceID: sourceID, ns: ns)
            } else if store.isNotImage(attachment.id) {
                ChatAttachmentFile(attachment: attachment)   // not an image after all
            } else {
                RoundedRectangle(cornerRadius: 8).fill(.quaternary)
                    .frame(width: Self.side, height: Self.side)
            }
        }
        .task(id: attachment.id) { await store.load(attachment.id) }
    }
}

/// iOS: make a transcript image thumbnail tappable to open the full-screen pager, and (iOS 18+) mark
/// it as the zoom-transition source so the preview grows out of / shrinks back into this thumbnail —
/// the WeChat-style expand animation. macOS: no-op — the thumbnail stays a static rounded image.
private extension View {
    @ViewBuilder func imageTap(_ onTap: @escaping () -> Void, sourceID: String, ns: Namespace.ID) -> some View {
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

/// Minimal wrapping layout (like CSS `flex-wrap`): packs subviews left-to-right and drops onto a new
/// row when the next one wouldn't fit, sizing the block to its content so a trailing VStack still
/// right-aligns it under the bubble. Fixes several thumbnails / chips overflowing one HStack off the
/// edge of a phone screen.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(maxWidth: proposal.width ?? .infinity, subviews: subviews)
        let width = rows.map(\.width).max() ?? 0
        let height = rows.reduce(CGFloat(0)) { $0 + $1.height } + spacing * CGFloat(max(0, rows.count - 1))
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(maxWidth: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for i in row.items {
                let size = subviews[i].sizeThatFits(.unspecified)
                subviews[i].place(at: CGPoint(x: x, y: y), anchor: .topLeading, proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row { var items: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }

    private func arrange(maxWidth: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = []
        var row = Row()
        for i in subviews.indices {
            let size = subviews[i].sizeThatFits(.unspecified)
            let needed = row.items.isEmpty ? size.width : row.width + spacing + size.width
            if !row.items.isEmpty, needed > maxWidth {
                rows.append(row)
                row = Row(items: [i], width: size.width, height: size.height)
            } else {
                row.width = row.items.isEmpty ? size.width : row.width + spacing + size.width
                row.height = max(row.height, size.height)
                row.items.append(i)
            }
        }
        if !row.items.isEmpty { rows.append(row) }
        return rows
    }
}
