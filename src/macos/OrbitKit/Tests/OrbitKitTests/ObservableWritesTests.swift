import Foundation
import Observation
import XCTest
@testable import OrbitKit

/// A store shaped like the section stores: `@Observable`, with the values a List reads.
@available(macOS 14.0, *)
@Observable
private final class ObservedStore {
    var count = 0
    var rows: [String] = []
}

/// `onChange` is called from whichever thread made the write, so the count is lock-guarded.
private final class ChangeCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    func bump() {
        lock.lock()
        defer { lock.unlock() }
        value += 1
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}

/// `assignIfChanged` is the write the section stores make around a reload. `@Observable` announces
/// every assignment, equal or not, so an unchanged value has to be skipped rather than written: the
/// sidebar and the Lists read these stores whole and would otherwise redraw on every poll.
@available(macOS 14.0, *)
final class ObservableWritesTests: XCTestCase {
    @MainActor
    func testAnUnchangedValueFiresNoObservation() {
        let store = ObservedStore()
        let changes = ChangeCounter()
        withObservationTracking {
            _ = store.count
            _ = store.rows
        } onChange: {
            changes.bump()
        }

        store.assignIfChanged(\.count, 0)
        store.assignIfChanged(\.rows, [])

        XCTAssertEqual(changes.count, 0)
    }

    @MainActor
    func testAChangedValueIsWrittenAndFiresObservation() {
        let store = ObservedStore()
        let changes = ChangeCounter()
        withObservationTracking {
            _ = store.count
        } onChange: {
            changes.bump()
        }

        store.assignIfChanged(\.count, 1)

        XCTAssertEqual(changes.count, 1)
        XCTAssertEqual(store.count, 1)
    }

    // MARK: a reload's state

    /// A list that already answered keeps what it draws while it is read again: the reload's begin
    /// and succeed both leave the state exactly as it was.
    func testAReadAfterAnAnswerMovesNoState() {
        var state = ListLoadState()
        state.begin()
        state.succeed()

        XCTAssertEqual(state.startingRead(), state)
        XCTAssertEqual(state.afterSuccess(), state)
    }

    func testAFirstReadShowsLoading() {
        let started = ListLoadState().startingRead()
        XCTAssertTrue(started.loading)
        XCTAssertFalse(started.hasLoaded)
    }

    /// A retry after a failed read still shows the spinner; the failure is not hidden behind a
    /// settled list.
    func testARetryAfterAFailureShowsLoading() {
        var failed = ListLoadState()
        failed.begin()
        failed.fail()

        XCTAssertTrue(failed.startingRead().loading)
        XCTAssertFalse(failed.afterSuccess().lastLoadFailed)
    }

    /// A read that fails after a success does move the state, and so does the success that clears it.
    func testAFailureAfterASuccessIsARealChange() {
        var loaded = ListLoadState()
        loaded.begin()
        loaded.succeed()

        let failed = loaded.afterFailure()
        XCTAssertTrue(failed.lastLoadFailed)
        XCTAssertEqual(failed.afterSuccess(), loaded)
    }
}
