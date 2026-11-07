import Foundation
import XCTest
@testable import OrbitKit

/// One connection of a scripted control-plane server: what it yields, then how it ends.
private struct Connection {
    enum End { case finish, fail(Error) }
    let items: [ControlStreamEvent]
    let end: End
}

private struct Dropped: Error {}

/// A server that answers each connection from a script. Past the script it answers 404, as a server
/// without the stream does, which stops the loop — that is how each test ends.
private final class ScriptedControlStream: ControlPlaneStreaming, @unchecked Sendable {
    private let lock = NSLock()
    private var script: [Connection]
    private var opened = 0

    init(_ script: [Connection]) { self.script = script }

    var connections: Int {
        lock.lock()
        defer { lock.unlock() }
        return opened
    }

    func events() -> AsyncThrowingStream<ControlStreamEvent, Error> {
        lock.lock()
        opened += 1
        let next = script.isEmpty
            ? Connection(items: [], end: .fail(APIError.http(status: 404, body: nil)))
            : script.removeFirst()
        lock.unlock()
        return AsyncThrowingStream { continuation in
            for item in next.items { continuation.yield(item) }
            switch next.end {
            case .finish: continuation.finish()
            case .fail(let error): continuation.finish(throwing: error)
            }
        }
    }
}

/// What the loop asked for: each wait, each signal, each session refresh.
@MainActor
private final class Record {
    var sleeps: [Int] = []
    var signals: [ControlPlaneSignal] = []
    var refreshes = 0
}

private func event(_ type: String) -> ControlEvent {
    let json = #"{"type":"\#(type)","sessionId":"s1","agentId":null,"ts":"2026-11-07T08:00:00Z","data":{}}"#
    return try! JSONDecoder().decode(ControlEvent.self, from: Data(json.utf8))
}

/// The control-plane stream's reconnect rules (docs/list-freshness-design.md §4 R4), driven by a
/// scripted server and a recorded sleep: a connection is healthy only once a message arrives, every
/// wait is jittered, and a 401 refreshes the session and connects again rather than stopping.
@MainActor
final class ControlPlaneLoopTests: XCTestCase {
    private func run(_ script: [Connection], jitter: Double = 0,
                     refreshed: Bool = true) async -> (Record, ScriptedControlStream) {
        let record = Record()
        let stream = ScriptedControlStream(script)
        let loop = ControlPlaneLoop(stream: stream,
                                    refreshSession: { record.refreshes += 1; return refreshed },
                                    sleep: { record.sleeps.append($0) },
                                    jitter: { jitter })
        await loop.run { record.signals.append($0) }
        return (record, stream)
    }

    /// A proxy that accepts the stream and drops it before anything arrives: the backoff keeps
    /// climbing. Counting the connection itself as health reset it every time — 0.3–1 s forever.
    func testAConnectionDroppedBeforeItsFirstMessageKeepsBackingOff() async {
        let dropped = Connection(items: [.connected], end: .fail(Dropped()))
        let (record, stream) = await run([dropped, dropped, dropped, dropped])
        XCTAssertEqual(record.sleeps, [1_000, 2_000, 4_000, 8_000])
        XCTAssertEqual(stream.connections, 5, "four drops, then the 404 that ends the test")
    }

    /// The same proxy closing the stream cleanly instead: still no message, still a failed attempt.
    func testAConnectionClosedBeforeItsFirstMessageBacksOffInsteadOfComingBackEveryBeat() async {
        let closed = Connection(items: [.connected], end: .finish)
        let (record, _) = await run([closed, closed, closed])
        XCTAssertEqual(record.sleeps, [1_000, 2_000, 4_000])
    }

    /// The first message — the server's keepalive or an event — makes the connection healthy, and a
    /// drop after it starts the ramp again from the bottom.
    func testTheFirstMessageResetsTheBackoff() async {
        let dropped = Connection(items: [.connected], end: .fail(Dropped()))
        let pinged = Connection(items: [.connected, .keepalive], end: .fail(Dropped()))
        let evented = Connection(items: [.connected, .event(event("session.updated"))], end: .fail(Dropped()))
        let (record, _) = await run([dropped, dropped, pinged, dropped, dropped, evented])
        XCTAssertEqual(record.sleeps, [1_000, 2_000, 1_000, 2_000, 4_000, 1_000])
    }

    /// A healthy connection the server closes waits a beat, not a backoff.
    func testAHealthyConnectionThatClosesWaitsABeat() async {
        let (record, _) = await run([Connection(items: [.connected, .keepalive], end: .finish)])
        XCTAssertEqual(record.sleeps, [300])
    }

    /// Each wait is stretched by up to a quarter at random — never shortened.
    func testEveryWaitIsJittered() async {
        let dropped = Connection(items: [.connected], end: .fail(Dropped()))
        let (record, _) = await run([dropped, dropped], jitter: 0.999)
        XCTAssertEqual(record.sleeps, [1_249, 2_499])
        XCTAssertEqual(ReconnectPolicy.jittered(1_000, unit: 0), 1_000)
        XCTAssertEqual(ReconnectPolicy.jittered(1_000, unit: 0.5), 1_125)
        XCTAssertEqual(ReconnectPolicy.jittered(15_000, unit: 1), 18_750)
        XCTAssertEqual(ReconnectPolicy.jittered(300, unit: -3), 300, "a unit out of range is clamped")
        for unit in stride(from: 0.0, to: 1.0, by: 0.01) {
            let wait = ReconnectPolicy.jittered(8_000, unit: unit)
            XCTAssertGreaterThanOrEqual(wait, 8_000)
            XCTAssertLessThanOrEqual(wait, 10_000)
        }
    }

    /// A 401 refreshes the session and connects again: the stream used to stop until the app was
    /// relaunched, leaving the poll alone in charge.
    func testA401RefreshesTheSessionAndConnectsAgain() async {
        let unauthorized = Connection(items: [], end: .fail(APIError.http(status: 401, body: nil)))
        let healthy = Connection(items: [.connected, .event(event("task.changed"))], end: .finish)
        let (record, stream) = await run([unauthorized, healthy])
        XCTAssertEqual(record.refreshes, 1)
        XCTAssertEqual(stream.connections, 3, "connected again after the 401, then the closing 404")
        XCTAssertEqual(record.sleeps, [1_000, 300], "the 401 waits the failure's backoff before connecting again")
        XCTAssertTrue(record.signals.contains(.event(event("task.changed"))), "the stream after the 401 was followed")
    }

    /// Even a refresh that fails does not stop the stream: it backs off and tries again, and a session
    /// that is really over is signed out by the REST path, which cancels the loop.
    func testAFailedRefreshKeepsBackingOffRatherThanStopping() async {
        let unauthorized = Connection(items: [], end: .fail(APIError.http(status: 401, body: nil)))
        let (record, stream) = await run([unauthorized, unauthorized, unauthorized], refreshed: false)
        XCTAssertEqual(record.refreshes, 3)
        XCTAssertEqual(record.sleeps, [1_000, 2_000, 4_000])
        XCTAssertEqual(stream.connections, 4)
    }

    /// A server without the stream answers 404: polling stays in charge, and the loop stops.
    func testA404StopsTheLoop() async {
        let (record, stream) = await run([])
        XCTAssertEqual(stream.connections, 1)
        XCTAssertEqual(record.sleeps, [])
        XCTAssertEqual(record.signals, [.down])
    }

    /// The app hears `.live` when the stream connects, each event in order, and `.down` when it ends.
    func testSignalsArriveInOrder() async {
        let a = event("session.updated")
        let b = event("watch.changed")
        let (record, _) = await run([Connection(items: [.connected, .event(a), .keepalive, .event(b)], end: .finish)])
        XCTAssertEqual(record.signals, [.live, .event(a), .event(b), .down, .down])
    }

    /// The server's keepalive frame is a message, not an event: it reaches the loop as `.keepalive`.
    func testTheServersPingFrameIsAKeepalive() {
        XCTAssertEqual(ControlStreamEvent.frame(SSEEvent(id: nil, event: nil, data: #"{"type":"ping"}"#)), .keepalive)
        let json = #"{"type":"watch.changed","sessionId":"","agentId":null,"ts":"2026-11-07T08:00:00Z","data":{"id":"w1"}}"#
        guard case .event(let decoded) = ControlStreamEvent.frame(SSEEvent(id: nil, event: nil, data: json)) else {
            return XCTFail("a control event frame is an event")
        }
        XCTAssertEqual(decoded.type, .watchChanged)
    }
}
