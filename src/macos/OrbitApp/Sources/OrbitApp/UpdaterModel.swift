import Foundation
import Combine
import Sparkle

/// Owns Sparkle's updater. Exposes whether a manual "Check for Updates…" is possible right now,
/// plus a beta-channel opt-in. Stable releases carry no channel (everyone gets them); beta
/// releases are tagged `<sparkle:channel>beta</sparkle:channel>` in the appcast and only reach
/// users who flip the toggle.
///
/// Like `NotificationManager`, Sparkle needs a real .app bundle — under `swift run` the binary is
/// unbundled (no bundle identifier, no SUFeedURL/SUPublicEDKey), so the updater is only started
/// when bundled. Dev runs just leave "Check for Updates…" disabled.
final class UpdaterModel: ObservableObject {
    private let controller: SPUStandardUpdaterController
    private let channelDelegate: ChannelDelegate

    @Published private(set) var canCheckForUpdates = false
    @Published var betaChannel: Bool {
        didSet {
            UserDefaults.standard.set(betaChannel, forKey: Self.betaDefaultsKey)
            channelDelegate.betaEnabled = betaChannel
        }
    }

    private static let betaDefaultsKey = "ReceiveBetaUpdates"

    init() {
        let beta = UserDefaults.standard.bool(forKey: Self.betaDefaultsKey)
        let delegate = ChannelDelegate()
        delegate.betaEnabled = beta
        channelDelegate = delegate
        betaChannel = beta

        // Only start the updater when a feed is configured — release builds inject SUFeedURL;
        // dev `swift run` / unsigned local .apps have none, so the updater stays idle and the
        // menu item disabled rather than erroring on a missing feed.
        let hasFeed = Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") != nil
        controller = SPUStandardUpdaterController(
            startingUpdater: hasFeed,
            updaterDelegate: delegate,
            userDriverDelegate: nil
        )
        controller.updater.publisher(for: \.canCheckForUpdates)
            .assign(to: &$canCheckForUpdates)
    }

    func checkForUpdates() {
        controller.updater.checkForUpdates()
    }
}

/// Sparkle delegate that opts the user into the `beta` channel when enabled. Stable appcast items
/// carry no channel and reach everyone; only `beta`-tagged items are offered to opted-in users.
private final class ChannelDelegate: NSObject, SPUUpdaterDelegate {
    var betaEnabled = false
    func allowedChannels(for updater: SPUUpdater) -> Set<String> {
        betaEnabled ? ["beta"] : []
    }
}
