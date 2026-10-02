#if os(iOS)
import SwiftUI
import UIKit
import OrbitKit

extension View {
    /// `.safeAreaInset(edge: .top)` for a list that pulls to refresh: the same bands pinned over
    /// the list, with the pull's spinner kept off them.
    ///
    /// On iOS 26 the list doesn't draw its refresh control. The navigation bar hosts it, as a
    /// 60pt band hanging under the bar (116–176 in window coordinates on an iPhone 17 Pro), so it
    /// draws over whatever the list insets at its top: a pull drew the spinner on the session
    /// list's "… needs you" bar (116–154.3), which is how it was reported. Once the refresh
    /// starts, iOS folds the band into the bar — the list's safe area grows from 154.3 to 214.3
    /// and the inset drops to 176–214.3, under the spinner — so the overlap belongs to the pull
    /// alone, before the refresh has started.
    ///
    /// So the control moves down past the bands while — and only while — its band overlaps them
    /// (`RefreshControlClearance`, the tested rule). Mid-pull the spinner sits in the 60pt under
    /// the bands, where a list with nothing inset has it under the bar; from the moment the
    /// refresh starts it is back in the bar's band, above the bands iOS has just moved below it. A
    /// shift held at the bands' height throughout was measured too: it put the spinner's band over
    /// the bar for the entire refresh instead.
    ///
    /// Measured on the iOS 26.5 simulator (iPhone 17 Pro) through a throwaway probe app that is
    /// not kept. Wherever the control isn't hosted by the navigation bar, this is the bare inset.
    func topInsetClearOfRefresh<Bands: View>(@ViewBuilder _ bands: () -> Bands) -> some View {
        modifier(TopInsetClearOfRefresh(bands: bands()))
    }
}

private struct TopInsetClearOfRefresh<Bands: View>: ViewModifier {
    let bands: Bands
    /// UIKit's side of this, which nothing on screen reads: a reference SwiftUI doesn't observe,
    /// so a change to it is a transform on the control and never a body pass.
    @State private var placement = RefreshControlPlacement()

    func body(content: Content) -> some View {
        content
            .background { RefreshControlLocator(placement: placement) }
            .safeAreaInset(edge: .top, spacing: 0) {
                bands.onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: {
                    placement.bands = $0
                }
            }
    }
}

/// Where the list's refresh control is drawn: moved down past the bands while its band overlaps
/// them, and wherever UIKit puts it otherwise.
@MainActor
private final class RefreshControlPlacement {
    weak var scrollView: UIScrollView? { didSet { place() } }
    /// The bands' frame in the window. It moves exactly when the shift has to change: when a band
    /// comes or goes, and when a refresh starts or ends (iOS moves the bands below the control's
    /// band and back). Nothing on the way down a pull moves it, and UIKit leaves the shift alone
    /// meanwhile.
    var bands: CGRect = .zero { didSet { place() } }

    func place() {
        // Only the arrangement that was measured: the control hosted by the navigation bar.
        guard let control = scrollView?.refreshControl,
              control.superview?.superview is UINavigationBar else { return }
        let band = control.convert(control.bounds, to: nil)
            .offsetBy(dx: 0, dy: -control.transform.ty)
        let shift = CGFloat(RefreshControlClearance.shift(
            bandTop: band.minY, bandBottom: band.maxY, bandsTop: bands.minY, bandsBottom: bands.maxY))
        guard control.transform.ty != shift else { return }
        control.transform = CGAffineTransform(translationX: 0, y: shift)
    }
}

/// Finds the list's scroll view from behind it, the way the console's `ScrollTouchConfigurator`
/// does — up the ancestors, scanning each one's subtree — but only a scroll view that carries a
/// refresh control, so no other list on screen is the one moved.
private struct RefreshControlLocator: UIViewRepresentable {
    let placement: RefreshControlPlacement

    func makeUIView(context: Context) -> LocatorView { LocatorView(placement: placement) }

    // A control installed after the first look is found on a later update.
    func updateUIView(_ view: LocatorView, context: Context) { view.locate() }

    final class LocatorView: UIView {
        let placement: RefreshControlPlacement

        init(placement: RefreshControlPlacement) {
            self.placement = placement
            super.init(frame: .zero)
            isUserInteractionEnabled = false   // inert: only introspects, never intercepts touches
        }
        required init?(coder: NSCoder) { fatalError("not used") }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            locate()
        }

        func locate() {
            guard placement.scrollView == nil else {
                placement.place()
                return
            }
            // Off the layout pass: the scroll view and its control are UIKit's, and neither need
            // exist yet on the first update.
            DispatchQueue.main.async { [weak self] in
                guard let self, placement.scrollView == nil else { return }
                var node = superview
                while let current = node {
                    if let found = Self.refreshingScrollView(in: current) {
                        placement.scrollView = found
                        return
                    }
                    node = current.superview
                }
            }
        }

        private static func refreshingScrollView(in view: UIView) -> UIScrollView? {
            if let scrollView = view as? UIScrollView, scrollView.refreshControl != nil {
                return scrollView
            }
            for sub in view.subviews {
                if let scrollView = refreshingScrollView(in: sub) { return scrollView }
            }
            return nil
        }
    }
}
#endif
