import Foundation

/// How one live-stream connection attempt ended, as seen by a reconnecting consume loop
/// (`ConsoleModel.run()` and the control-plane stream share this vocabulary).
public enum StreamOutcome: Sendable, Equatable {
    /// The server closed the stream cleanly (its event source completed).
    case ended
    /// The connection dropped or errored mid-read.
    case failed
    /// `reconnectNow()` interrupted the attempt — the network came back or the app foregrounded —
    /// so reconnect immediately rather than waiting out a backoff.
    case kicked
    /// The consume loop's task was cancelled (model teardown / focus moved away).
    case cancelled
}

/// What the loop should do after an attempt ends.
public enum ReconnectAction: Sendable, Equatable {
    /// Exit the loop.
    case stop
    /// Sleep `afterMs` (interruptible by a kick), then connect again.
    case reconnect(afterMs: Int)
}

/// Pure decision core of the SSE reconnect loop: maps each attempt's outcome to wait-then-retry
/// or stop, ramping capped exponential backoff across consecutive failures and resetting it on
/// any sign of health. Extracted from `ConsoleModel.run()` so the ramp/reset rules are unit-tested
/// on Linux; the loop keeps the side effects (publishing state, refreshing status, sleeping).
///
/// Rules, verbatim from the loop it replaces:
///  - a healthy event (`noteHealthy`) or a clean server close resets the ramp;
///  - a kick reconnects immediately (the kicker already knows the network is back);
///  - a clean close still waits a beat (300ms) so an end-of-session close doesn't hot-loop;
///  - failures retry forever — a mobile outage can last minutes, and giving up would freeze the
///    session with no recovery — with backoff 1s, 2s, 4s, 8s, then capped at 15s.
public struct ReconnectPolicy: Sendable, Equatable {
    /// Consecutive failed attempts since the last healthy signal.
    public private(set) var attempt = 0

    public init() {}

    /// An event arrived on the live stream — the connection is healthy; reset the ramp.
    public mutating func noteHealthy() {
        attempt = 0
    }

    /// Decide the next step after an attempt ends with `outcome`.
    public mutating func next(after outcome: StreamOutcome) -> ReconnectAction {
        switch outcome {
        case .cancelled:
            return .stop
        case .kicked:
            attempt = 0
            return .reconnect(afterMs: 0)
        case .ended:
            attempt = 0
            return .reconnect(afterMs: 300)
        case .failed:
            attempt += 1
            return .reconnect(afterMs: min(15_000, 500 * (1 << min(attempt, 5))))
        }
    }
}
