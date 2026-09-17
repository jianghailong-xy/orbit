import Foundation
import XCTest
@testable import OrbitKit

/// Holds OrbitKit's Watch vocabulary to `contracts/watch.contract.json`, the file every Watch surface
/// transcribes (docs/watch-contract.md). The TypeScript side is held to it by `watchContract.spec.ts`
/// and `watch-api.pg.spec.ts`; nothing compiles this Swift against it, so this is what notices a
/// state, leaf, transition or limit moving there and not here.
final class WatchContractTests: XCTestCase {
    private struct ContractMissing: Error, CustomStringConvertible {
        let searchedFrom: String
        var description: String {
            "contracts/watch.contract.json was not found above \(searchedFrom). If the contract moved, "
                + "point this check at its new home — don't delete the check."
        }
    }

    /// Found by walking up from this file rather than by counting `..`. Never a skip: a check that
    /// quietly opts out is green on exactly the day the thing it guards goes missing.
    private func contract() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("contracts/watch.contract.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                let data = try Data(contentsOf: candidate)
                return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            }
            dir.deleteLastPathComponent()
        }
        throw ContractMissing(searchedFrom: #filePath)
    }

    private func object(_ value: Any?, _ path: String) throws -> [String: Any] {
        try XCTUnwrap(value as? [String: Any], "contract has no object at \(path)")
    }

    private func strings(_ value: Any?, _ path: String) throws -> [String] {
        try XCTUnwrap(value as? [String], "contract has no string list at \(path)")
    }

    private func known<T: RawRepresentable & CaseIterable>(_ type: T.Type) -> [String]
        where T.RawValue == String {
        type.allCases.map(\.rawValue).filter { $0 != "UNKNOWN" }
    }

    // MARK: states

    func testWatchStatesMatchTheContract() throws {
        let watch = try object(try object(contract()["states"], "states")["watch"], "states.watch")
        XCTAssertEqual(try strings(watch["values"], "states.watch.values"), known(WatchState.self))
        XCTAssertEqual(Set(try strings(watch["terminal"], "states.watch.terminal")),
                       Set(WatchStateMachine.terminal.map(\.rawValue)))
        XCTAssertEqual(watch["initial"] as? String, WatchState.active.rawValue)
    }

    func testTransitionsMatchTheContractEdgeForEdge() throws {
        let watch = try object(try object(contract()["states"], "states")["watch"], "states.watch")
        let edges = try XCTUnwrap(watch["transitions"] as? [[String: Any]])
        let contractEdges = Set(edges.compactMap { edge -> String? in
            guard let from = edge["from"] as? String, let to = edge["to"] as? String else { return nil }
            return "\(from)>\(to)"
        })
        XCTAssertEqual(contractEdges.count, edges.count, "every contract transition names from and to")
        let swiftEdges = Set(WatchStateMachine.transitions.map { "\($0.from.rawValue)>\($0.to.rawValue)" })
        XCTAssertEqual(swiftEdges, contractEdges)
        // Nothing leaves a terminal state.
        for edge in WatchStateMachine.transitions {
            XCTAssertFalse(WatchStateMachine.terminal.contains(edge.from), "\(edge.from) is terminal")
        }
    }

    /// A card can only offer a move the server's machine has, from the state the watch is in.
    func testEveryOfferedControlIsALegalMove() {
        for state in WatchState.allCases {
            for control in WatchStateMachine.controls(for: state) {
                guard let next = control.resultingState else { continue }
                XCTAssertTrue(WatchStateMachine.canTransition(from: state, to: next),
                              "\(control) offered on \(state) would move it to \(next)")
            }
        }
        XCTAssertEqual(WatchStateMachine.controls(for: .active), [.view, .edit, .pause, .stop])
        XCTAssertEqual(WatchStateMachine.controls(for: .paused), [.view, .edit, .resume, .stop])
        for state in WatchStateMachine.terminal.union([.unknown]) {
            XCTAssertEqual(WatchStateMachine.controls(for: state), [.view], "\(state)")
        }
        XCTAssertEqual(WatchControl.allCases.map(\.title), ["View", "Edit", "Pause", "Resume", "Stop"])
    }

    func testTargetAndDeliveryStatesMatchTheContract() throws {
        let states = try object(contract()["states"], "states")
        let target = try object(states["target"], "states.target")
        XCTAssertEqual(try strings(target["values"], "states.target.values"), known(WatchTargetState.self))
        let delivery = try object(states["delivery"], "states.delivery")
        XCTAssertEqual(try strings(delivery["values"], "states.delivery.values"), known(WatchDeliveryState.self))
        XCTAssertEqual(try strings(delivery["terminal"], "states.delivery.terminal"),
                       [WatchDeliveryState.deadLetter.rawValue])
    }

    // MARK: grammar

    func testLeavesAndTheKindEachIsEvaluatedAgainstMatchTheContract() throws {
        let leaves = try object(contract()["leaves"], "leaves")
        // The leaves of the grammar this build reads and writes. A leaf a later grammar introduced declares its
        // sinceVersion, and is one this build reads as a leaf it does not know.
        let served = leaves.filter { (($0.value as? [String: Any])?["sinceVersion"] as? Int ?? 1) <= WatchPredicate.version }
        XCTAssertEqual(Set(served.keys), Set(known(WatchLeaf.self)))
        for later in leaves.keys where served[later] == nil {
            XCTAssertEqual(try JSONDecoder().decode([WatchLeaf].self, from: Data("[\"\(later)\"]".utf8)), [.unknown], later)
        }
        for leaf in WatchLeaf.allCases where leaf != .unknown {
            let definition = try object(leaves[leaf.rawValue], "leaves.\(leaf.rawValue)")
            XCTAssertEqual(definition["targetKind"] as? String, leaf.targetKind?.rawValue, leaf.rawValue)
        }
        XCTAssertEqual(Set(try strings(contract()["watchableTargetKinds"], "watchableTargetKinds")),
                       [WatchTargetKind.session.rawValue, WatchTargetKind.task.rawValue])
    }

    func testKindsSelectorsAndActionsMatchTheContract() throws {
        let c = try contract()
        let encoded = try [WatchPredicate.all(.taskDone), .any(.taskDone), .allOf([.all(.taskDone)]),
                           .anyOf([.all(.taskDone)])].map { predicate -> [String: Any] in
            try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(predicate)) as? [String: Any])
        }
        let kinds = encoded.compactMap { $0["kind"] as? String }
        // This build's two aggregations are the contract's, in its order; one a later grammar added (a quorum) is a
        // term this build reads as one it does not know, and never sends back.
        let aggregations = try strings(c["aggregations"], "aggregations")
        XCTAssertEqual(Array(kinds.prefix(2)), aggregations.filter { kinds.prefix(2).contains($0) })
        for later in aggregations where !kinds.prefix(2).contains(later) {
            let term: [String: Any] = ["kind": later, "count": 1, "over": "ALL_TARGETS", "leaf": WatchLeaf.taskDone.rawValue]
            let data = try JSONSerialization.data(withJSONObject: term)
            XCTAssertEqual(try JSONDecoder().decode(WatchPredicate.self, from: data), .unknown(later), later)
        }
        XCTAssertEqual(Array(kinds.suffix(2)), try strings(c["composites"], "composites"))
        XCTAssertEqual(Set(encoded.prefix(2).compactMap { $0["over"] as? String }),
                       Set(try strings(c["targetSelectors"], "targetSelectors")))
        let actions = try XCTUnwrap(c["actions"] as? [[String: Any]]).compactMap { $0["kind"] as? String }
        XCTAssertEqual(actions, known(WatchAction.self))
        // The grammar this build writes is one the server still serves, and none newer than the contract's.
        XCTAssertTrue(try XCTUnwrap(c["servedPredicateVersions"] as? [Int]).contains(WatchPredicate.version))
        XCTAssertGreaterThanOrEqual(try XCTUnwrap(c["predicateVersion"] as? Int), WatchPredicate.version)
    }

    /// The canonical agent request (vector `all-terminal-or-any-failed`) reads into the Swift grammar
    /// and goes back out as the same JSON.
    func testTheCanonicalRequestRoundTrips() throws {
        let vectors = try XCTUnwrap(contract()["vectors"] as? [[String: Any]])
        let vector = try XCTUnwrap(vectors.first { $0["id"] as? String == "all-terminal-or-any-failed" })
        let given = try object(vector["given"], "vectors.all-terminal-or-any-failed.given")
        let raw = try XCTUnwrap(given["predicate"])
        let data = try JSONSerialization.data(withJSONObject: raw)
        let predicate = try JSONDecoder().decode(WatchPredicate.self, from: data)
        XCTAssertEqual(predicate, .anyOf([.all(.taskTerminal), .any(.taskFailed)]))
        let back = try JSONSerialization.jsonObject(with: JSONEncoder().encode(predicate))
        XCTAssertEqual(back as? NSDictionary, raw as? NSDictionary)
    }

    // MARK: dead letters

    /// The dead letters shown without being raised are the contract's `needsAttention: false` codes: the table the
    /// web reads through `@orbit/shared` (held there by `watchContract.spec.ts`), so both raise the same ones.
    func testQuietDeadLetterCodesMatchTheContract() throws {
        let guards = try object(contract()["deliveryGuards"], "deliveryGuards")
        let codes = try object(guards["deadLetterCodes"], "deliveryGuards.deadLetterCodes")
        var quiet = Set<String>()
        for (code, value) in codes {
            let entry = try object(value, "deliveryGuards.deadLetterCodes.\(code)")
            let needsAttention = try XCTUnwrap(entry["needsAttention"] as? Bool,
                                               "\(code) does not say whether it needs attention")
            guard !needsAttention else { continue }
            quiet.insert(code)
            XCTAssertEqual(entry["retryable"] as? Bool, false, "\(code) can be redriven, so somebody has to see it")
        }
        XCTAssertEqual(quiet, WatchDeadLetter.quietCodes)
    }

    /// The other two ways into Needs attention, beside a dead letter: the contract's `attention.states` and
    /// `attention.expiredActions`, which `GET /watches?needsAttention=true` picks by and shared transcribes for
    /// the web. A state or an action added there and not here would leave this app holding a watch the server
    /// hands it under that read and filing it away in History.
    func testTheEndsThatNeedAttentionMatchTheContract() throws {
        let attention = try object(contract()["attention"], "attention")
        XCTAssertEqual(Set(try strings(attention["states"], "attention.states")),
                       Set(WatchAttentionRule.states.map(\.rawValue)))
        XCTAssertEqual(Set(try strings(attention["expiredActions"], "attention.expiredActions")),
                       Set(WatchAttentionRule.expiredActions.map(\.rawValue)))
        // Filed by its state only once it has ended: a live watch is read whole by its own state instead.
        let terminal = Set(try strings(try object(try object(contract()["states"], "states")["watch"],
                                                  "states.watch")["terminal"], "states.watch.terminal"))
        for state in WatchAttentionRule.states {
            XCTAssertTrue(terminal.contains(state.rawValue), "\(state.rawValue) is terminal")
        }
    }

    // MARK: limits

    func testLimitsMatchTheContract() throws {
        let limits = try object(contract()["limits"], "limits")
        XCTAssertEqual(limits["minTtlSeconds"] as? Int, WatchLimits.minTtlSeconds)
        XCTAssertEqual(limits["defaultTtlSeconds"] as? Int, WatchLimits.defaultTtlSeconds)
        XCTAssertEqual(limits["maxTtlSeconds"] as? Int, WatchLimits.maxTtlSeconds)
        XCTAssertEqual(limits["maxPredicateDepth"] as? Int, WatchLimits.maxPredicateDepth)
        XCTAssertEqual(limits["maxOperandsPerComposite"] as? Int, WatchLimits.maxOperandsPerComposite)
        XCTAssertEqual(limits["maxDeliveryAttempts"] as? Int, WatchLimits.maxDeliveryAttempts)
    }

    /// Terms counted from the root, as the server's `parseRequestedPredicate` counts them.
    private func depth(_ predicate: WatchPredicate) -> Int {
        switch predicate {
        case .all, .any: return 1
        case .allOf(let operands), .anyOf(let operands): return 1 + (operands.map(depth).max() ?? 0)
        case .unknown: return Int.max
        }
    }

    private func widest(_ predicate: WatchPredicate) -> Int {
        switch predicate {
        case .all, .any, .unknown: return 0
        case .allOf(let operands), .anyOf(let operands): return max(operands.count, operands.map(widest).max() ?? 0)
        }
    }

    /// Nothing the Edit sheet offers is a condition the server would refuse.
    func testEveryOfferedConditionIsOneTheServerAccepts() {
        for kind in [WatchTargetKind.task, .session] {
            let offered = WatchEditing.conditions(for: kind)
            XCTAssertFalse(offered.isEmpty, "\(kind)")
            for predicate in offered {
                XCTAssertTrue(predicate.isKnown, "\(predicate)")
                XCTAssertTrue(predicate.leaves.allSatisfy { $0.targetKind == kind },
                              "\(predicate) would be refused as TARGET_KIND_MISMATCH on \(kind) targets")
                XCTAssertLessThanOrEqual(depth(predicate), WatchLimits.maxPredicateDepth, "\(predicate)")
                XCTAssertLessThanOrEqual(widest(predicate), WatchLimits.maxOperandsPerComposite, "\(predicate)")
            }
        }
        for seconds in WatchEditing.deadlineChoices {
            XCTAssertTrue((WatchLimits.minTtlSeconds...WatchLimits.maxTtlSeconds).contains(seconds),
                          "\(seconds)s would be refused as TTL_OUT_OF_RANGE")
        }
    }
}
