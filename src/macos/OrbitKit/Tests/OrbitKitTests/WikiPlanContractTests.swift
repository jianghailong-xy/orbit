import Foundation
import XCTest
@testable import OrbitKit

/// Holds OrbitKit's plan vocabulary to `contracts/wiki.contract.json` `plan` (criterion 11): the closed
/// sets, the user door's routes the owner reads, edits, confirms and decides on — and that what the
/// server answers decodes, with a value this build has never heard of read as `.unknown` rather than
/// failing the page.
final class WikiPlanContractTests: XCTestCase {
    private struct ContractMissing: Error, CustomStringConvertible {
        let searchedFrom: String
        var description: String {
            "contracts/wiki.contract.json was not found above \(searchedFrom). If the contract moved, "
                + "point this check at its new home — don't delete the check."
        }
    }

    /// Found by walking up from this file. Never a skip.
    private func contract() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("contracts/wiki.contract.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: candidate)) as? [String: Any])
            }
            dir.deleteLastPathComponent()
        }
        throw ContractMissing(searchedFrom: #filePath)
    }

    private func planSection() throws -> [String: Any] {
        try XCTUnwrap(try contract()["plan"] as? [String: Any], "the contract has no plan section")
    }

    private func known<T: CaseIterable & RawRepresentable>(_: T.Type) -> Set<String> where T.RawValue == String {
        Set(T.allCases.map(\.rawValue).filter { $0 != "unknown" })
    }

    func testClosedSetsAreTheContracts() throws {
        let plan = try planSection()
        XCTAssertEqual(Set(try XCTUnwrap(plan["statuses"] as? [String: Any]).keys), known(WikiPlanStatus.self))
        XCTAssertEqual(Set(try XCTUnwrap(plan["origins"] as? [String: Any]).keys), known(WikiPlanOrigin.self))
        XCTAssertEqual(Set(try XCTUnwrap(plan["sectionKinds"] as? [String: Any]).keys), known(WikiPlanSectionKind.self))
        let proposals = try XCTUnwrap(plan["proposals"] as? [String: Any])
        XCTAssertEqual(Set(try XCTUnwrap(proposals["statuses"] as? [String: Any]).keys), known(WikiPlanProposalStatus.self))
        let gate = try XCTUnwrap(plan["gate"] as? [String: Any])
        XCTAssertEqual(try XCTUnwrap(gate["checks"] as? [String]),
                       WikiPlanGateCheck.allCases.filter { $0 != .unknown }.map(\.rawValue))
    }

    /// The owner's six routes are the user door's; the runner door has the maintenance run's three, and
    /// none of them confirms or decides anything.
    func testTheOwnersRoutesAreOnTheUserDoor() throws {
        let routes = try XCTUnwrap(try planSection()["routes"] as? [String: String])
        let doors = try XCTUnwrap((try contract()["agentSurface"] as? [String: Any])?["doors"] as? [String: Any])
        let user = Set(try XCTUnwrap((doors["user"] as? [String: Any])?["routes"] as? [String]))
        let maintenance = Set(try XCTUnwrap((doors["runner"] as? [String: Any])?["maintenanceRoutes"] as? [String]))
        for name in ["state", "versions", "version", "edit", "confirm", "decide"] {
            let route = try XCTUnwrap(routes[name], name)
            XCTAssertTrue(user.contains(route), "\(route) is not a route the user door declares")
        }
        for name in ["runnerState", "draft", "propose"] {
            let route = try XCTUnwrap(routes[name], name)
            XCTAssertTrue(maintenance.contains(route), "\(route) is not a maintenance route")
            XCTAssertFalse(route.contains("confirm") || route.contains("decide"), route)
        }
        XCTAssertTrue(try XCTUnwrap((try planSection()["who"] as? [String: Any])?["owner"] as? String).contains("WIKI_OWNER_CHANNEL_ONLY"))
    }

    /// The plan as the server answers it: the version in force, the draft, the pending proposals.
    func testTheStateDecodes() throws {
        let json = #"""
        {"spaceId":"34WSpace",
         "confirmed":{"id":"34WPlan1","spaceId":"34WSpace","version":1,"status":"confirmed","origin":"maintenance","baseVersion":null,
           "proposalId":null,"categories":[{"key":"product","title":"Product","question":"What Orbit is","forAgents":false},
                                           {"key":"dev","title":"Development conventions","question":"","forAgents":true}],
           "newFields":[],"target":{"min":20,"max":35},
           "gate":{"checkedAt":"2026-09-29T00:00:00.000Z","checks":{"schema":"passed","docCount":"passed","protected":"passed","references":"passed"},
                   "docs":20,"target":{"min":20,"max":35},"needsNewFields":[{"at":"section","name":"evidenceWeight","why":"merging","values":1}]},
           "repoCheck":{"sha":"0123456789abcdef0123456789abcdef01234567","checked":42,"missing":[{"kind":"symbol","ref":"claudeRuntime.setPhase","at":"docs[3].sections[1].code[0]"}]},
           "model":"qwen3.8-27b-fp8","confirmedAt":"2026-09-29T01:00:00.000Z","supersededAt":null,"createdAt":"2026-09-29T00:00:00.000Z",
           "docs":[{"id":"34WDoc1","position":0,"category":"product","slug":"session-runtime","title":"会话运行模型与长连接",
                    "question":"How does a session run?","audience":["A new developer"],"scopeIn":["Delivery"],
                    "scopeOut":[{"text":"The state model","docs":["session-state"]}],"length":{"min":3000,"max":4500},"protected":true,
                    "sections":[{"id":"34WSec1","key":"s1","position":0,"title":"Overview","kind":"overview","covers":"What it is.","length":300,
                                 "sources":{"docs":[],"code":[],"contracts":[],"sessions":null}},
                                {"id":"34WSec2","key":"s2","position":1,"title":"Known pitfalls","kind":"pitfalls","covers":"What went wrong.","length":400,
                                 "sources":{"docs":[{"path":"docs/architecture.md","section":"Execution model"}],"code":[{"path":"src/runner-go/runloop.go","symbols":["runLoop()"]}],
                                            "contracts":[{"path":"contracts/wiki.contract.json"}],
                                            "sessions":{"projects":[{"id":"34WProject","title":"Orbit Wiki · 阶段 2"},{"id":"34WGone","title":null}],
                                                        "since":"2026-09-01","until":null,"keywords":["plan"],"anchorPaths":["src/apiserver/src/wiki/"],
                                                        "entryKinds":["pitfall","rumour"],"topics":["wiki"],"evidence":"the owner's words"}}}]}]},
         "draft":null,
         "proposals":[{"id":"34WProposal","spaceId":"34WSpace","status":"pending","baseVersion":1,"reason":"Backups fit no section.",
                       "change":{"doc":{"category":"ops","slug":"backups","title":"Backups","question":"How do I back up?",
                                        "sections":[{"title":"How it runs","kind":"flow","covers":"The steps.","length":800,"sources":{}}]},
                                 "category":{"key":"ops","title":"Operations"}},
                       "facts":[{"kind":"entry","id":"34WEntry"}],"decidedAt":null,"decisionNote":null,"resultVersion":null,
                       "createdAt":"2026-09-29T02:00:00.000Z"}]}
        """#
        let state = try JSONDecoder().decode(WikiPlanState.self, from: Data(json.utf8))
        let confirmed = try XCTUnwrap(state.confirmed)
        XCTAssertEqual(confirmed.status, .confirmed)
        XCTAssertEqual(confirmed.origin, .maintenance)
        XCTAssertEqual(confirmed.categories?.last?.forAgents, true)
        XCTAssertEqual(confirmed.gate?.checks?["protected"], "passed")
        XCTAssertEqual(confirmed.gate?.needsNewFields?.first?.name, "evidenceWeight")
        XCTAssertEqual(confirmed.repoCheck?.missing?.first?.kind, "symbol")
        let doc = try XCTUnwrap(confirmed.docs?.first)
        XCTAssertEqual(doc.protected, true)
        XCTAssertEqual(doc.scopeOut?.first?.docs, ["session-state"])
        XCTAssertEqual(doc.sections?.map(\.key), ["s1", "s2"])
        XCTAssertEqual(doc.sections?.map(\.kind), [.overview, .pitfalls])
        let sessions = try XCTUnwrap(doc.sections?.last?.sources?.sessions)
        XCTAssertEqual(sessions.projects?.map(\.title), ["Orbit Wiki · 阶段 2", nil])
        // An entry kind this build has not heard of reads as .unknown, and the page still decodes.
        XCTAssertEqual(sessions.entryKinds, [.pitfall, .unknown])
        XCTAssertNil(state.draft)
        let proposal = try XCTUnwrap(state.proposals?.first)
        XCTAssertEqual(proposal.status, .pending)
        XCTAssertEqual(proposal.change?.doc.slug, "backups")
        XCTAssertEqual(proposal.change?.category?.key, "ops")
        XCTAssertEqual(proposal.change?.doc.sections?.first?.kind, .flow)

        // A status, an origin and a section kind a later server adds read as `.unknown`.
        let later = json.replacingOccurrences(of: #""status":"confirmed""#, with: #""status":"archived""#)
            .replacingOccurrences(of: #""origin":"maintenance""#, with: #""origin":"import""#)
            .replacingOccurrences(of: #""kind":"overview""#, with: #""kind":"glossary""#)
        let decoded = try JSONDecoder().decode(WikiPlanState.self, from: Data(later.utf8))
        XCTAssertEqual(decoded.confirmed?.status, .unknown)
        XCTAssertEqual(decoded.confirmed?.origin, .unknown)
        XCTAssertEqual(decoded.confirmed?.docs?.first?.sections?.first?.kind, .unknown)
    }

    /// The history, and a refusal of the gate: every error with its check, where it is and why.
    func testTheHistoryAndTheGatesErrorsDecode() throws {
        let history = #"""
        {"spaceId":"34WSpace","versions":[
          {"id":"34WPlan3","version":3,"status":"draft","origin":"owner","baseVersion":2,"proposalId":null,"docCount":21,
           "createdAt":"2026-09-29T03:00:00.000Z","confirmedAt":null,"supersededAt":null},
          {"id":"34WPlan1","version":1,"status":"confirmed","origin":"maintenance","baseVersion":null,"proposalId":null,"docCount":20,
           "createdAt":"2026-09-29T00:00:00.000Z","confirmedAt":"2026-09-29T01:00:00.000Z","supersededAt":null}]}
        """#
        let versions = try JSONDecoder().decode(WikiPlanVersions.self, from: Data(history.utf8)).versions
        XCTAssertEqual(versions.map(\.version), [3, 1])
        XCTAssertEqual(versions.map(\.status), [.draft, .confirmed])
        XCTAssertEqual(versions.first?.origin, .owner)

        let refusal = #"""
        [{"check":"protected","path":"plan.docs[3]","message":"session-runtime is protected"},
         {"check":"references","path":"plan.docs[6].sections[2].sources.sessions.topics[1]","message":"engineering is not a topic of this space"},
         {"check":"style","path":"plan.docs[0]","message":"a check a later server runs"}]
        """#
        let errors = try JSONDecoder().decode([WikiPlanGateError].self, from: Data(refusal.utf8))
        XCTAssertEqual(errors.map(\.check), [.protected, .references, .unknown])
        XCTAssertEqual(errors[1].path, "plan.docs[6].sections[2].sources.sessions.topics[1]")
    }
}
