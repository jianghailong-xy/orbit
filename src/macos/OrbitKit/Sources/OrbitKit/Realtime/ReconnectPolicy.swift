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
    /// The server sent `resync`: this cursor is too far behind to replay, so the connection is
    /// spent and the loop must re-seed its window from a tail page before connecting again.
    case resync
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
/// a sign of health. Extracted from `ConsoleModel.run()` so the ramp/reset rules are unit-tested
/// on Linux; the loop keeps the side effects (publishing state, refreshing status, sleeping).
///
/// Rules:
///  - the ramp resets only when a connection delivers its first message (`noteHealthy`). A
///    connection being accepted is not health: a proxy that accepts and then drops or closes the
///    stream before anything arrives would otherwise reconnect every 0.3–1 s forever
///    (docs/list-freshness-design.md §4 R4);
///  - a kick reconnects immediately (the kicker already knows the network is back);
///  - a clean close after a message still waits a beat (300ms) so an end-of-session close doesn't
///    hot-loop; a clean close before any message is a failed attempt like a drop;
///  - failures retry forever — a mobile outage can last minutes, and giving up would freeze the
///    session with no recovery — with backoff 1s, 2s, 4s, 8s, then capped at 15s, each stretched by
///    up to a quarter at random (`jittered`) by the loop that sleeps it, so clients a server restart
///    dropped together do not all come back in the same instant;
///  - a `resync` reconnects immediately (the caller re-seeds first) but does NOT reset the ramp:
///    re-seeding spends the same retry budget, so a stream that only ever answers with `resync`
///    still backs off instead of hot-looping (web parity: its `reseed` leaves `fails` alone).
public struct ReconnectPolicy: Sendable, Equatable {
    /// Consecutive failed attempts since the last healthy signal.
    public private(set) var attempt = 0
    /// Whether the connection now ending has delivered a message.
    public private(set) var connectionHealthy = false

    public init() {}

    /// A message (an event, or the server's keepalive) arrived on the live stream: the connection is
    /// healthy, so reset the ramp.
    public mutating func noteHealthy() {
        attempt = 0
        connectionHealthy = true
    }

    /// Decide the next step after an attempt ends with `outcome`. The next attempt is a new
    /// connection, which has to earn its health again.
    public mutating func next(after outcome: StreamOutcome) -> ReconnectAction {
        defer { connectionHealthy = false }
        switch outcome {
        case .cancelled:
            return .stop
        case .kicked:
            attempt = 0
            return .reconnect(afterMs: 0)
        case .ended where connectionHealthy:
            attempt = 0
            return .reconnect(afterMs: 300)
        case .resync:
            // Leave the ramp where it is — see the note above — and wait the same beat a clean
            // close does, so a server that somehow answered a re-seeded cursor with another
            // `resync` still can't spin this loop.
            return .reconnect(afterMs: 300)
        case .failed, .ended:
            attempt += 1
            return .reconnect(afterMs: min(15_000, 500 * (1 << min(attempt, 5))))
        }
    }

    /// `ms` stretched by up to a quarter: `unit` is a random number in 0..<1 (pinned in tests). Only
    /// ever longer than the ramp says, never shorter.
    public static func jittered(_ ms: Int, unit: Double) -> Int {
        ms + Int((Double(ms) * 0.25 * min(max(unit, 0), 1)).rounded(.down))
    }
}
