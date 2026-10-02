import Foundation
import XCTest
@testable import OrbitKit

/// The wire between a retry and the send path it goes through.
///
/// The retry of the last user turn rides `ConsoleModel.send` for that path's gating, queueing and
/// failure handling — but it has to reach it as the message itself, never by being typed into the
/// composer first: on the native clients the composer sits on screen in front of the reader, so a
/// retry that goes through it is the message flashing through the input field on its way out (and
/// any draft already in there having to be moved aside and put back). Web has no such step — its
/// card calls the send mutation with the text directly.
///
/// No compiler here checks any of that: SwiftUI does not exist on Linux, and `ConsoleModel.swift`
/// is compiled only by the macOS and iOS jobs. So it is asserted over the source, the way
/// `EvidenceDecisionWiringTests` does, and each assertion is written so that PUTTING THE TEXT BACK
/// INTO THE COMPOSER is what turns it red.
final class RetrySendWiringTests: XCTestCase {

    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found above this test. If it moved, move this check with "
                    + "it rather than deleting it: it is the only gate on Linux that sees whether a "
                    + "retry still reaches the send path without going through the composer."
            }
        }
    }

    private static let consolePath = "src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift"
    private static let cardPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/Console/AutoRetryCard.swift"

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw WiringError.missing(relative)
    }

    /// One stretch of a file — from a marker to the next occurrence of another — so a match
    /// somewhere else cannot answer for the part being asserted about. (A bare `contains` over a
    /// whole file is how a scan like this goes falsely green.)
    private func section(_ source: String, from: String, to: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw WiringError.missing("\(from) … \(to)")
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    /// The retry hands its message over instead of typing it in.
    func testTheRetryHandsItsMessageToTheSendPath() throws {
        let retry = try section(try source(Self.consolePath),
                                from: "func retryLastMessage() async {",
                                to: "// MARK: auto-retry")
        XCTAssertTrue(retry.contains("await send(overrideText:"),
                      "the last user message goes to the send path as the message")
        XCTAssertFalse(retry.contains("composerText ="),
                       "and never into the composer: text landing in the input field before it is "
                           + "sent is the bug this test exists for")
    }

    /// …and the send path leaves the composer alone for a message it was handed that way.
    func testAnOverrideSendNeitherReadsNorClearsTheComposer() throws {
        let send = try sendBody()
        XCTAssertTrue(send.contains("ComposerLogic.parseShell(overrideText ?? composerText)"),
                      "an override send parses what it was handed, not what the composer holds")
        for line in send.split(separator: "\n") where line.contains("composerText = \"\"") {
            XCTAssertTrue(line.contains("fromComposer"),
                          "unguarded clear in send() — a retry would take the reader's draft with "
                              + "it: \(line.trimmingCharacters(in: .whitespaces))")
        }
        XCTAssertTrue(send.contains("let draft = overrideText ?? composerText"),
                      "a send that fails hands back what it consumed, which for a retry is the "
                          + "retried text rather than whatever the composer was holding")
    }

    /// The card does not decide from the window it happens to hold.
    ///
    /// `lastUserMessageText` reads the transcript this client loaded — its newest 200 events. That
    /// holds a conversation's last message and not a run's: a task session is one message followed
    /// by thousands of tool events, so the words a retry exists to re-send are at seq 1, outside
    /// the window. Reading it there is why a provider outage on a run drew a card with no Retry
    /// button at all. Each assertion below is written so that GOING BACK TO THE LOADED WINDOW as
    /// the only source is what turns it red.
    func testTheCardAsksTheServerWhenItsWindowHoldsNoMessage() throws {
        let card = try source(Self.cardPath)
        XCTAssertTrue(card.contains("console.retryMessageText"),
                      "the card reads the answer that falls back to the server's")
        XCTAssertFalse(card.contains("console.lastUserMessageText"),
                       "the loaded window is not the card's source of truth: reading it here is the "
                           + "bug this test exists for")
        XCTAssertTrue(card.contains("await console.refreshRetryText()"),
                      "and it goes and gets that answer when it appears, beside the armed retry")

        let console = try source(Self.consolePath)
        let resolved = try section(console,
                                   from: "var retryMessageText: String {",
                                   to: "func refreshRetryText")
        XCTAssertTrue(resolved.contains("loaded.isEmpty ? serverRetryText : loaded"),
                      "what is on screen wins when there is something on screen, and the server's "
                          + "answer stands in only when there is not")
        let fetch = try section(console,
                                from: "func refreshRetryText() async {",
                                to: "func retryLastMessage")
        XCTAssertTrue(fetch.contains("api.retryMessage(sessionID: sessionID)"),
                      "asked of the door that answers with the sweep's own chooser")
        XCTAssertTrue(fetch.contains("guard lastUserMessageText.isEmpty"),
                      "and asked only when the window came up empty — otherwise this is a request "
                          + "on every session anybody opens")
    }

    /// A retry carries the files the message was sent with.
    ///
    /// The bytes are on the server and always were — an attachment is uploaded once and the turn
    /// references it by id — so a retry has everything it needs to take the images with it. What
    /// it used to take was nothing: `carried` asked whether the send came from the composer, and a
    /// retry does not, so the person was told to find the two files again for a message the
    /// control plane was still holding whole.
    ///
    /// The old reading is what this asserts against: `carried` may no longer be decided by
    /// `fromComposer`, because that question is about where the TEXT came from and cannot answer
    /// which files belong to it.
    func testWhatARetryCarriesIsNotDecidedByWhereTheTextCameFrom() throws {
        let send = try sendBody()
        guard let carried = send.split(separator: "\n").first(where: { $0.contains("let carried") })
        else { throw WiringError.missing("`let carried` in send()") }

        XCTAssertFalse(carried.contains("fromComposer"),
                       "what a send carries is still decided by whether it came from the composer, "
                           + "which is the reading that sent a retry out with no files at all: "
                           + "\(carried.trimmingCharacters(in: .whitespaces))")
        XCTAssertTrue(send.contains("overrideAttachments ?? pendingAttachments"),
                      "a send carries what it was handed — for a retry, the attachments of the "
                          + "message being re-sent — and otherwise the composer's own chips")
    }

    /// …and the message being re-sent is where those files come from, read off the same bubble the
    /// text is read off. Attachments found any other way would re-send one message's words under
    /// another's files.
    func testTheRetryTakesTheFilesOffTheMessageItTakesTheTextOff() throws {
        let retry = try section(try source(Self.consolePath),
                                from: "func retryLastMessage() async {",
                                to: "// MARK: auto-retry")
        XCTAssertTrue(retry.contains("lastUserMessage"),
                      "the retry reads one bubble for both halves of what it re-sends")
        XCTAssertTrue(retry.contains("overrideAttachments:"),
                      "and hands that bubble's attachments to the send path beside its text")
    }

    /// The chips staged in the composer still belong to the message the reader is composing: a
    /// retry neither takes them with it nor clears them from under it. An image picked for the next
    /// message that silently left with a retry is the bug this half exists for, and carrying the
    /// re-sent turn's own files is not an excuse to stop guarding it.
    func testARetryStillLeavesTheComposersOwnChipsWhereTheyAre() throws {
        let send = try sendBody()
        for line in send.split(separator: "\n") where line.contains("pendingAttachments =") {
            XCTAssertTrue(line.contains("fromComposer"),
                          "unguarded chip clear or restore in send() — a retry would eat or double "
                              + "the attachments staged for the next message: "
                              + "\(line.trimmingCharacters(in: .whitespaces))")
        }
    }

    /// A failed send's "Couldn't send" line is taken down by the next send that goes through —
    /// from both paths a message can go out on, and only once the server has accepted it: cleared
    /// before the POST, a send that then failed too would have had its own line wiped with it.
    func testAnAcceptedSendTakesDownTheLineAFailedOneLeft() throws {
        let clear = "statusMessage = ComposerLogic.statusAfterAcceptedSend(statusMessage)"
        let accepted = try section(try sendBody(), from: "try await postTurn(", to: "} catch {")
        XCTAssertTrue(accepted.contains(clear), "send(): between the accepted POST and its catch")
        let interrupt = try section(try source(Self.consolePath),
                                    from: "func interruptAndSend() async {",
                                    to: "func cancelQueued")
        XCTAssertTrue(try section(interrupt, from: "try await api.interruptAndSend(", to: "} catch {")
                          .contains(clear),
                      "interruptAndSend(): between the accepted POST and its catch")
    }

    // MARK: the sentence neither end says any more

    /// The copy fence over a sentence that was DELETED.
    ///
    /// There is no shared string table across the clients: web and Swift each hardcode their own
    /// and stay in step by convention (see `TranscriptReducerTests`' own fence, which this follows).
    /// Web used to apologise in three places — a bulk withdraw, a single withdraw, and taking back
    /// an undelivered message — that the images "weren't restored — re-add if needed", and this end
    /// never said it at all. Now that both ends carry the files back, the sentence is wrong on web
    /// and would be wrong here: it tells the reader to go and find files the message still has.
    ///
    /// Asserted as an absence on both ends, which is the only way a deleted sentence can be held:
    /// nothing else would notice one of the three being put back, or this end growing its own.
    ///
    /// Deliberately a failure and never an `XCTSkip` when the web source cannot be found — a check
    /// that quietly opts out reports green on exactly the day the thing it watches comes back.
    func testNeitherEndTellsTheReaderToFindTheFilesAgain() throws {
        let web = try source(Self.workspacePath)
        let console = try source(Self.consolePath)

        for apology in ["weren't restored", "re-add if needed"] {
            XCTAssertFalse(web.contains(apology),
                           "\(Self.workspacePath) is telling the reader to re-add files the re-send "
                               + "now carries: \(apology.debugDescription). All three of these went "
                               + "when the attachments started coming back with the message.")
            XCTAssertFalse(console.contains(apology),
                           "\(Self.consolePath) has grown web's old apology: "
                               + "\(apology.debugDescription). This end carries the files too, so "
                               + "there is nothing to apologise for.")
        }
    }

    /// The other half of the same fence: both ends put the re-sent turn's own attachment ids on the
    /// request. An absence alone would be satisfied by an end that simply stopped saying anything
    /// while still sending none.
    func testBothEndsReSendAMessageWithTheFilesItWasSentWith() throws {
        let web = try source(Self.workspacePath)
        let console = try source(Self.consolePath)

        XCTAssertFalse(web.contains("sendMutate({ content: retryText, images: [] })"),
                       "\(Self.workspacePath)'s card retry still sends an empty array, which is the "
                           + "behaviour this end was aligned to and the one both are leaving")
        XCTAssertTrue(web.contains("attachmentIds: retry.attachmentIds"),
                      "\(Self.workspacePath)'s retry carries the ids of the turn it re-sends")
        XCTAssertTrue(console.contains("overrideAttachments:"),
                      "\(Self.consolePath)'s retry hands the send path the same thing")
    }

    private static let workspacePath = "src/web/src/components/WorkspaceView.tsx"
    private static let signInPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/RunnerSignInView.swift"
    private static let iosProject = "src/ios/project.yml"

    // MARK: another session's message (docs/session-request-reply-contract.md §2.1, §8 criterion 15)

    /// The Retry asks `RetryRoute` whose words it re-sends — the bubble's sender, else the server's
    /// answer — and another session's go to the server, never through `send`: that would say them again
    /// in the owner's name, signed by nobody, and leave the request they were on the turn that failed.
    func testAnotherSessionsMessageIsReSentByTheServerNotThroughSend() throws {
        let console = try source(Self.consolePath)
        let retry = try section(console, from: "func retryLastMessage() async {",
                                to: "private func resendFromSession() async {")
        XCTAssertTrue(retry.contains("RetryRoute.of(loadedText: last.text, loadedSender: last.sessionMessage,"),
                      "the route is decided off the same bubble the words are read off")
        XCTAssertTrue(retry.contains("serverText: serverRetryText, serverSender: serverRetrySender)"),
                      "and off the server's answer when the window holds no bubble")
        let serverCase = try section(retry, from: "case .serverResend:", to: "case .send(")
        XCTAssertTrue(serverCase.contains("await resendFromSession()"))
        XCTAssertFalse(serverCase.contains("send(overrideText:"),
                       "another session's message went through the owner's own send")

        let resend = try section(console, from: "private func resendFromSession() async {",
                                 to: "// MARK: auto-retry")
        XCTAssertTrue(resend.contains("try await api.resendRetryMessage(sessionID: sessionID)"),
                      "the server's re-send is what the route promises")
        XCTAssertFalse(resend.contains("send(overrideText:"))
        XCTAssertFalse(resend.contains("postTurn("), "the re-send reached the owner's turn door")
        XCTAssertFalse(resend.contains("composerText ="), "the re-send went through the composer")

        let fetch = try section(console, from: "func refreshRetryText() async {", to: "func retryLastMessage")
        XCTAssertTrue(fetch.contains("serverRetrySender = answer?.sessionMessage"),
                      "the server's answer about whose the words are was dropped")
        let bubble = try section(console, from: "var lastUserMessage:", to: "var lastUserMessageText")
        XCTAssertTrue(bubble.contains("return (b.text, b.attachments, b.sessionMessage)"),
                      "whose the words are is not read off the bubble the words are")
    }

    /// Both cards that offer Retry — the provider-failure card and the sign-in card — reach it through
    /// the one method that routes, so neither can send another session's words as the owner's.
    func testBothCardsRetryThroughTheRoutingMethod() throws {
        XCTAssertTrue(try source(Self.cardPath).contains("await console.retryLastMessage()"),
                      "the provider-failure card's Retry no longer goes through retryLastMessage")
        let signIn = try section(try source(Self.signInPath), from: "private func retry() async {", to: "}")
        XCTAssertTrue(signIn.contains("await console.retryLastMessage()"),
                      "the sign-in card's Retry no longer goes through retryLastMessage")
    }

    /// One failed message, one attempt (§2.1, §8 criterion 19).
    ///
    /// The press is remembered the moment it lands — before `send` has re-read the session's status,
    /// which is the gap a double tap falls into — and it is raised on BOTH routes: the server re-send
    /// and the client's own send. Both cards then draw the button disabled for as long as it stands,
    /// and the re-send carries no key of its own, so a second press cannot spell a second turn even if
    /// one reaches the server.
    func testARetryInFlightIsNotOfferedASecondOne() throws {
        let console = try source(Self.consolePath)
        let retry = try section(console, from: "func retryLastMessage() async {",
                                to: "private func resendFromSession() async {")
        XCTAssertTrue(retry.contains("guard !sending, !retryInFlight else { return }"),
                      "a second press is routed while the first is still on its way")
        let serverCase = try section(retry, from: "case .serverResend:", to: "case .send(")
        XCTAssertTrue(serverCase.contains("retryInFlight = true"),
                      "the server re-send leaves the button armed while it waits for an answer")
        let sendCase = try section(retry, from: "case .send(let text):", to: "await send(overrideText:")
        XCTAssertTrue(sendCase.contains("retryInFlight = true"),
                      "the owner's own re-send leaves the button armed while its send runs")

        // No key of the client's: the server derives one from the failed message (criterion 19).
        let resend = try section(console, from: "private func resendFromSession() async {",
                                 to: "// MARK: auto-retry")
        XCTAssertFalse(resend.contains("clientTurnId"),
                       "the re-send still names a key of its own, which a second press would "
                           + "spell differently")

        for (path, card) in [(Self.cardPath, "the provider-failure card"),
                             (Self.signInPath, "the sign-in card")] {
            let source = try source(path)
            XCTAssertTrue(source.contains(".disabled(console.sending || console.retryInFlight)"),
                          "\(card)'s Retry is still offered while its own press is in flight")
        }
    }

    /// iOS has no copy of its own: its target compiles the macOS shell's sources in place, so the routing
    /// above is the phone's too — unless one of these files lands on its exclude list.
    func testTheIOSClientCompilesTheSameRetry() throws {
        let project = try source(Self.iosProject)
        let sources = try section(project, from: "    sources:", to: "    dependencies:")
        XCTAssertTrue(sources.contains("path: ../macos/OrbitApp/Sources/OrbitApp"),
                      "the iOS client no longer reuses the shared shell")
        for file in ["ConsoleModel.swift", "AutoRetryCard.swift", "RunnerSignInView.swift"] {
            XCTAssertFalse(sources.contains(file), "the iOS target no longer compiles \(file)")
        }
    }

    /// `send`'s body, from its signature to the accessor below it. Read through one helper because
    /// the signature is what this work changes, and three copies of it would each have to be
    /// rewritten to say the same thing.
    private func sendBody() throws -> String {
        let console = try source(Self.consolePath)
        guard let start = console.range(of: "func send(authoritative: RunStatus? = nil,") else {
            throw WiringError.missing("func send(authoritative:overrideText:) in \(Self.consolePath)")
        }
        guard let end = console.range(of: "var lastUserMessage",
                                      range: start.upperBound..<console.endIndex) else {
            throw WiringError.missing("the accessor below send() in \(Self.consolePath)")
        }
        return String(console[start.lowerBound..<end.lowerBound])
    }
}
