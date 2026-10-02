import Foundation

/// How a list that pulls to refresh under pinned bands keeps them pinned and its refresh control
/// under them, and comes back to its top afterwards, kept out of the view because only this package
/// builds and tests on Linux. (`topInsetClearOfRefresh` in the app has the measurements.)
///
/// Edges are window y coordinates in points. The band is the control's as UIKit places it, before
/// any shift: hanging from the navigation bar's resting bottom, which is where the bands rest.
public enum RefreshControlClearance {
    /// How far the bands are drawn back up: as far as iOS has pushed them below where they rest,
    /// and no further than the control's band, which is what it pushes them down by.
    ///
    /// Once a refresh starts, iOS folds the control's band into the navigation bar and lays the
    /// bands out below it for as long as the refresh runs. With the band moved under the bands for
    /// the pull, that put the spinner below the needs-you bar while pulling and above it while
    /// refreshing — reported as a spinner that couldn't decide which side to be on. Drawn back up,
    /// the bands don't move at all.
    public static func lift(bandTop: Double, bandBottom: Double, bandsTop: Double) -> Double {
        min(bandBottom - bandTop, max(0, bandsTop - bandTop))
    }

    /// How far down the control's band moves: to start where the bands end, as they are drawn,
    /// while they overlap it at all.
    ///
    /// On iOS 26 the navigation bar hosts the control, as a band hanging under the bar, and draws
    /// it over whatever the list insets at its top: a pull drew the spinner on the session list's
    /// "… needs you" bar. Under the bands it stays, the pull and the refresh alike.
    public static func shift(bandTop: Double, bandBottom: Double,
                             bandsTop: Double, bandsBottom: Double) -> Double {
        let lift = lift(bandTop: bandTop, bandBottom: bandBottom, bandsTop: bandsTop)
        let top = bandsTop - lift
        let bottom = bandsBottom - lift
        guard bottom > top, top < bandBottom, bottom > bandTop else { return 0 }
        return bottom - bandTop
    }

    /// Whether a list that a finished refresh has left `pastTop` points past its top, untouched
    /// since, goes back there.
    ///
    /// A refresh doesn't always end with the list at its top: iOS hid the control partway through
    /// the list's return, and the list jumped to its top and then went on by what was left of the
    /// return. So it comes to rest past its top by less than the control's band. Anything further
    /// is somewhere a reader put it (or rows the refresh added), and a fraction of a point is
    /// nowhere at all.
    public static func returnsToTop(pastTop: Double, bandHeight: Double) -> Bool {
        pastTop > 0.5 && pastTop <= bandHeight + 2
    }
}
