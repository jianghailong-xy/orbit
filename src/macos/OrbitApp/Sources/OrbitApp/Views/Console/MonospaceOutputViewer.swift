import SwiftUI
import Foundation
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

// A dedicated viewport for a raw tool result that is too large to live inside one transcript List
// cell. The iOS implementation deliberately uses a scroll-enabled UITextView without asking it for
// its full fitted height: TextKit 2 can lay out the visible viewport incrementally, while SwiftUI's
// `Text` would synchronously turn a 15k-line result into a several-hundred-thousand-point cell.

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
                ScrollableMonospaceText(text: text)
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
}

#if os(iOS)
private struct ScrollableMonospaceText: UIViewRepresentable {
    let text: String
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    final class Coordinator {
        var text: String?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView(usingTextLayoutManager: true)
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = true
        view.alwaysBounceVertical = true
        view.backgroundColor = .clear
        view.textColor = .secondaryLabel
        view.textContainerInset = UIEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
        view.textContainer.lineFragmentPadding = 0
        view.textContainer.lineBreakMode = .byWordWrapping
        view.adjustsFontForContentSizeCategory = false
        view.font = resolvedFont
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        view.font = resolvedFont
        guard context.coordinator.text != text else { return }
        context.coordinator.text = text
        view.text = text
        view.setContentOffset(.zero, animated: false)
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
