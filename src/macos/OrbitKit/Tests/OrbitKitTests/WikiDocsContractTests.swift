import Foundation
import XCTest
@testable import OrbitKit

/// Holds OrbitKit's documents vocabulary to `contracts/wiki.contract.json` `docs` (criterion 9): the closed
/// sets, the owner's three reads on the user door, the pair a session record's footnote carries for its deep
/// link — and that what the server answers decodes, with a value this build has never heard of read as
/// `.unknown` rather than failing the page.
final class WikiDocsContractTests: XCTestCase {
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

    private func docsSection() throws -> [String: Any] {
        try XCTUnwrap(try contract()["docs"] as? [String: Any], "the contract has no docs section")
    }

    private func known<T: CaseIterable & RawRepresentable>(_: T.Type) -> Set<String> where T.RawValue == String {
        Set(T.allCases.map(\.rawValue).filter { $0 != "unknown" })
    }

    func testClosedSetsAreTheContracts() throws {
        let docs = try docsSection()
        XCTAssertEqual(Set(try XCTUnwrap(docs["statuses"] as? [String: Any]).keys), known(WikiDocStatus.self))
        XCTAssertEqual(Set(try XCTUnwrap(docs["sentenceStatuses"] as? [String: Any]).keys), known(WikiDocSentenceStatus.self))
        XCTAssertEqual(Set(try XCTUnwrap(docs["footnoteKinds"] as? [String: Any]).keys), known(WikiDocFootnoteKind.self))
        XCTAssertEqual(Set(try XCTUnwrap(docs["verdicts"] as? [String: Any]).keys), known(WikiDocVerdict.self))
        XCTAssertEqual(Set(try XCTUnwrap(docs["checkers"] as? [String: Any]).keys), known(WikiDocChecker.self))
        XCTAssertEqual(Set(try XCTUnwrap(docs["withdrawReasons"] as? [String])), known(WikiDocWithdrawReason.self))
        XCTAssertEqual(Set(try XCTUnwrap(docs["blockKinds"] as? [String: Any]).keys), known(WikiDocBlockKind.self))
        // The kinds a session's transcript opens at are the records the deep link reads around.
        let records = Set(try XCTUnwrap(docs["recordKinds"] as? [String]))
        let opening = WikiDocFootnoteKind.allCases.filter(\.opensAtASessionRecord).map(\.rawValue)
        XCTAssertEqual(opening, ["turn", "event", "tool_call"])
        XCTAssertTrue(Set(opening).isSubset(of: records))
    }

    /// The owner reads on the user door; a maintenance run reads what is written and writes on the runner
    /// door, and nothing on the user door writes a document.
    func testTheOwnersReadsAreOnTheUserDoor() throws {
        let routes = try XCTUnwrap(try docsSection()["routes"] as? [String: String])
        let doors = try XCTUnwrap((try contract()["agentSurface"] as? [String: Any])?["doors"] as? [String: Any])
        let user = try XCTUnwrap((doors["user"] as? [String: Any])?["routes"] as? [String])
        let maintenance = Set(try XCTUnwrap((doors["runner"] as? [String: Any])?["maintenanceRoutes"] as? [String]))
        for name in ["directory", "doc", "index"] {
            let route = try XCTUnwrap(routes[name], name)
            XCTAssertTrue(user.contains(route), "\(route) is not a route the user door declares")
            XCTAssertTrue(route.hasPrefix("GET "), route)
        }
        for name in ["writerState", "write"] {
            XCTAssertTrue(maintenance.contains(try XCTUnwrap(routes[name], name)), name)
        }
        XCTAssertFalse(user.contains { $0.hasPrefix("POST") && $0.contains("/docs") })
    }

    /// A turn's, an event's or a tool call's footnote carries its session beside its record, and the pair
    /// opens the transcript at it (`SessionRecordLink`); the contract says so in those words.
    func testASessionRecordsFootnoteOpensTheTranscriptAtIt() throws {
        let links = try XCTUnwrap((try docsSection()["links"] as? [String: Any])?["sessionRecord"] as? String)
        for name in ["recordId", "sessionId", "SessionRecordLink.url(session:record:)", "around=<recordId>"] {
            XCTAssertTrue(links.contains(name), "docs.links.sessionRecord does not name \(name)")
        }
        let doc = try JSONDecoder().decode(WikiDoc.self, from: Data(Self.docJSON.utf8))
        let footnotes = try XCTUnwrap(doc.footnotes)
        let onTurn = footnotes[0]
        XCTAssertEqual(onTurn.sessionRecord?.session, "34WSession")
        XCTAssertEqual(onTurn.sessionRecord?.record, "34WTurn")
        XCTAssertEqual(onTurn.sessionRecordURL, SessionRecordLink.url(session: "34WSession", record: "34WTurn"))
        XCTAssertEqual(footnotes[1].sessionRecord?.record, "34WToolCall", "a tool call opens the transcript too")
        // A repository original, and a comment, open no transcript.
        XCTAssertNil(footnotes[2].sessionRecord)
        XCTAssertNil(footnotes[3].sessionRecordURL)
        // A record the server could not place links nowhere.
        XCTAssertNil(footnotes[4].sessionRecord)
    }

    /// A document as the server answers it: its sections, sentences and their statuses, footnotes and
    /// via entries; values a later server adds read as `.unknown`.
    func testTheDocumentDecodes() throws {
        let doc = try JSONDecoder().decode(WikiDoc.self, from: Data(Self.docJSON.utf8))
        XCTAssertEqual(doc.number, "1.1")
        XCTAssertEqual(doc.status, .needsReview)
        XCTAssertEqual(doc.written, true)
        XCTAssertEqual(doc.repoSha, String(repeating: "c", count: 40))
        XCTAssertEqual(doc.scopeOut?.first?.docs?.first?.number, "1.2")
        let section = try XCTUnwrap(doc.sections?.first)
        XCTAssertEqual(section.stale, true)
        XCTAssertEqual(section.kind, .flow)
        let sentences = try XCTUnwrap(section.blocks?.first?.sentences)
        XCTAssertEqual(sentences.map(\.status), [.sourced, .withdrawn, .unsourced])
        XCTAssertEqual(sentences[1].withdrawn?.reason, .rejected)
        XCTAssertNil(sentences[1].withdrawn?.path, "an entry withdrew it, not a file")
        // A sentence citing a repository file gone from origin/main names the file, and no entry.
        let gone = #"{"text":"见设计文档。","status":"withdrawn","notes":[1],"newTokens":[],"withdrawn":{"reason":"anchor_missing","entryId":null,"path":"docs/old.md","at":"2026-09-30T03:00:00.000Z"}}"#
        let byPath = try JSONDecoder().decode(WikiDocSentence.self, from: Data(gone.utf8))
        XCTAssertEqual(byPath.withdrawn?.reason, .anchorMissing)
        XCTAssertEqual(byPath.withdrawn?.path, "docs/old.md")
        XCTAssertNil(byPath.withdrawn?.entryId)
        XCTAssertEqual(sentences[2].newTokens, ["rollbackclaim"])
        XCTAssertEqual(section.blocks?.last?.kind, .code)
        let footnotes = try XCTUnwrap(doc.footnotes)
        XCTAssertEqual(footnotes.map(\.verdict), [.verified, .noQuote, .verified, .verified, .unresolved])
        XCTAssertEqual(footnotes[2].kind, .code)
        XCTAssertEqual(footnotes[2].checkedBy, .runner)
        XCTAssertEqual(footnotes[2].location, "src/runner-go/runloop.go@\(String(repeating: "b", count: 40))#L398-409")
        XCTAssertEqual(doc.entries?.first?.status, .rejected)
        XCTAssertEqual(doc.entries?.first?.notes, [1])

        let later = Self.docJSON
            .replacingOccurrences(of: #""status":"needs_review""#, with: #""status":"archived""#)
            .replacingOccurrences(of: #""kind":"code","verdict""#, with: #""kind":"figure","verdict""#)
            .replacingOccurrences(of: #""status":"unsourced""#, with: #""status":"disputed""#)
        let decoded = try JSONDecoder().decode(WikiDoc.self, from: Data(later.utf8))
        XCTAssertEqual(decoded.status, .unknown)
        XCTAssertEqual(decoded.footnotes?[2].kind, .unknown)
        XCTAssertEqual(decoded.sections?.first?.blocks?.first?.sentences?.last?.status, .unknown)
    }

    func testTheDirectoryAndTheIndexDecode() throws {
        let directory = try JSONDecoder().decode(WikiDocsDirectory.self, from: Data(#"""
        {"spaceId":"34WSpace","plan":{"version":1,"confirmedAt":"2026-09-29T01:00:00.000Z"},"docs":{"total":3,"written":1},
         "categories":[{"key":"product","number":1,"title":"Product","question":"What Orbit is","forAgents":false,
           "docs":[{"slug":"session-runtime","number":"1.1","title":"会话运行模型与长连接","question":"怎么运转？","written":true,
                    "status":"ok","updatedAt":"2026-09-29T02:00:00.000Z","planVersion":1,
                    "lead":"turn 先落库再投递。它不用 WebSocket。",
                    "sections":[{"key":"s1","number":1,"title":"总览","kind":"overview","written":false,"stale":false},
                                {"key":"s2","number":2,"title":"turn 投递","kind":"flow","written":true,"stale":true}]},
                   {"slug":"task-dispatch","number":"1.2","title":"任务派发","question":"怎么派发？","written":false,
                    "status":null,"updatedAt":null,"planVersion":null,"sections":[]}]},
          {"key":"dev","number":2,"title":"Development conventions","question":"How agents work here","forAgents":true,"docs":[]}]}
        """#.utf8))
        XCTAssertEqual(directory.plan?.version, 1)
        XCTAssertEqual(directory.docs?.written, 1)
        let docs = try XCTUnwrap(directory.categories.first?.docs)
        XCTAssertEqual(docs.map(\.number), ["1.1", "1.2"])
        XCTAssertEqual(docs.first?.sections?.last?.stale, true)
        XCTAssertEqual(docs.first?.lead, "turn 先落库再投递。它不用 WebSocket。")
        XCTAssertNil(docs.last?.lead, "one not written has none — nor has any from a server older than leads")
        XCTAssertNil(docs.last?.status)
        XCTAssertEqual(directory.categories.last?.forAgents, true)
        let empty = try JSONDecoder().decode(WikiDocsDirectory.self, from: Data(#"{"spaceId":"34WSpace","plan":null,"docs":{"total":0,"written":0},"categories":[]}"#.utf8))
        XCTAssertNil(empty.plan)

        let index = try JSONDecoder().decode(WikiDocsIndex.self, from: Data(#"""
        {"spaceId":"34WSpace","plan":{"version":1,"confirmedAt":null},"items":[
          {"kind":"doc","title":"会话运行模型与长连接","docSlug":"session-runtime","docNumber":"1.1","docTitle":"会话运行模型与长连接",
           "sectionKey":null,"sectionNumber":null,"category":{"key":"product","title":"Product"},"written":true},
          {"kind":"section","title":"turn 投递","docSlug":"session-runtime","docNumber":"1.1","docTitle":"会话运行模型与长连接",
           "sectionKey":"s2","sectionNumber":2,"category":{"key":"product","title":"Product"},"written":true}]}
        """#.utf8))
        XCTAssertEqual(index.items.map(\.kind), ["doc", "section"])
        XCTAssertEqual(index.items.last?.sectionNumber, 2)
    }

    private static let docJSON = #"""
    {"spaceId":"34WSpace","slug":"session-runtime","number":"1.1","title":"会话运行模型与长连接","question":"怎么运转？",
     "audience":["A new developer"],"scopeIn":["Delivery"],
     "scopeOut":[{"text":"任务怎么派发","docs":[{"slug":"task-dispatch","number":"1.2","title":"任务派发"}]}],
     "category":{"key":"product","number":1,"title":"Product"},"length":{"min":800,"max":4000},
     "planVersion":2,"written":true,"status":"needs_review","writtenFromPlanVersion":1,
     "repoSha":"cccccccccccccccccccccccccccccccccccccccc","updatedAt":"2026-09-29T02:00:00.000Z",
     "counts":{"sentences":3,"sourced":1,"transition":0,"unsourced":1,"unverified":0,"withdrawn":1},"unsourcedShare":0.3333,
     "sections":[{"key":"s2","number":2,"title":"turn 投递","kind":"flow","written":true,"stale":true,
                  "staleAt":"2026-09-29T03:00:00.000Z","generatedAt":"2026-09-29T02:00:00.000Z",
                  "repoSha":"cccccccccccccccccccccccccccccccccccccccc","model":"qwen3.8-27b-fp8",
                  "blocks":[{"kind":"paragraph","text":null,"sentences":[
                              {"text":"Runner 从 inbox 领取 turn。","status":"sourced","notes":[1,3],"newTokens":[],"withdrawn":null},
                              {"text":"长命令交给 bg_run。","status":"withdrawn","notes":[2],"newTokens":[],
                               "withdrawn":{"reason":"rejected","entryId":"34WEntry","at":"2026-09-29T03:00:00.000Z"}},
                              {"text":"失败时由 `rollbackClaim` 回滚。","status":"unsourced","notes":[],"newTokens":["rollbackclaim"],"withdrawn":null}]},
                            {"kind":"code","text":"orbit wiki docs build","sentences":[]}]}],
     "footnotes":[
       {"n":1,"kind":"turn","verdict":"verified","checkedBy":"server","quote":"先存后投","location":"turn:0190-turn#c0-4",
        "recordId":"34WTurn","charStart":0,"charEnd":4,"sessionId":"34WSession","sessionTitle":"执行任务","seq":4,
        "at":"2026-09-15T07:37:00.000Z","label":"message","viaEntryId":"34WEntry"},
       {"n":2,"kind":"tool_call","verdict":"no_quote","checkedBy":"server","quote":null,"location":"tool_call:0190-call",
        "recordId":"34WToolCall","sessionId":"34WSession","label":"Bash"},
       {"n":3,"kind":"code","verdict":"verified","checkedBy":"runner","quote":"func claimRetryDelayAfter(",
        "location":"src/runner-go/runloop.go@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb#L398-409",
        "path":"src/runner-go/runloop.go","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","lineStart":398,"lineEnd":409,
        "symbol":"claimRetryDelayAfter()","excerpt":"func claimRetryDelayAfter(failures int) time.Duration {","recordId":null,"sessionId":null},
       {"n":4,"kind":"task_comment","verdict":"verified","checkedBy":"server","quote":"6 个新文件","location":"task_comment:0190-c",
        "recordId":"34WComment","sessionId":null,"taskId":"34WTask","taskTitle":"阶段 2 runner 托管"},
       {"n":5,"kind":"event","verdict":"unresolved","checkedBy":"server","quote":"nobody has it","location":"event:0190-x",
        "recordId":"34WMissing","sessionId":null}],
     "entries":[{"id":"34WEntry","kind":"concept","title":"先存后投","status":"rejected","trust":"unreviewed","anchorState":"unchecked","notes":[1]}]}
    """#
}
