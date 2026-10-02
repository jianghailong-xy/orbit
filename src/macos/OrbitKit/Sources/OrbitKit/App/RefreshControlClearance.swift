import Foundation

/// How far a list's refresh control moves down to stay off the bands pinned over the list's top,
/// kept out of the view because only this package builds and tests on Linux.
///
/// On iOS 26 the navigation bar hosts the control, as a band hanging under the bar, and draws it
/// over whatever the list insets at its top: a pull drew the spinner on the session list's "… needs
/// you" bar. Once the refresh starts, iOS folds the band into the bar and moves the bands below it,
/// so a shift held through the refresh would put the band back on them. The rule is therefore
/// overlap, not state: while the control's band and the bands overlap, the band moves down to start
/// where the bands end; otherwise it stays where UIKit put it. (`topInsetClearOfRefresh` in the app
/// has the measurements.)
///
/// Edges are window y coordinates in points, the band's as UIKit places it, before any shift.
public enum RefreshControlClearance {
    public static func shift(bandTop: Double, bandBottom: Double,
                             bandsTop: Double, bandsBottom: Double) -> Double {
        guard bandsBottom > bandsTop, bandsTop < bandBottom, bandsBottom > bandTop else { return 0 }
        return bandsBottom - bandTop
    }
}
