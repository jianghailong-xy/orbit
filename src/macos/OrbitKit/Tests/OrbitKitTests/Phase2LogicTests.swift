import XCTest
@testable import OrbitKit

final class Phase2LogicTests: XCTestCase {

    // MARK: bash prefix (mirrors the web's bashPrefix)

    func testBashPrefix() {
        XCTAssertEqual(Approvals.bashPrefix("git commit -m \"x\""), "git commit")
        XCTAssertEqual(Approvals.bashPrefix("ls -la"), "ls")
        XCTAssertEqual(Approvals.bashPrefix("FOO=bar git push"), "git push")   // skip env assignment
        XCTAssertEqual(Approvals.bashPrefix("  npm   test  "), "npm test")      // collapse whitespace
        XCTAssertEqual(Approvals.bashPrefix("./script.sh --flag"), "./script.sh") // flag isn't a subcmd
        XCTAssertEqual(Approvals.bashPrefix("git -C /repo status"), "git")      // -C isn't a subcmd word
        XCTAssertNil(Approvals.bashPrefix("   "))
        XCTAssertNil(Approvals.bashPrefix("|| true"))                           // no clean program word
    }

    // MARK: remember-rule

    func testRememberRule() {
        let bash = Approvals.rememberRule(toolName: "Bash",
                                          input: .object(["command": .string("git commit -m x")]))
        XCTAssertEqual(bash, PermissionRule(toolName: "Bash", ruleContent: "git commit:*"))
        XCTAssertEqual(bash.map(Approvals.rememberLabel), "git commit")

        XCTAssertNil(Approvals.rememberRule(toolName: "AskUserQuestion", input: .null))
        XCTAssertNil(Approvals.rememberRule(toolName: "ExitPlanMode", input: .null))
        XCTAssertNil(Approvals.rememberRule(toolName: "Bash",
                                            input: .object(["command": .string("|| true")])))

        let edit = Approvals.rememberRule(toolName: "Edit", input: .null)
        XCTAssertEqual(edit, PermissionRule(toolName: "Edit"))
        XCTAssertEqual(edit.map(Approvals.rememberLabel), "Edit")
    }

    // MARK: AskUserQuestion parsing

    func testParseQuestions() {
        let input: JSONValue = .object([
            "questions": .array([
                .object([
                    "header": .string("Auth method"),
                    "question": .string("Which auth?"),
                    "multiSelect": .bool(false),
                    "options": .array([
                        .object(["label": .string("JWT"), "description": .string("stateless")]),
                        .object(["label": .string("Session"), "description": .string("cookie")]),
                    ]),
                ]),
            ]),
        ])
        let qs = Approvals.parseQuestions(from: input)
        XCTAssertEqual(qs.count, 1)
        XCTAssertEqual(qs[0].header, "Auth method")
        XCTAssertEqual(qs[0].question, "Which auth?")
        XCTAssertFalse(qs[0].multiSelect)
        XCTAssertEqual(qs[0].options.map(\.label), ["JWT", "Session"])
        XCTAssertEqual(qs[0].options[0].description, "stateless")

        XCTAssertTrue(Approvals.parseQuestions(from: .object(["foo": .string("bar")])).isEmpty)
    }

    // MARK: composer gating

    func testSendAvailability() {
        XCTAssertEqual(ComposerLogic.availability(status: .awaitingInput), .sendNow)
        XCTAssertEqual(ComposerLogic.availability(status: .running), .queue)
        XCTAssertEqual(ComposerLogic.availability(status: .pending), .queue)
        XCTAssertEqual(ComposerLogic.availability(status: .succeeded), .sendNow)
        XCTAssertTrue(ComposerLogic.shouldResume(status: .parked))
        XCTAssertFalse(ComposerLogic.shouldResume(status: .awaitingInput))
    }

    func testMakeTurn() {
        let msg = ComposerLogic.makeTurn(clientTurnId: "c1", text: "hi", shell: false, attachmentIds: [])
        XCTAssertEqual(msg.kind, "message")
        XCTAssertNil(msg.attachmentIds)

        let shell = ComposerLogic.makeTurn(clientTurnId: "c2", text: "ls", shell: true, attachmentIds: ["a1"])
        XCTAssertEqual(shell.kind, "shell")
        XCTAssertEqual(shell.attachmentIds, ["a1"])
    }

    // MARK: `/` autocomplete (mirrors the web composer's slash menu)

    func testSlashToken() {
        XCTAssertNil(ComposerSlash.token(in: ""))
        XCTAssertNil(ComposerSlash.token(in: "hello"))
        XCTAssertNil(ComposerSlash.token(in: "hello/foo"))      // `/` not at a word boundary
        XCTAssertNil(ComposerSlash.token(in: "/foo bar"))       // token isn't the trailing word
        XCTAssertEqual(ComposerSlash.token(in: "/"), "")
        XCTAssertEqual(ComposerSlash.token(in: "/foo"), "foo")
        XCTAssertEqual(ComposerSlash.token(in: "hello /com"), "com")
        XCTAssertEqual(ComposerSlash.token(in: "hi\n/de"), "de") // newline counts as whitespace
    }

    func testSlashScopedAndMatches() {
        let items = [
            SlashCommandInfo(name: "commit", description: nil, type: "command", agentId: nil),
            SlashCommandInfo(name: "deploy", description: nil, type: "command", agentId: "a1"),
            SlashCommandInfo(name: "review", description: nil, type: "skill", agentId: "a2"),
            SlashCommandInfo(name: "compose", description: nil, type: "skill", agentId: nil),
        ]
        // host-level + this agent's assets only
        let scoped = ComposerSlash.scoped(items: items, agentID: "a1")
        XCTAssertEqual(scoped.map(\.name).sorted(), ["commit", "compose", "deploy"])

        // prefix-matches sort ahead of substring matches; capped to scope
        let m = ComposerSlash.matches(items: scoped, token: "com", scope: nil)
        XCTAssertEqual(m.map(\.name), ["commit", "compose"])

        let onlyCommands = ComposerSlash.matches(items: scoped, token: "", scope: "command")
        XCTAssertEqual(onlyCommands.map(\.name).sorted(), ["commit", "deploy"])

        XCTAssertTrue(ComposerSlash.matches(items: scoped, token: nil, scope: nil).isEmpty)
    }

    func testSlashPickAndOpening() {
        XCTAssertEqual(ComposerSlash.pick(text: "/com", name: "commit"), "/commit ")
        XCTAssertEqual(ComposerSlash.pick(text: "hello /com", name: "commit"), "hello /commit ")
        XCTAssertEqual(ComposerSlash.pick(text: "no token", name: "commit"), "no token")

        XCTAssertEqual(ComposerSlash.opening(text: ""), "/")
        XCTAssertEqual(ComposerSlash.opening(text: "hi "), "hi /")
        XCTAssertEqual(ComposerSlash.opening(text: "hi"), "hi /")
    }

    // MARK: attachment limits

    func testAttachmentLimits() {
        XCTAssertTrue(Attachments.isInlineImage(mimeType: "image/png"))
        XCTAssertFalse(Attachments.isInlineImage(mimeType: "application/pdf"))
        XCTAssertNil(Attachments.rejectReason(mimeType: "image/png", byteCount: 1_000))
        XCTAssertEqual(Attachments.rejectReason(mimeType: "image/png", byteCount: 0), "File is empty")
        XCTAssertEqual(Attachments.rejectReason(mimeType: "image/png", byteCount: 6 * 1024 * 1024),
                       "Image exceeds the 5MB limit")
        XCTAssertEqual(Attachments.rejectReason(mimeType: "application/zip", byteCount: 26 * 1024 * 1024),
                       "File exceeds the 25MB limit")
        XCTAssertNil(Attachments.rejectReason(mimeType: "application/zip", byteCount: 20 * 1024 * 1024))
    }

    // MARK: multipart

    func testMultipartBody() {
        let body = Multipart.body(boundary: "B", fieldName: "file", filename: "a.png",
                                  mimeType: "image/png", fileData: Data("PNG".utf8))
        let s = String(decoding: body, as: UTF8.self)
        XCTAssertTrue(s.hasPrefix("--B\r\n"))
        XCTAssertTrue(s.contains("Content-Disposition: form-data; name=\"file\"; filename=\"a.png\""))
        XCTAssertTrue(s.contains("Content-Type: image/png\r\n\r\n"))
        XCTAssertTrue(s.contains("PNG"))
        XCTAssertTrue(s.hasSuffix("\r\n--B--\r\n"))
    }

    // MARK: diff decode + defaults

    func testFilePatchDecode() throws {
        let json = #"{"patches":[{"path":"a.swift","patch":"@@ -1 +1 @@","truncated":false},{"path":"b.txt"}]}"#
        let diff = try JSONDecoder().decode(SessionDiff.self, from: Data(json.utf8))
        XCTAssertEqual(diff.patches.count, 2)
        XCTAssertEqual(diff.patches[0].path, "a.swift")
        XCTAssertEqual(diff.patches[0].truncated, false)
        XCTAssertNil(diff.patches[1].patch)
    }

    func testAgentDefaults() {
        XCTAssertEqual(AgentDefaults.friendlyName("claude-opus-4-8"), "Opus 4.8")
        XCTAssertEqual(AgentDefaults.friendlyName("unknown-model"), "unknown-model")
        XCTAssertEqual(AgentDefaults.label(.bypass), "Bypass")
        XCTAssertEqual(AgentDefaults.defaultModelID, "claude-opus-4-8")
    }
}
