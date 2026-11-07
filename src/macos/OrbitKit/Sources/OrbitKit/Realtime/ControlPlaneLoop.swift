import Foundation

/// What the control-plane loop tells the app.
public enum ControlPlaneSignal: Sendable, Equatable {
    /// The stream connected (HTTP 200): reconcile what is on screen, then follow the events.
    case live
    /// One control event, to route (`ControlEventRoute`).
    case event(ControlEvent)
    /// The connection is gone; the loop waits to connect again, or has stopped.
    case down
}

/// The always-on control-plane stream's reconnecting consume loop (`GET /api/events`), taken out of
/// `AppModel` so its reconnect rules run under test with a scripted stream and a recorded sleep
/// (docs/list-freshness-design.md §4 R4):
///  - a connection becomes healthy, and the backoff resets, on its first message — an event or the
///    server's keepalive — never on being accepted (`ReconnectPolicy`);
///  - every wait is jittered (`ReconnectPolicy.jittered`);
///  - a 401 refreshes the session and connects again after the failure's backoff. It used to stop
///    the stream until the app was relaunched, leaving the poll alone in charge. A session that
///    cannot be refreshed is the REST path's to sign out, which cancels this loop;
///  - a 404 — a server without the stream — stops it, and polling stays in charge for the sign-in.
///
/// Signals are awaited in order: an event that arrives while the app reconciles after `.live` waits
/// for that reconcile, so the snapshot it reads can never land on top of a newer event.
@MainActor
public struct ControlPlaneLoop {
    let stream: ControlPlaneStreaming
    let refreshSession: () async -> Bool
    let sleep: (Int) async -> Void
    let jitter: () -> Double

    /// `sleep` waits that many milliseconds; `jitter` is a random number in 0..<1 per wait. Tests
    /// record the one and pin the other.
    public init(stream: ControlPlaneStreaming,
                refreshSession: @escaping () async -> Bool,
                sleep: @escaping (Int) async -> Void,
                jitter: @escaping () -> Double = { Double.random(in: 0..<1) }) {
        self.stream = stream
        self.refreshSession = refreshSession
        self.sleep = sleep
        self.jitter = jitter
    }

    /// Connect, follow, and reconnect until the task is cancelled or the server has no stream.
    public func run(_ signal: (ControlPlaneSignal) async -> Void) async {
        var policy = ReconnectPolicy()
        while !Task.isCancelled {
            var outcome = StreamOutcome.ended
            do {
                for try await item in stream.events() {
                    switch item {
                    case .connected:
                        await signal(.live)
                    case .keepalive:
                        policy.noteHealthy()
                    case .event(let event):
                        policy.noteHealthy()
                        await signal(.event(event))
                    }
                }
            } catch is CancellationError {
                outcome = .cancelled
            } catch APIError.http(let status, _) where status == 404 {
                await signal(.down)
                return
            } catch APIError.http(let status, _) where status == 401 {
                _ = await refreshSession()
                outcome = .failed
            } catch APIError.unauthorized {
                _ = await refreshSession()
                outcome = .failed
            } catch {
                outcome = .failed
            }
            // A cancelled read can also end as a plain finish of the stream.
            if Task.isCancelled { outcome = .cancelled }
            await signal(.down)
            switch policy.next(after: outcome) {
            case .stop:
                return
            case .reconnect(let ms):
                if ms > 0 { await sleep(ReconnectPolicy.jittered(ms, unit: jitter())) }
            }
        }
    }
}
