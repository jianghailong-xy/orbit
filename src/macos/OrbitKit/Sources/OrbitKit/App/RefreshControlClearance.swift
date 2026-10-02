import Foundation

/// How a list that pulls to refresh under pinned bands keeps its refresh control off them, and
/// comes back to its top afterwards, kept out of the view because only this package builds and
/// tests on Linux. (`topInsetClearOfRefresh` in the app has the measurements.)
///
/// Edges are window y coordinates in points, the band's as UIKit places it, before any shift.
public enum RefreshControlClearance {
    /// How far down the control's band moves.
    ///
    /// On iOS 26 the navigation bar hosts the control, as a band hanging under the bar, and draws
    /// it over whatever the list insets at its top: a pull drew the spinner on the session list's
    /// "… needs you" bar. Once the refresh starts, iOS folds the band into the bar and moves the
    /// bands below it, so a shift held through the refresh would put the band back on them. The
    /// rule is therefore overlap, not state: while the control's band and the bands overlap, the
    /// band moves down to start where the bands end; otherwise it stays where UIKit put it.
    public static func shift(bandTop: Double, bandBottom: Double,
                             bandsTop: Double, bandsBottom: Double) -> Double {
        guard bandsBottom > bandsTop, bandsTop < bandBottom, bandsBottom > bandTop else { return 0 }
        return bandsBottom - bandTop
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
