import Foundation
import OrbitKit

/// A page's own poll, following the control stream (docs/list-freshness-design.md §4 R1–R3, R6) on
/// OrbitKit's `PollSchedule`. With the stream live it reads on the page's hint — a burst merged into
/// one read — and otherwise once a minute, the safety read for an event that never came; with the
/// stream down, at the page's own cadence, backing off while the app's reads fail (offline); and not
/// at all while the app cannot be seen (`AppModel.appVisible`).
///
/// `inFlight` is the bounded exception for what no event reports while it moves — a landing or
/// merge job running, a machine checking in: that cadence instead, whatever the stream, and still
/// only while the app can be seen.
///
/// The page makes its first read itself; this makes every read after it, until the page's task is
/// cancelled.
@MainActor
enum ViewPoll {
    static func run(_ app: AppModel, every interval: TimeInterval, hints: () -> Int = { 0 },
                    inFlight: () -> TimeInterval? = { nil }, read: () async -> Void) async {
        var schedule = PollSchedule(interval: interval, lastReadAt: Date())
        var seen = hints()
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            if Task.isCancelled { return }
            let now = Date()
            let hint = hints()
            if hint != seen {
                seen = hint
                schedule.hint(at: now)
            }
            guard schedule.isDue(at: now, live: app.controlPlaneLive, visible: app.appVisible,
                                 failures: app.pollFailures, inFlight: inFlight()) else { continue }
            schedule.noteRead(at: now, jitter: Double.random(in: 0..<1))
            await read()
        }
    }
}
