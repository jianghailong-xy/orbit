import SwiftUI
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

// Cross-platform shims so the shared SwiftUI layer compiles for both the macOS shell (this SPM
// package) and the iOS shell (the src/ios Xcode target, which references these same files). Only
// the handful of AppKit/UIKit touch-points differ — images, the pasteboard, a dynamic colour, and
// one macOS-only menu style — so they live here behind a single alias/helper instead of being
// scattered as `#if os(...)` islands across every view.

#if os(macOS)
/// The platform bitmap image type: `NSImage` on macOS, `UIImage` on iOS. Both expose `init?(data:)`.
typealias PlatformImage = NSImage
#elseif os(iOS)
typealias PlatformImage = UIImage
#endif

extension Image {
    /// `Image(nsImage:)` / `Image(uiImage:)` behind one name.
    init(platformImage: PlatformImage) {
        #if os(macOS)
        self.init(nsImage: platformImage)
        #elseif os(iOS)
        self.init(uiImage: platformImage)
        #endif
    }
}

extension PlatformImage {
    /// Re-encode to PNG. The clipboard/screenshot bytes commonly arrive as TIFF or JPEG, neither of
    /// which the server accepts as an inline image; PNG is in `Attachments.allowedImageTypes`.
    func orbitPNGData() -> Data? {
        #if os(macOS)
        guard let tiff = tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return rep.representation(using: .png, properties: [:])
        #elseif os(iOS)
        return pngData()
        #endif
    }
}

/// Copy plain text to the system pasteboard — `NSPasteboard` on macOS, `UIPasteboard` on iOS.
enum PlatformPasteboard {
    static func copyString(_ s: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
        #elseif os(iOS)
        UIPasteboard.general.string = s
        #endif
    }
}

extension Color {
    /// A colour that resolves to `light` or `dark` per the active appearance. SwiftUI has no
    /// built-in light/dark `Color`, so this bridges through the platform colour's dynamic provider.
    init(light: Color, dark: Color) {
        #if os(macOS)
        self.init(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? NSColor(dark) : NSColor(light)
        })
        #elseif os(iOS)
        self.init(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? UIColor(dark) : UIColor(light)
        })
        #endif
    }
}

extension View {
    /// The composer's borderless menu chrome. macOS has `BorderlessButtonMenuStyle`; iOS has no
    /// equivalent, so there it falls back to the default menu style (a plain tappable label).
    @ViewBuilder func borderlessMenuStyle() -> some View {
        #if os(macOS)
        self.menuStyle(.borderlessButton)
        #else
        self
        #endif
    }
}
