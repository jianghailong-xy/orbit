import Foundation
@testable import OrbitKit

/// The wiki reads, as the user door answers them, drawn from the same notes the phone mocks (06–09)
/// show: the `orbit` space with its four principles, three decisions and three proposals waiting,
/// and the pitfall mock 08 opens. Ids are base62 public ids, as every id on `/api/wiki` is; the
/// public-id twins the server adds beside them (`publicId`, `spacePublicId`, …) are left in on the
/// first rows so the decoding is proved against the wire rather than a tidied copy of it.
enum WikiFixtures {
    static let spaceID = "34UAq0rbitSpaceOrbit01"
    static let pitfallID = "34UDFnrgM4q5odj4MVdXD"
    static let principleID = "34UDFnrgM4q5oGQloG3uq"
    static let sha = "4db4f9f0a1b2c3d4e5f60718293a4b5c6d7e8f90"

    /// `GET /wiki/spaces` — the list the drawer's amber number sums.
    static let spaces = """
    [{"id":"\(spaceID)","publicId":"\(spaceID)","slug":"orbit","title":"Orbit",
      "repoUrlNorm":"github.com/jianghailong-xy/orbit","rootCommitSha":"\(sha)",
      "settings":{"push":true,"autoAcceptReinforce":true},
      "createdAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-25T09:00:00.000Z","pendingOps":3},
     {"id":"34UAqWikovaSpace000002","slug":"wikova","title":"Wikova",
      "repoUrlNorm":"github.com/jianghailong-xy/wikova","rootCommitSha":null,
      "settings":{"push":true,"autoAcceptReinforce":true},
      "createdAt":"2026-09-02T00:00:00.000Z","updatedAt":"2026-09-24T00:00:00.000Z","pendingOps":0}]
    """

    /// `GET /wiki/spaces/:id?include=usage`.
    static let space = """
    {"id":"\(spaceID)","publicId":"\(spaceID)","slug":"orbit","title":"Orbit",
     "repoUrlNorm":"github.com/jianghailong-xy/orbit","rootCommitSha":"\(sha)",
     "settings":{"push":true,"autoAcceptReinforce":true},
     "createdAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-25T09:00:00.000Z",
     "usage":{"days":7,"sessionsPushed":214,"searches":38,"gets":12,"entries":[
       {"entryId":"\(pitfallID)","entryPublicId":"\(pitfallID)","title":"runner-go’s full suite inside a session reaches production","total":41,"pushed":40,"searched":1,"fetched":0},
       {"entryId":"34UDFnrgM4q5oUIcopyEn","title":"UI copy is English; code comments may be Chinese","total":33,"pushed":33,"searched":0,"fetched":0},
       {"entryId":"\(principleID)","title":"A clock never starts agent work","total":29,"pushed":29,"searched":0,"fetched":0}]}}
    """

    private static func entry(_ id: String, kind: String, title: String, summary: String,
                              trust: String = "owner", status: String = "active",
                              topics: [String] = [], validFrom: String,
                              anchorState: String = "verified", supersededBy: String? = nil,
                              fields: String = "{}") -> String {
        let topicList = topics.map { "\"\($0)\"" }.joined(separator: ",")
        let successor = supersededBy.map { "\"\($0)\"" } ?? "null"
        return """
        {"id":"\(id)","publicId":"\(id)","spaceId":"\(spaceID)","spacePublicId":"\(spaceID)",
         "kind":"\(kind)","status":"\(status)","trust":"\(trust)","currentRevision":1,
         "title":"\(title)","summary":"\(summary)","fields":\(fields),"topics":[\(topicList)],
         "aliases":[],"anchors":[],"anchorState":"\(anchorState)","anchorCheckedRef":"\(sha)",
         "anchorCheckedAt":"2026-09-25T08:00:00.000Z","tainted":false,"challenged":false,
         "unsupported":false,"pinned":\(kind == "principle"),"supersedesId":null,"supersededById":\(successor),
         "validFrom":"\(validFrom)","validTo":null,"recordedAt":"\(validFrom)","retiredAt":null}
        """
    }

    /// `GET /wiki/spaces/:id/entries` — newest recorded first, every status.
    static let entries = "[" + [
        entry("34UDFnrgM4q5oDeleteMe", kind: "principle", title: "Delete means forget",
              summary: "When the owner deletes a session or task, everything compiled from it is withdrawn.",
              topics: ["deploy-ops"], validFrom: "2026-09-24T12:00:00.000Z"),
        entry(principleID, kind: "principle", title: "A clock never starts agent work",
              summary: "Work starts from a committed fact (evidence revised, a receipt), never from a timer.",
              topics: ["tasks-dispatch"], validFrom: "2026-09-23T10:00:00.000Z"),
        entry("34UDFnrgM4q5oJudgedXX", kind: "principle", title: "Completion is adjudicated, not claimed",
              summary: "A task is DONE when its declared criterion says so, not when the agent says so.",
              topics: ["projects-criteria"], validFrom: "2026-09-20T10:00:00.000Z"),
        entry("34UDFnrgM4q5oAgentWrt", kind: "principle",
              title: "Agent-writable data never becomes a system instruction",
              summary: "Compiled or agent-written text reaches agents as user-level context, never as the system prompt.",
              topics: ["runner-engines"], validFrom: "2026-09-19T10:00:00.000Z"),
        entry("34UDFnrgM4q5oPriority", kind: "decision",
              title: "Task priority is a field on the task, not a dispatcher session",
              summary: "Add priority to tasks; the dispatcher reads it.", trust: "confirmed",
              topics: ["tasks-dispatch"], validFrom: "2026-09-25T10:00:00.000Z"),
        entry("34UDFnrgM4q5oWakeupsX", kind: "decision", title: "Wakeups are held by the server",
              summary: "session_scheduled_wakeup · commit 1125c445a", trust: "confirmed",
              topics: ["runner-engines"], validFrom: "2026-09-13T10:00:00.000Z"),
        entry("34UDFnrgM4q5oExitCode", kind: "decision",
              title: "EXECUTABLE judges by exit code and records nothing",
              summary: "migration 0230 · judged by the exit code alone", trust: "confirmed",
              topics: ["projects-criteria"], validFrom: "2026-09-04T10:00:00.000Z"),
        entry(pitfallID, kind: "pitfall", title: "runner-go’s full suite inside a session reaches production",
              summary: "Fix: unset the ORBIT_* variables before go test ./...", trust: "confirmed",
              topics: ["runner-engines", "tasks-dispatch"], validFrom: "2026-09-24T09:00:00.000Z"),
        entry("34UDFnrgM4q5oHeadless", kind: "pitfall", title: "Headless Chromium needs --window-size=393",
              summary: "A phone viewport below 500 is clamped to 500.", trust: "confirmed", status: "retired",
              topics: ["testing-ci"], validFrom: "2026-09-25T07:00:00.000Z", anchorState: "missing"),
    ].joined(separator: ",") + "]"

    /// `GET /wiki/spaces/:id/timeline` — newest first.
    static let timeline = """
    {"items":[
     {"opId":"0196e000-0000-7000-8000-00000000a001","op":"add","decision":"accepted","origin":"agent",
      "at":"2026-09-25T10:00:00.000Z","entryId":"34UDFnrgM4q5oPriority","title":"Task priority is a field on the task",
      "kind":"decision","status":"active","trust":"confirmed","supersededById":null,"supersededByTitle":null,"reason":null},
     {"opId":"0196e000-0000-7000-8000-00000000a002","op":"retire","decision":"accepted","origin":"maintenance",
      "at":"2026-09-25T07:00:00.000Z","entryId":"34UDFnrgM4q5oHeadless","title":"Headless Chromium needs --window-size=393",
      "kind":"pitfall","status":"retired","trust":"confirmed","supersededById":"34UDFnrgM4q5oHeadles2",
      "supersededByTitle":"Headless Chromium clamps windows under 500","reason":"anchor missing"},
     {"opId":"0196e000-0000-7000-8000-00000000a003","op":"amend","decision":"auto_applied","origin":"owner",
      "at":"2026-09-24T12:00:00.000Z","entryId":"\(pitfallID)","title":"runner-go’s full suite inside a session reaches production",
      "kind":"pitfall","status":"active","trust":"confirmed","supersededById":null,"supersededByTitle":null,"reason":null},
     {"opId":"0196e000-0000-7000-8000-00000000a004","op":"add","decision":"auto_applied","origin":"owner",
      "at":"2026-09-24T11:00:00.000Z","entryId":"34UDFnrgM4q5oDeleteMe","title":"Delete means forget",
      "kind":"principle","status":"active","trust":"owner","supersededById":null,"supersededByTitle":null,"reason":null},
     {"opId":"0196e000-0000-7000-8000-00000000a005","op":"add","decision":"accepted","origin":"agent",
      "at":"2026-09-23T10:00:00.000Z","entryId":"34UDFnrgM4q5oCutBetas","title":"Cut betas from main, never from a session branch",
      "kind":"convention","status":"active","trust":"confirmed","supersededById":null,"supersededByTitle":null,"reason":null}]}
    """

    /// `GET /wiki/entries/:id?include=sources,history,exposure` — the pitfall mock 08 opens.
    static let entryDetail = """
    {"id":"\(pitfallID)","publicId":"\(pitfallID)","spaceId":"\(spaceID)","kind":"pitfall","status":"active",
     "trust":"confirmed","currentRevision":2,
     "title":"runner-go’s full suite inside a session reaches production",
     "summary":"Fix: unset the ORBIT_* variables before go test ./...",
     "fields":{"trigger":{"paths":["src/runner-go"],"commands":["go test ./..."],"errorSignature":"403 PROJECT_SCOPE_MISMATCH"},
       "symptom":"11 CLI tests fail and one hangs until -timeout panics.",
       "cause":"The tests point the CLI at an httptest server, but it still reads the session's ORBIT_* variables and takes the real approval path to the live control plane.",
       "fix":"env -u ORBIT_SESSION_ID -u ORBIT_AGENT_ID -u ORBIT_TASK_ID go test ./..."},
     "topics":["runner-engines","tasks-dispatch"],"aliases":["ORBIT env leak"],
     "anchors":[{"type":"symbol","path":"src/runner-go/mcp.go","symbol":"askBeforeCreate",
                 "check":{"state":"verified","ref":"\(sha)","at":"2026-09-25T08:00:00.000Z"}},
                {"type":"path","path":"src/runner-go/task_completion_criterion_test.go",
                 "check":{"state":"verified","ref":"\(sha)","at":"2026-09-25T08:00:00.000Z"}}],
     "anchorState":"verified","anchorCheckedRef":"\(sha)","anchorCheckedAt":"2026-09-25T08:00:00.000Z",
     "tainted":false,"challenged":false,"unsupported":false,"pinned":true,
     "supersedesId":null,"supersededById":null,"validFrom":"2026-09-23T09:00:00.000Z","validTo":null,
     "recordedAt":"2026-09-23T09:00:00.000Z","retiredAt":null,
     "sources":[
       {"id":"34UDSrcSessionTurn001","kind":"turn","ref":"0196e000-0000-7000-8000-0000000000c1",
        "locator":{"seq":412,"turnId":"34UDTurnRunnerGoSuite1","turnPublicId":"34UDTurnRunnerGoSuite1"},
        "quote":"POST /runner/sessions/4X5lUuVWEnCac52nlGitt/approvals -> 403 refused: PROJECT_SCOPE_MISMATCH",
        "quoteVerified":true,"state":"live","tainted":false,"createdAt":"2026-09-23T09:00:00.000Z"},
       {"id":"34UDSrcTask0000000002","kind":"task","ref":"0196e000-0000-7000-8000-0000000000c2","locator":null,
        "quote":"把 ORBIT_* 变量 env -u 掉之后同样的命令 0.6s 全绿","quoteVerified":true,"state":"live",
        "tainted":false,"createdAt":"2026-09-23T09:00:00.000Z"},
       {"id":"34UDSrcCommit00000003","kind":"commit","ref":"864cad31c0000000000000000000000000000000","locator":null,
        "quote":"ok orbit 0.588s — the same 11 tests, with ORBIT_* unset","quoteVerified":true,"state":"live",
        "tainted":false,"createdAt":"2026-09-23T09:00:00.000Z"}],
     "history":[
       {"id":"34UDRev2","revision":2,"title":"runner-go’s full suite inside a session reaches production",
        "summary":"Fix: unset the ORBIT_* variables before go test ./...","authorKind":"owner",
        "authorSessionId":null,"changesetOpId":"34UDOpAmend","createdAt":"2026-09-24T12:00:00.000Z"},
       {"id":"34UDRev1","revision":1,"title":"runner-go’s full suite inside a session reaches production",
        "summary":"Unset ORBIT_* first.","authorKind":"agent","authorSessionId":"34TYUP5wb87XfuYCInJRY",
        "changesetOpId":"34UDOpAdd","createdAt":"2026-09-23T09:00:00.000Z"}],
     "exposure":[
       {"sessionId":"34TYUP5wb87XfuYCInJRY","entryId":"\(pitfallID)","revision":2,"channel":"push","at":"2026-09-25T09:00:00.000Z"},
       {"sessionId":"34TcwNgAIo6tGUiIKjqnQ","entryId":"\(pitfallID)","revision":2,"channel":"get","at":"2026-09-25T07:00:00.000Z"},
       {"sessionId":"34TYUP5wb87XfuYCInJRY","entryId":"\(pitfallID)","revision":1,"channel":"push","at":"2026-09-24T06:00:00.000Z"}]}
    """

    /// `GET /wiki/review` — three proposals from two sessions (and one run of Wiki maintenance, which
    /// has no session): an ADD, a RETIRE and a web-derived AMEND, the three cards mock 09 draws.
    static let review = """
    [{"id":"34UDCsAddPitfall00001","publicId":"34UDCsAddPitfall00001","spaceId":"\(spaceID)","origin":"agent",
      "sessionId":"34TYUP5wb87XfuYCInJRY","toolCallId":null,"rationale":"Orbit wiki review",
      "status":"pending","createdAt":"2026-09-25T12:48:00.000Z","decidedAt":null,"expiresAt":"2026-10-09T12:48:00.000Z",
      "ops":[{"id":"34UDOpAddPitfall00001","changesetId":"34UDCsAddPitfall00001","seq":0,"op":"add",
        "entryId":null,"baseRevision":null,"tainted":false,"decision":"pending","decisionReason":null,
        "decisionNote":null,"resultEntryId":"34UDEntrySecretRedact","resultRevision":1,"decidedAt":null,
        "similar":[],
        "payload":{"op":"add","entry":{"kind":"pitfall","title":"Secret redaction lets ENV_VAR=value secrets through",
          "summary":"POSTGRES_PASSWORD=… reaches the watch's lastError unredacted.",
          "fields":{"trigger":{"paths":["src/apiserver/src/watches/watch-redaction.ts"],"commands":[]},
            "symptom":"The value is stored in the delivery's lastError and shown on the watch and the dead-letter list unredacted.",
            "cause":"The key pattern starts with \\\\b, and _ is a word character, so \\\\bpassword never matches inside POSTGRES_PASSWORD.",
            "fix":"Let the key follow _ as well as a word boundary, and add POSTGRES_PASSWORD=hunter2 to the redaction spec."},
          "anchors":[{"type":"path","path":"src/apiserver/src/watches/watch-redaction.ts"}]},
          "sources":[{"kind":"tool_call","ref":"0196e000-0000-7000-8000-0000000000d1",
            "quote":"POSTGRES_PASSWORD=hunter2 => POSTGRES_PASSWORD=hunter2"}]}}]},
     {"id":"34UDCsRetireWakeup002","spaceId":"\(spaceID)","origin":"maintenance","sessionId":null,"toolCallId":null,
      "rationale":"Wiki maintenance","status":"pending","createdAt":"2026-09-25T11:00:00.000Z","decidedAt":null,
      "expiresAt":"2026-10-09T11:00:00.000Z",
      "ops":[{"id":"34UDOpRetireWakeup002","changesetId":"34UDCsRetireWakeup002","seq":0,"op":"retire",
        "entryId":"34UDFnrgM4q5oWakeLost","baseRevision":1,"tainted":false,"decision":"pending",
        "decisionReason":null,"decisionNote":null,"resultEntryId":null,"resultRevision":null,"decidedAt":null,
        "similar":[],
        "payload":{"op":"retire","entryId":"34UDFnrgM4q5oWakeLost","baseRevision":1,
          "reason":"Fix landed: wakeups are held by the server (1125c445a on main)."}}]},
     {"id":"34UDCsAmendDeploy0003","spaceId":"\(spaceID)","origin":"agent","sessionId":"34TcwNgAIo6tGUiIKjqnQ",
      "toolCallId":null,"rationale":"Upgrade deploy","status":"pending","createdAt":"2026-09-25T12:00:00.000Z",
      "decidedAt":null,"expiresAt":"2026-10-09T12:00:00.000Z",
      "ops":[{"id":"34UDOpAmendDeploy0003","changesetId":"34UDCsAmendDeploy0003","seq":0,"op":"amend",
        "entryId":"34UDFnrgM4q5oDeployXX","baseRevision":3,"tainted":true,"decision":"pending",
        "decisionReason":null,"decisionNote":null,"resultEntryId":null,"resultRevision":null,"decidedAt":null,
        "similar":[{"id":"34UDFnrgM4q5oCutBetas","kind":"convention","title":"Cut betas from main, never from a session branch",
          "status":"active","trust":"confirmed","score":0.31}],
        "payload":{"op":"amend","entryId":"34UDFnrgM4q5oDeployXX","baseRevision":3,
          "changes":{"summary":"Run /upgrade from a clean checkout; the postgres and gateway base images are opt-in via --pull-base."}}},
       {"id":"34UDOpReinforceDone04","changesetId":"34UDCsAmendDeploy0003","seq":1,"op":"reinforce",
        "entryId":"34UDFnrgM4q5oDeployXX","baseRevision":null,"tainted":false,"decision":"auto_applied",
        "decisionReason":null,"decisionNote":null,"resultEntryId":null,"resultRevision":null,
        "decidedAt":"2026-09-25T12:00:00.000Z","similar":[],"payload":{"op":"reinforce"}}]}]
    """

    static func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }
}
