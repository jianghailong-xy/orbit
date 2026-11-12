import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

/// Stands in for the owner-request doors: records what reached it and answers as the server does.
private final class OwnerRequestURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (@Sendable (URLRequest) -> (status: Int, data: Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: APIError.invalidResponse)
            return
        }
        let answer = handler(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: answer.status,
                                       httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: answer.data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private func sentBody(_ request: URLRequest) -> Data {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return Data() }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while stream.hasBytesAvailable {
        let read = stream.read(&buffer, maxLength: buffer.count)
        if read <= 0 { break }
        data.append(contentsOf: buffer[0..<read])
    }
    return data
}

private final class Sent: @unchecked Sendable {
    private let lock = NSLock()
    private var rows: [(method: String, path: String, body: [String: Any], query: String?)] = []
    func add(_ request: URLRequest) {
        let body = (try? JSONSerialization.jsonObject(with: sentBody(request))) as? [String: Any] ?? [:]
        lock.lock()
        rows.append((request.httpMethod ?? "", request.url?.path ?? "", body, request.url?.query))
        lock.unlock()
    }
    var all: [(method: String, path: String, body: [String: Any], query: String?)] {
        lock.lock(); defer { lock.unlock() }; return rows
    }
}

final class OwnerRequestsTests: XCTestCase {
    private let requestID = "0195f3a2-0000-7000-8000-000000000001"
    private let sessionID = "0195f3a2-0000-7000-8000-0000000000aa"
    private let now = ISO8601DateFormatter().date(from: "2026-11-07T10:55:00Z")!

    override func tearDown() {
        OwnerRequestURLProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [OwnerRequestURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!, tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    // MARK: fixtures — the mockup's requests, as the server serves them

    /// One row as the server serves it; `extra` replaces keys of the base row (JSON gives the first of two
    /// equal keys, so they are swapped in rather than appended).
    private func json(_ kind: String, state: String = "PENDING", extra: String = "") -> String {
        var row = try! JSONSerialization.jsonObject(with: Data(base(kind, state: state).utf8)) as! [String: Any]
        if !extra.isEmpty {
            let more = try! JSONSerialization.jsonObject(with: Data("{\(extra.dropFirst())}".utf8)) as! [String: Any]
            row.merge(more) { _, new in new }
        }
        return String(decoding: try! JSONSerialization.data(withJSONObject: row), as: UTF8.self)
    }

    private func base(_ kind: String, state: String) -> String {
        """
        {"id":"\(requestID)","kind":"\(kind)","state":"\(state)","title":"Provide a DeepSeek API key",
         "why":"Experiment 2 calls the DeepSeek model.","blocksTaskIds":["t1"],
         "ifUnanswered":"experiment 2 does not start","options":null,"recommendedOption":null,
         "steps":null,"secretSpec":null,"secretGrant":null,"verifyHint":null,
         "expiresAt":"2026-11-10T10:53:00Z","askedBySessionId":"\(sessionID)","projectId":null,
         "resolvedAt":null,"resolvedByUserId":null,"resolvedBySessionId":null,"resolutionNote":null,
         "answer":null,"createdAt":"2026-11-07T10:53:00Z"}
        """
    }

    private func secret(state: OwnerRequestState = .pending, file: Bool = false,
                        grant: OwnerRequestSecretGrant? = nil) -> OwnerRequest {
        OwnerRequest(id: requestID, kind: .secret, state: state, title: "Provide a DeepSeek API key",
                     why: "Experiment 2 calls the DeepSeek model.", blocksTaskIds: ["t1"],
                     ifUnanswered: "experiment 2 does not start; experiment 1 finishes on its own.",
                     secretSpec: OwnerRequestSecretSpec(name: "API key", runnerId: "r1",
                                                        envVar: file ? nil : "DEEPSEEK_API_KEY",
                                                        filePath: file ? "~/.config/deepseek/key" : nil),
                     secretScope: "TASK", secretGrant: grant, expiresAt: "2026-11-10T10:53:00Z",
                     askedBySessionId: sessionID, resolvedAt: state == .pending ? nil : "2026-11-07T10:58:00Z",
                     resolvedByUserId: state == .pending ? nil : "u1", createdAt: "2026-11-07T10:53:00Z")
    }

    private func steps() -> OwnerRequest {
        OwnerRequest(id: "s2", kind: .manualStep, title: "Reboot the GPU node after driver install",
                     why: "hostd rollout", blocksTaskIds: ["a", "b"],
                     steps: [OwnerRequestStep(text: "Sign in to the node's BMC console", link: "https://bmc.gpu-03.lab/"),
                             OwnerRequestStep(text: "Power-cycle the machine and wait for it to come back"),
                             OwnerRequestStep(text: "Confirm the driver loaded",
                                              command: "nvidia-smi --query-gpu=driver_version --format=csv")],
                     verifyHint: "runner gpu-03 reconnects", askedBySessionId: sessionID,
                     createdAt: "2026-11-06T09:00:00Z")
    }

    private func decision() -> OwnerRequest {
        OwnerRequest(id: "d3", kind: .decision, title: "Which branch lands first: auth or billing?",
                     why: "Both touch the session table.",
                     options: [OwnerRequestOption(label: "auth"), OwnerRequestOption(label: "billing")],
                     recommendedOption: 0, askedBySessionId: "other", createdAt: "2026-11-07T07:55:00Z")
    }

    private func confirm() -> OwnerRequest {
        OwnerRequest(id: "c4", kind: .confirm, title: "Confirm the release notes", why: "They go out at noon.",
                     askedBySessionId: sessionID, createdAt: "2026-11-07T10:00:00Z")
    }

    // MARK: each kind's card

    func testEachKindDecodesFromTheServersShape() throws {
        let list = """
        {"requests":[\(json("SECRET", extra: #","secretSpec":{"name":"API key","runnerId":"r1","envVar":"DEEPSEEK_API_KEY"},"secretScope":"TASK","secretGrant":{"state":"ACTIVE","endReason":null,"exposure":"ENV","expiresAt":"2026-11-14T10:58:00Z","deliveredAt":"2026-11-07T10:58:00Z","removedAt":null,"removalNote":null,"runnerOnline":true,"runnerLastSeenAt":null}"#)),
          \(json("MANUAL_STEP", extra: #","steps":[{"text":"Sign in","link":"https://bmc/"}]"#)),
          \(json("DECISION", extra: #","options":[{"label":"auth"},{"label":"billing","description":"later"}],"recommendedOption":0"#)),
          \(json("CONFIRM")),
          {"id":"bad","kind":"SOMETHING_NEW"}]}
        """
        let decoded = try JSONDecoder().decode(OwnerRequestList.self, from: Data(list.utf8)).requests
        // A row of a kind this build does not know is dropped, never the list.
        XCTAssertEqual(decoded.map(\.kind), [.secret, .manualStep, .decision, .confirm])
        XCTAssertEqual(decoded[0].secretSpec?.envVar, "DEEPSEEK_API_KEY")
        XCTAssertEqual(decoded[0].secretGrant?.state, .active)
        XCTAssertEqual(decoded[1].steps?.first?.link, "https://bmc/")
        XCTAssertEqual(decoded[2].options?[1].description, "later")
        XCTAssertEqual(decoded[2].recommendedOption, 0)
    }

    func testEachKindsCardSaysWhatItAsksFor() {
        XCTAssertEqual(OwnerRequestKind.allCases.map(OwnerRequests.kindTag), ["DECISION", "SECRET", "STEPS", "CONFIRM", "WIKI"])
        XCTAssertEqual(OwnerRequestKind.allCases.map(OwnerRequests.primaryLabel),
                       ["Send answer", "Provide key", "Mark done", "Confirm", "Create wiki"])
        XCTAssertEqual(OwnerRequestKind.allCases.map(OwnerRequests.declineLabel),
                       ["Decline…", "Decline…", "Can’t do this…", "Decline…", "Decline…"])
        XCTAssertEqual(OwnerRequestKind.allCases.map(OwnerRequests.inboxAction),
                       ["Answer", "Provide", "Open steps", "Review", "Review"])
        XCTAssertEqual(OwnerRequests.askedLine(secret(), now: now), "Asked 2m ago · expires in 2d 23h")
        XCTAssertEqual(OwnerRequests.removedText(secret()), "When the task ends, or after 7 days")
    }

    func testSecretCardWordingIsTheDesignsNotTheMockups() {
        let env = OwnerRequests.secretNotice(secret().secretSpec!, runner: "HPC")
        XCTAssertEqual(env, "Goes straight to HPC. Orbit keeps it out of this conversation and away from the agent; only commands the agent runs with it can use it. Use a key you can revoke.")
        XCTAssertFalse(env.contains("never appears"))
        let file = OwnerRequests.secretNotice(secret(file: true).secretSpec!, runner: "HPC")
        XCTAssertTrue(file.hasPrefix("Goes straight to HPC as a file."))
        XCTAssertTrue(file.hasSuffix("Use a key you can revoke."))
        XCTAssertEqual(OwnerRequests.destination(secret().secretSpec!, runner: "HPC"), "Runner HPC as DEEPSEEK_API_KEY")
        XCTAssertEqual(OwnerRequests.destination(secret(file: true).secretSpec!, runner: "HPC"),
                       "Runner HPC at ~/.config/deepseek/key")
    }

    func testSecretDraftStartsUnsavedAndSendsOnlyWhatWasTyped() {
        var draft = OwnerRequests.SecretDraft(spec: secret().secretSpec)
        // "Save to my account secrets" is unchecked by default (owner decision, design §9 #3).
        XCTAssertFalse(draft.save)
        XCTAssertNil(draft.body)
        XCTAssertFalse(OwnerRequests.canSubmit(secret(), draft: draft, option: nil, text: "", now: now))
        draft.value = "sk-123"
        XCTAssertTrue(OwnerRequests.canSubmit(secret(), draft: draft, option: nil, text: "", now: now))
        draft.save = true
        draft.saveAs = "  "
        XCTAssertNil(draft.body, "saving needs a name")
        draft.saveAs = "DeepSeek"
        guard case .value("sk-123", saveAs: "DeepSeek")? = draft.body else { return XCTFail("\(String(describing: draft.body))") }
        draft.savedID = "saved1"
        guard case .saved(id: "saved1")? = draft.body else { return XCTFail() }
    }

    func testDecisionNeedsAnOptionOrWordsAndTheOthersOnlyAPress() {
        let empty = OwnerRequests.SecretDraft(spec: nil)
        XCTAssertFalse(OwnerRequests.canSubmit(decision(), draft: empty, option: nil, text: "  ", now: now))
        XCTAssertTrue(OwnerRequests.canSubmit(decision(), draft: empty, option: 1, text: "", now: now))
        XCTAssertTrue(OwnerRequests.canSubmit(decision(), draft: empty, option: nil, text: "billing", now: now))
        XCTAssertTrue(OwnerRequests.canSubmit(steps(), draft: empty, option: nil, text: "", now: now))
        XCTAssertTrue(OwnerRequests.canSubmit(confirm(), draft: empty, option: nil, text: "", now: now))
        // Past its deadline nothing is pressable: the door would refuse it.
        let late = ISO8601DateFormatter().date(from: "2026-11-11T00:00:00Z")!
        XCTAssertFalse(OwnerRequests.canSubmit(secret(), draft: empty, option: nil, text: "", now: late))
        XCTAssertEqual(OwnerRequests.doneBody(decision(), option: 0, text: " ship it "),
                       OwnerRequestDoneBody(option: 0, text: "ship it"))
        XCTAssertEqual(OwnerRequests.doneBody(steps(), option: 3, text: "x"), OwnerRequestDoneBody())
    }

    func testStepsOnlyOpenWebLinks() {
        XCTAssertNotNil(OwnerRequests.openableLink("https://bmc.gpu-03.lab/"))
        XCTAssertNil(OwnerRequests.openableLink("file:///etc/passwd"))
        XCTAssertNil(OwnerRequests.openableLink("javascript:alert(1)"))
    }

    // MARK: resolving a request

    func testResolvingSendsEachDoorAndReadsTheEndedRequestBack() async throws {
        let sent = Sent()
        let done = json("MANUAL_STEP", state: "DONE")
        OwnerRequestURLProtocol.handler = { request in
            sent.add(request)
            return (200, Data(done.utf8))
        }
        let api = client()
        let ended = try await api.completeOwnerRequest(requestID, OwnerRequestDoneBody())
        XCTAssertEqual(ended.state, .done)
        _ = try await api.completeOwnerRequest(requestID, OwnerRequestDoneBody(option: 1, text: "billing"))
        _ = try await api.declineOwnerRequest(requestID, reason: "Not this week")
        _ = try await api.submitOwnerSecret(requestID, .value("sk-secret", saveAs: nil))
        _ = try await api.submitOwnerSecret(requestID, .saved(id: "saved1"))
        _ = try await api.cancelOwnerSecret(requestID)
        _ = try await api.revokeOwnerSecret(requestID)

        let rows = sent.all
        XCTAssertEqual(rows.map(\.method), Array(repeating: "POST", count: 7))
        XCTAssertEqual(rows.map(\.path), [
            "/api/owner-requests/\(requestID)/done", "/api/owner-requests/\(requestID)/done",
            "/api/owner-requests/\(requestID)/decline", "/api/owner-requests/\(requestID)/secret",
            "/api/owner-requests/\(requestID)/secret", "/api/owner-requests/\(requestID)/secret/cancel",
            "/api/owner-requests/\(requestID)/secret/revoke",
        ])
        XCTAssertTrue(rows[0].body.isEmpty)
        XCTAssertEqual(rows[1].body["option"] as? Int, 1)
        XCTAssertEqual(rows[1].body["text"] as? String, "billing")
        XCTAssertEqual(rows[2].body["reason"] as? String, "Not this week")
        // The key travels in the body, never in the address, and nothing else rides with it.
        XCTAssertEqual(rows[3].body as NSDictionary, ["value": "sk-secret"] as NSDictionary)
        XCTAssertFalse(rows.contains { $0.path.contains("sk-secret") || ($0.query ?? "").contains("sk-secret") })
        XCTAssertEqual(rows[4].body as NSDictionary, ["savedSecretId": "saved1"] as NSDictionary)
    }

    func testTheListsAreReadByState() async throws {
        let sent = Sent()
        let list = "{\"requests\":[\(json("CONFIRM"))]}"
        OwnerRequestURLProtocol.handler = { request in
            sent.add(request)
            return (200, Data(list.utf8))
        }
        let read = try await client().ownerRequests(state: "declined")
        XCTAssertEqual(read.requests.count, 1)
        XCTAssertEqual(sent.all.first?.path, "/api/owner-requests")
        XCTAssertEqual(sent.all.first?.query, "state=declined")
    }

    func testTheResolvedLineSaysHowWhoAndWhen() {
        let done = secret(state: .done, grant: OwnerRequestSecretGrant(
            state: .active, expiresAt: "2026-11-14T10:58:00Z", deliveredAt: "2026-11-07T10:58:00Z"))
        XCTAssertEqual(OwnerRequests.outcomeLine(done, runner: "HPC"), "Delivered to HPC as DEEPSEEK_API_KEY")
        XCTAssertEqual(OwnerRequests.byLine(done, now: now).hasPrefix("by you · "), true)
        XCTAssertNotNil(OwnerRequests.resolvedGrant(done))
        XCTAssertTrue(OwnerRequests.grantLine(done.secretGrant!, runner: "HPC", now: now)!.hasPrefix("Key is in · expires "))

        let declined = OwnerRequest(id: "x", kind: .manualStep, state: .declined, title: "t", why: "",
                                    askedBySessionId: sessionID, resolvedAt: "2026-11-07T10:58:00Z",
                                    resolvedByUserId: "u1", resolutionNote: "No access to the BMC",
                                    createdAt: "2026-11-07T10:00:00Z")
        XCTAssertEqual(OwnerRequests.outcomeLine(declined, runner: ""), "Declined: “No access to the BMC”")
        let answered = OwnerRequest(id: "y", kind: .decision, state: .done, title: "t", why: "",
                                    options: [OwnerRequestOption(label: "auth")], askedBySessionId: sessionID,
                                    answer: OwnerRequestAnswer(option: 0, text: "go"), createdAt: "2026-11-07T10:00:00Z")
        XCTAssertEqual(OwnerRequests.outcomeLine(answered, runner: ""), "auth: “go”")
        let expired = OwnerRequest(id: "z", kind: .confirm, state: .expired, title: "t", why: "",
                                   askedBySessionId: sessionID, createdAt: "2026-11-07T10:00:00Z")
        XCTAssertEqual(OwnerRequests.outcomeLine(expired, runner: ""), "Expired before anyone answered")
        XCTAssertEqual(OwnerRequests.byLine(expired, now: now), "")
        XCTAssertEqual(OwnerRequests.deviceLabel("ios"), "via iPhone")
        let removing = OwnerRequestSecretGrant(state: .removing, expiresAt: "2026-11-14T10:58:00Z",
                                               runnerOnline: false, runnerLastSeenAt: "2026-11-07T09:00:00Z")
        XCTAssertTrue(OwnerRequests.removalToTell(removing))
        XCTAssertTrue(OwnerRequests.grantLine(removing, runner: "HPC", now: now)!
            .hasPrefix("Removal pending: HPC has not been online since"))
    }

    // MARK: the inbox

    func testInboxRowsAndCount() {
        XCTAssertEqual(OwnerRequests.InboxTab.allCases.map(\.label), ["Open", "Done", "Declined"])
        XCTAssertEqual(OwnerRequests.inboxDetail(steps()), "3 steps")
        XCTAssertEqual(OwnerRequests.holdsText(steps(), now: now), "holds 2 tasks for 1d 1h")
        XCTAssertEqual(OwnerRequests.inboxDetail(decision()), "decision · recommended: auth")
        XCTAssertEqual(OwnerRequests.holdsText(secret(), now: now), "holds 1 task")
        let open = [secret(), steps(), decision()]
        XCTAssertEqual(OwnerRequests.waitingCount(open, snoozes: [:], now: now), 3)
        let later = [PublicID.storageKey(requestID): now.addingTimeInterval(3_600)]
        XCTAssertEqual(OwnerRequests.waitingCount(open, snoozes: later, now: now), 2)
        XCTAssertEqual(OwnerRequests.forSession(open + [confirm()], sessionID: sessionID).map(\.id),
                       ["s2", "c4", requestID])
        let read = OwnerRequests.merged([secret()], [secret(state: .done)])
        XCTAssertEqual(read.count, 1)
        XCTAssertEqual(read.first?.state, .done)
        XCTAssertEqual(OwnerRequests.find(PublicID.toPublic(requestID), in: open)?.kind, .secret)
    }

    func testSnoozesLiveOnThisDeviceAndLapse() {
        let defaults = UserDefaults(suiteName: "owner-request-snoozes-\(UUID().uuidString)")!
        let store = OwnerRequestSnoozes(defaults: defaults)
        store.snooze(requestID, until: now.addingTimeInterval(3_600), now: now)
        XCTAssertTrue(OwnerRequests.isSnoozed(PublicID.toPublic(requestID), snoozes: store.all(now: now), now: now))
        XCTAssertTrue(store.all(now: now.addingTimeInterval(3_601)).isEmpty, "a reminder that came due is gone")
        store.wake(requestID, now: now)
        XCTAssertTrue(store.all(now: now).isEmpty)
        XCTAssertEqual(OwnerRequests.snoozeChoices(secret(), now: now).map(\.label), ["In 1 hour", "In 4 hours", "Tomorrow"])
        let soon = ISO8601DateFormatter().date(from: "2026-11-10T08:00:00Z")!
        XCTAssertEqual(OwnerRequests.snoozeChoices(secret(), now: soon).map(\.label), ["In 1 hour"])
    }

    // MARK: the push actions and their deep link

    func testPushActionsOpenTheCardOrPutItOff() {
        let info = ["sessionID": sessionID, "kind": "owner-request", "ownerRequestID": requestID,
                    "ownerRequestKind": "SECRET"]
        XCTAssertEqual(Notifications.intent(actionId: Notifications.actionOwnerRequestOpen, userInfo: info),
                       .openOwnerRequest(requestID: requestID))
        XCTAssertEqual(Notifications.intent(actionId: Notifications.actionOwnerRequestLater, userInfo: info),
                       .snoozeOwnerRequest(requestID: requestID))
        // The plain tap still opens the conversation that asked.
        XCTAssertEqual(Notifications.intent(actionId: "com.apple.UNNotificationDefaultActionIdentifier", userInfo: info),
                       .open(.session(sessionID)))
        // The server's categories, one per kind, and the first action's words on each.
        XCTAssertEqual(OwnerRequestKind.allCases.map(Notifications.ownerRequestCategory), [
            "ORBIT_OWNER_REQUEST_DECISION", "ORBIT_OWNER_REQUEST_SECRET",
            "ORBIT_OWNER_REQUEST_MANUAL_STEP", "ORBIT_OWNER_REQUEST_CONFIRM", "ORBIT_OWNER_REQUEST_WIKI_CREATE",
        ])
        XCTAssertEqual(OwnerRequestKind.allCases.map(Notifications.ownerRequestActionTitle),
                       ["Answer", "Provide key", "Mark done", "Review", "Review"])
        XCTAssertEqual(Notifications.ownerRequestLaterTitle, "Later")
        let reminder = Notifications.ownerRequestReminder(requestID: requestID, kind: .secret,
                                                          title: "Provide a DeepSeek API key", sessionID: sessionID)
        XCTAssertEqual(reminder.categoryIdentifier, "ORBIT_OWNER_REQUEST_SECRET")
        XCTAssertEqual(reminder.userInfo["ownerRequestID"], requestID)
        XCTAssertEqual(Notifications.intent(actionId: Notifications.actionOwnerRequestOpen, userInfo: reminder.userInfo),
                       .openOwnerRequest(requestID: requestID))
    }

    func testDeepLinkOpensTheCardFocusedOnItsInput() throws {
        let url = OwnerRequestLink.url(requestID)
        XCTAssertEqual(url.absoluteString, "orbit://owner-request/\(PublicID.toPublic(requestID))")
        XCTAssertEqual(OwnerRequestLink.parse(url), PublicID.toPublic(requestID))
        XCTAssertNil(OwnerRequestLink.parse(URL(string: "orbit://owner-request/not-an-id")!))
        XCTAssertNil(OwnerRequestLink.parse(URL(string: "orbit://session/\(requestID)")!))
        // Not a `Route`: the app's route door leaves it alone, and the owner-request door takes it.
        XCTAssertNil(DeepLink.parse(url))
        XCTAssertEqual(OwnerRequestLink.focus(.secret), .secret)
        XCTAssertEqual(OwnerRequestLink.focus(.decision), .answer)
        XCTAssertEqual(OwnerRequestLink.focus(.manualStep), .primary)
        XCTAssertEqual(OwnerRequestLink.focus(.confirm), .primary)
    }

    func testTheCardIsPlacedWhereItWasAsked() {
        let card = DeliveredDecisionCard(kind: .ownerRequest(requestID: requestID), placement: .at("2026-11-07T10:53:00Z"))
        XCTAssertEqual(card.id, "owner-request-\(PublicID.storageKey(requestID))")
        XCTAssertEqual(DeliveredDecisionCard(kind: .ownerRequest(requestID: PublicID.toPublic(requestID))).id, card.id)
    }

    // MARK: one inbox — the coordinators' questions beside the requests

    private func question(_ id: String, project: ProjectSummary, waiting: String, recommended: Int? = 0) -> OwnerInboxQuestion {
        let asked = CoordinatorQuestion(question: "Which branch lands **first**?",
                                        options: [.init(label: "auth"), .init(label: "billing")],
                                        recommendedOption: recommended)
        return OwnerInboxQuestion(projectID: project.id, projectTitle: project.title, coordinatorSessionID: "coord-1",
                                  row: ProjectOpenItemRow(itemId: id, kind: .coordinatorQuestion,
                                                          title: "Coordinator asks", waitingSince: waiting,
                                                          question: asked))
    }

    func testOpenQuestionsShareTheInboxAndTheCount() {
        let asking = ProjectSummary(id: "p-pay", title: "Payments", attention: ProjectListAttention(
            ownerItems: [ProjectListOwnerItem(kind: .coordinatorQuestion, count: 1, oldestWaitingSince: "2026-11-07T08:00:00Z")]))
        let quiet = ProjectSummary(id: "p-quiet", title: "Quiet", attention: ProjectListAttention(
            ownerItems: [ProjectListOwnerItem(kind: .escalated, count: 2, oldestWaitingSince: "2026-11-07T08:00:00Z")]))
        let closed = ProjectSummary(id: "p-done", title: "Done", status: .done, attention: ProjectListAttention(
            ownerItems: [ProjectListOwnerItem(kind: .coordinatorQuestion, count: 1, oldestWaitingSince: "2026-11-07T08:00:00Z")]))
        // Only open projects with a question waiting are read.
        XCTAssertEqual(OwnerRequests.projectsAsking([asking, quiet, closed]).map(\.id), ["p-pay"])

        // A project's open items: only the owner's questions become rows.
        let items = ProjectOpenItemsView(needsYou: [
            question("q1", project: asking, waiting: "2026-11-07T08:00:00Z").row,
            ProjectOpenItemRow(itemId: "e1", kind: .taskFailed, title: "Task failed", waitingSince: "2026-11-07T09:00:00Z"),
        ])
        let rows = OwnerRequests.questions(project: asking, items: items, coordinatorSessionID: "coord-1",
                                           coordinatorWorkspaceID: "ws-1")
        XCTAssertEqual(rows.map(\.id), ["q1"])
        XCTAssertEqual(rows.first?.coordinatorSessionID, "coord-1")
        XCTAssertEqual(OwnerRequests.questionTitle(rows[0]), "Which branch lands first?")
        XCTAssertEqual(OwnerRequests.questionDetail(rows[0]), "Payments · decision · recommended: auth")
        XCTAssertEqual(OwnerRequests.questionDetail(question("q2", project: asking, waiting: "2026-11-07T08:00:00Z",
                                                             recommended: nil)), "Payments · decision")

        // The Open tab: pending requests and questions, newest first; ended requests stay out.
        let q = question("q1", project: asking, waiting: "2026-11-07T08:00:00Z")   // 08:00
        let open = [secret(), steps(), confirm(), secret(state: .done)]           // 10:53, yesterday, 10:00
        XCTAssertEqual(OwnerRequests.openEntries(open, questions: [q]).map(\.id), [
            "request-\(PublicID.storageKey(requestID))", "request-\(PublicID.storageKey("c4"))", "question-q1",
            "request-\(PublicID.storageKey("s2"))",
        ])

        // One count: requests not put off, plus every open question.
        let pending = [secret(), steps(), confirm()]
        XCTAssertEqual(OwnerRequests.waitingCount(pending, questions: [q], snoozes: [:], now: now), 4)
        let later = [PublicID.storageKey(requestID): now.addingTimeInterval(3_600)]
        XCTAssertEqual(OwnerRequests.waitingCount(pending, questions: [q], snoozes: later, now: now), 3)
        XCTAssertEqual(OwnerRequests.waitingCount([], questions: [q, question("q3", project: asking, waiting: "x")],
                                                  snoozes: [:], now: now), 2)
    }
}
