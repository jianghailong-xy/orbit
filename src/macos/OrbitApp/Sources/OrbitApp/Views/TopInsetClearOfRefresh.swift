import SwiftUI
#if os(iOS)
import UIKit
import OrbitKit
#endif

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
    /// And a list a refresh has just let go of doesn't always come to rest at its top: iOS hid the
    /// control partway through the list's return, and the list jumped to its top and then went on
    /// by what was left of the return — 1.7 to 56.7pt past it, in 18 of the 49 refreshes the
    /// simulator's UI tests pulled, with the needs-you bar and without it, every one among the
    /// first two after a launch (none of the 8 the app started itself). So once a refresh has
    /// ended, a list left past its top by less than the control's band, and untouched since, goes
    /// back there (`RefreshControlClearance.returnsToTop`): all 7 that did so in the run that
    /// measured it, one of them after a 4s stall of the main thread.
    ///
    /// Measured on the iOS 26.5 simulator (iPhone 17 Pro) through a throwaway probe app that is
    /// not kept. Wherever the control isn't hosted by the navigation bar — macOS draws none — this
    /// is the bare inset.
    func topInsetClearOfRefresh<Bands: View>(@ViewBuilder _ bands: () -> Bands) -> some View {
        #if os(iOS)
        return modifier(TopInsetClearOfRefresh(bands: bands()))
        #else
        let content = bands()
        return safeAreaInset(edge: .top, spacing: 0) { content }
        #endif
    }
}

#if os(iOS)
private struct TopInsetClearOfRefresh<Bands: View>: ViewModifier {
    let bands: Bands
    /// UIKit's side of this, which nothing on screen reads: a reference SwiftUI doesn't observe,
    /// so a change to it is a transform on the control and never a body pass.
    @State private var placement = RefreshControlPlacement()

    func body(content: Content) -> some View {
        content
            .background { RefreshControlLocator(placement: placement) }
            .safeAreaInset(edge: .top, spacing: 0) {
                // In a stack, so a frame is reported — at zero height — while the bands are empty
                // too: an `if` with nothing to show has no geometry to report, and the last frame
                // would go on moving the control for bands no longer there.
                VStack(spacing: 0) { bands }
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: {
                        placement.bands = $0
                    }
            }
    }
}

/// Where the list's refresh control is drawn — moved down past the bands while its band overlaps
/// them, wherever UIKit puts it otherwise — and the list put back at its top when a refresh leaves
/// it just past there.
@MainActor
private final class RefreshControlPlacement: NSObject {
    weak var scrollView: UIScrollView? {
        didSet {
            guard scrollView !== oldValue else { return }
            oldValue?.panGestureRecognizer.removeTarget(self, action: #selector(dragged(_:)))
            scrollView?.panGestureRecognizer.addTarget(self, action: #selector(dragged(_:)))
            place()
        }
    }
    /// The bands' frame in the window. It moves exactly when the shift has to change: when a band
    /// comes or goes, and when a refresh starts or ends (iOS moves the bands below the control's
    /// band and back). Nothing on the way down a pull moves it, and UIKit leaves the shift alone
    /// meanwhile.
    var bands: CGRect = .zero { didSet { place() } }
    /// Whether the control was refreshing when last placed. The bands move as a refresh ends, so
    /// that is when it is seen to have stopped.
    private var wasRefreshing = false
    /// The ended refresh whose list is being watched back to its top, until it gets there or the
    /// reader takes it.
    private var settling: UUID?

    func place() {
        // Only the arrangement that was measured: the control hosted by the navigation bar.
        guard let control = scrollView?.refreshControl,
              control.superview?.superview is UINavigationBar else { return }
        if wasRefreshing, !control.isRefreshing { refreshEnded() }
        wasRefreshing = control.isRefreshing
        let band = control.convert(control.bounds, to: nil)
            .offsetBy(dx: 0, dy: -control.transform.ty)
        let shift = CGFloat(RefreshControlClearance.shift(
            bandTop: band.minY, bandBottom: band.maxY,
            bandsTop: bands.minY, bandsBottom: bands.maxY))
        guard control.transform.ty != shift else { return }
        control.transform = CGAffineTransform(translationX: 0, y: shift)
    }

    /// The list's return takes about a third of a second; it is looked at twice after that.
    private func refreshEnded() {
        let refresh = UUID()
        settling = refresh
        for delay in [0.8, 1.6] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self, settling == refresh else { return }
                returnToTop()
            }
        }
    }

    private func returnToTop() {
        guard let scrollView, let control = scrollView.refreshControl,
              !scrollView.isTracking, !scrollView.isDecelerating else { return }
        let top = -scrollView.adjustedContentInset.top
        let pastTop = scrollView.contentOffset.y - top
        let band = control.bounds.height
        guard RefreshControlClearance.returnsToTop(pastTop: pastTop, bandHeight: band) else {
            return
        }
        settling = nil
        scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: top),
                                    animated: true)
    }

    /// The reader's own drag after a refresh is theirs to keep: the list is no longer watched.
    @objc private func dragged(_ pan: UIPanGestureRecognizer) {
        if pan.state == .began { settling = nil }
    }
}

/// Finds the list's scroll view from behind it, the way the console's `ScrollTouchConfigurator`
/// does — the nearest one, up the ancestors scanning each one's subtree — and takes it only once
/// it carries a refresh control. A list that doesn't refresh is left alone rather than reached
/// past: walking on to the first scroll view that does refresh could find another screen's list,
/// such as the one under a sheet, and move its control.
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
            // Off screen, the list is let go, and its drag with it; back on, it is found again.
            if window == nil {
                placement.scrollView = nil
            } else {
                locate()
            }
        }

        func locate() {
            guard placement.scrollView == nil else {
                placement.place()
                return
            }
            // Off the layout pass: the scroll view and its control are UIKit's, and neither need
            // exist yet on the first update.
            DispatchQueue.main.async { [weak self] in
                guard let self, placement.scrollView == nil,
                      let nearest = Self.nearestScrollView(from: self),
                      nearest.refreshControl != nil else { return }
                placement.scrollView = nearest
            }
        }

        private static func nearestScrollView(from view: UIView) -> UIScrollView? {
            var node = view.superview
            while let current = node {
                if let scrollView = current as? UIScrollView { return scrollView }
                if let scrollView = firstScrollView(in: current) { return scrollView }
                node = current.superview
            }
            return nil
        }

        private static func firstScrollView(in view: UIView) -> UIScrollView? {
            for sub in view.subviews {
                if let scrollView = sub as? UIScrollView { return scrollView }
                if let scrollView = firstScrollView(in: sub) { return scrollView }
            }
            return nil
        }
    }
}
#endif
