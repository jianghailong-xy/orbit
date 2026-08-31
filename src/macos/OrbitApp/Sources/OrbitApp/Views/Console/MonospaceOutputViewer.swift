import SwiftUI
import Foundation
import Observation
import OrbitKit
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

// A dedicated viewport for a raw tool result that is too large to live inside one transcript List
// cell. The iOS implementation deliberately uses a scroll-enabled UITextView without asking it for
// its full fitted height: TextKit 2 can lay out the visible viewport incrementally, while SwiftUI's
// `Text` would synchronously turn a 15k-line result into a several-hundred-thousand-point cell.
//
// That incremental layout is also why iOS gets its own scrub rail instead of the system scroll
// indicator: a 15k-line result is minutes of flicking, the system indicator is a 3pt sliver you
// have to press and hold to grab, and the height it reports is only an estimate of the part TextKit
// has laid out. The rail is a grabbable handle, and the disc above it jumps to the true end.

/// Width of the iOS scrub rail, and the right text inset that keeps output from running under it.
private let outputRailWidth: CGFloat = 22

extension View {
    @ViewBuilder
    func monospaceOutputViewer(
        isPresented: Binding<Bool>,
        text: String,
        lineCount: Int,
        title: String = "Tool output"
    ) -> some View {
        #if os(iOS)
        fullScreenCover(isPresented: isPresented) {
            MonospaceOutputViewer(text: text, lineCount: lineCount, title: title)
        }
        #else
        sheet(isPresented: isPresented) {
            MonospaceOutputViewer(text: text, lineCount: lineCount, title: title)
        }
        #endif
    }
}

private struct MonospaceOutputViewer: View {
    let text: String
    let lineCount: Int
    let title: String
    @Environment(\.dismiss) private var dismiss
    @State private var copied = false
    #if os(iOS)
    // Held, never read here: only the rail reads `progress`, so a flick's per-frame updates
    // invalidate the rail alone. Reading it in this body would rebuild the text view's
    // representable — and re-apply its font — sixty times a second, discarding TextKit's layout.
    @State private var scroll = OutputScroll()
    #endif

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack {
                    Text("\(lineCount.formatted()) \(lineCount == 1 ? "line" : "lines")")
                        .font(.orbitMeta)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                Divider()
                output
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .navigationTitle(title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        PlatformPasteboard.copyString(text)
                        PlatformHaptics.success()
                        copied = true
                    } label: {
                        Label(copied ? "Copied" : "Copy all",
                              systemImage: copied ? "checkmark" : "doc.on.doc")
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 720, minHeight: 520)
        #endif
        .onChange(of: text) { copied = false }
    }

    /// macOS already has a real, draggable scroller on its `NSScrollView`, so only iOS overlays one.
    @ViewBuilder
    private var output: some View {
        #if os(iOS)
        ScrollableMonospaceText(text: text, scroll: scroll)
            .overlay { ScrubRail(scroll: scroll) }
        #else
        ScrollableMonospaceText(text: text)
        #endif
    }
}

#if os(iOS)
/// Owns the viewer's text view so the rail can drive it, and republishes where the viewport sits so
/// the handle follows ordinary finger scrolling too.
@Observable
private final class OutputScroll {
    /// Position of the viewport in the output, 0…1. The rail is the only reader.
    var progress: Double = 0

    @ObservationIgnored weak var view: UITextView?

    /// Raised while this object is the one moving the text view. The resulting `scrollViewDidScroll`
    /// must not drag the handle back to the estimated position it just left — and, during a reset,
    /// must not publish from inside a SwiftUI view update.
    @ObservationIgnored private var ignoresScrollFeedback = false

    func publish() {
        guard let view, !ignoresScrollFeedback else { return }
        progress = ScrubRailGeometry.progress(offset: Double(view.contentOffset.y),
                                              minOffset: Self.minOffset(view),
                                              maxOffset: Self.maxOffset(view))
    }

    func scroll(toProgress target: Double) {
        guard let view else { return }
        ignoresScrollFeedback = true
        let y = ScrubRailGeometry.offset(forProgress: target,
                                         minOffset: Self.minOffset(view),
                                         maxOffset: Self.maxOffset(view))
        view.setContentOffset(CGPoint(x: 0, y: y), animated: false)
        progress = target
        ignoresScrollFeedback = false
    }

    /// The end of the output is not `contentSize`: TextKit 2 has only measured the part it laid out,
    /// so the last line of a 15k-line result sits below whatever height the scroll view currently
    /// advertises. Reveal the final text position first — that lays the tail out, and is the one
    /// place this viewer pays for layout it has been avoiding — then pin to the bottom the
    /// now-measured content reports, and again next runloop once that height has settled.
    func scrollToEnd() {
        guard let view else { return }
        view.scrollRangeToVisible(NSRange(location: ((view.text ?? "") as NSString).length, length: 0))
        pinToEnd(view)
        DispatchQueue.main.async { [weak self] in
            guard let self, let view = self.view else { return }
            self.pinToEnd(view)
        }
    }

    /// Called from `updateUIView`, so the publish waits a runloop: mutating observed state inside a
    /// SwiftUI update is exactly what "Modifying state during view update" warns about.
    func resetToTop(_ view: UITextView) {
        ignoresScrollFeedback = true
        view.setContentOffset(CGPoint(x: 0, y: Self.minOffset(view)), animated: false)
        DispatchQueue.main.async { [weak self] in
            self?.progress = 0
            self?.ignoresScrollFeedback = false
        }
    }

    private func pinToEnd(_ view: UITextView) {
        ignoresScrollFeedback = true
        view.setContentOffset(CGPoint(x: 0, y: Self.maxOffset(view)), animated: false)
        progress = 1
        ignoresScrollFeedback = false
    }

    /// The top and bottom resting offsets, which are not 0 and `contentSize.height`: a scroll view
    /// under a safe-area inset rests at a negative offset.
    private static func minOffset(_ view: UIScrollView) -> Double {
        -Double(view.adjustedContentInset.top)
    }

    private static func maxOffset(_ view: UIScrollView) -> Double {
        max(minOffset(view),
            Double(view.contentSize.height + view.adjustedContentInset.bottom - view.bounds.height))
    }
}

/// The trailing-edge scrub handle plus the jump-to-end disc. Drawn over the text view rather than
/// beside it, and hit-testable only where it draws, so scrolling the output with a finger is
/// unaffected everywhere else.
private struct ScrubRail: View {
    let scroll: OutputScroll

    private let thumbHeight: CGFloat = 44
    private let space: NamedCoordinateSpace = .named("orbit.monospaceOutput.rail")

    var body: some View {
        GeometryReader { geo in
            let rail = ScrubRailGeometry(trackHeight: Double(geo.size.height),
                                         thumbHeight: Double(thumbHeight))
            handle(rail)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                // Only while there is still output below: at the end the disc would do nothing, the
                // same rule the transcript's jump-to-latest puck follows.
                .overlay(alignment: .bottomTrailing) { if scroll.progress < 0.999 { jumpToEndDisc } }
                .coordinateSpace(space)
        }
    }

    private func handle(_ rail: ScrubRailGeometry) -> some View {
        Capsule()
            .fill(.primary.opacity(0.32))
            .frame(width: 4, height: thumbHeight)
            .frame(width: outputRailWidth, height: thumbHeight)
            // Grabbing a 4pt bar with a finger needs a target the bar's own width can't give it, so
            // the hit area reaches 44pt inwards while the mark stays on the edge.
            .padding(.leading, 44 - outputRailWidth)
            .contentShape(Rectangle())
            .offset(y: CGFloat(rail.thumbTop(forProgress: scroll.progress)))
            .gesture(
                // minimumDistance 0: the handle must start moving on contact, not after the drag
                // threshold a scroll gesture would need.
                DragGesture(minimumDistance: 0, coordinateSpace: space)
                    .onChanged { scroll.scroll(toProgress: rail.progress(forThumbCenter: Double($0.location.y))) }
                    .onEnded { value in
                        let target = rail.progress(forThumbCenter: Double(value.location.y))
                        // Dragged to the floor: land on the real last line, not on the estimated
                        // bottom the rail has been scrubbing against.
                        if target >= 1 { scroll.scrollToEnd() } else { scroll.scroll(toProgress: target) }
                    }
            )
            .accessibilityHidden(true)
    }

    private var jumpToEndDisc: some View {
        Button { scroll.scrollToEnd() } label: {
            Image(systemName: "arrow.down.to.line")
                .font(.orbitControlGlyph)
                .foregroundStyle(.primary)
                .frame(width: 40, height: 40)
                .background { Circle().fill(Color.floatingDiscSurface) }
                .shadow(color: .black.opacity(0.14), radius: 7, y: 2)
        }
        .buttonStyle(.plain)
        .contentShape(Circle())
        .accessibilityLabel("Jump to end")
        .padding(.trailing, outputRailWidth + 6)
        .padding(.bottom, 14)
    }
}

private struct ScrollableMonospaceText: UIViewRepresentable {
    let text: String
    let scroll: OutputScroll
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    final class Coordinator: NSObject, UITextViewDelegate {
        let scroll: OutputScroll
        var text: String?

        init(scroll: OutputScroll) { self.scroll = scroll }

        func scrollViewDidScroll(_ scrollView: UIScrollView) { scroll.publish() }
    }

    func makeCoordinator() -> Coordinator { Coordinator(scroll: scroll) }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView(usingTextLayoutManager: true)
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = true
        view.alwaysBounceVertical = true
        view.backgroundColor = .clear
        view.textColor = .secondaryLabel
        // Right inset, not 12: output must not run under the rail drawn over this edge.
        view.textContainerInset = UIEdgeInsets(top: 12, left: 12, bottom: 12, right: outputRailWidth)
        view.textContainer.lineFragmentPadding = 0
        view.textContainer.lineBreakMode = .byWordWrapping
        view.adjustsFontForContentSizeCategory = false
        view.font = resolvedFont
        // The rail stands in for the system indicator; two bars on one edge read as a glitch.
        view.showsVerticalScrollIndicator = false
        view.delegate = context.coordinator
        scroll.view = view
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        view.font = resolvedFont
        guard context.coordinator.text != text else { return }
        context.coordinator.text = text
        view.text = text
        scroll.resetToTop(view)
    }

    private var resolvedFont: UIFont {
        _ = dynamicTypeSize
        let pointSize = UIFont.preferredFont(forTextStyle: .footnote).pointSize
        return UIFont.monospacedSystemFont(ofSize: pointSize, weight: .regular)
    }
}
#elseif os(macOS)
private struct ScrollableMonospaceText: NSViewRepresentable {
    let text: String

    final class Coordinator {
        var text: String?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSScrollView {
        // AppKit's factory wires the document view, clip view, text container and autoresizing
        // together before SwiftUI supplies a non-zero frame. Building that stack from `.zero`
        // leaves the first text-container width at zero on some macOS layouts.
        let scroll = NSTextView.scrollableTextView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true

        guard let view = scroll.documentView as? NSTextView else { return scroll }
        view.isEditable = false
        view.isSelectable = true
        view.isRichText = false
        view.drawsBackground = false
        view.textColor = .secondaryLabelColor
        view.font = NSFont.monospacedSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)
        view.textContainerInset = NSSize(width: 12, height: 12)
        view.isVerticallyResizable = true
        view.isHorizontallyResizable = false
        view.textContainer?.widthTracksTextView = true
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let view = scroll.documentView as? NSTextView,
              context.coordinator.text != text else { return }
        context.coordinator.text = text
        view.string = text
        view.scrollToBeginningOfDocument(nil)
    }
}
#endif
