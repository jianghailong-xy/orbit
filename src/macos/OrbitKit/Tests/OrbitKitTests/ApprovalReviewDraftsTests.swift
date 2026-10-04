import XCTest
@testable import OrbitKit

/// Opening and closing the sheet constructs new views. The console's keyed drafts must keep
/// what the owner typed, without lending an answer to a different request or conversation.
@available(macOS 14.0, *)
final class ApprovalReviewDraftsTests: XCTestCase {
    func testReopeningAQuestionKeepsItsSelectionsAndUnfinishedText() {
        let drafts = ApprovalReviewDrafts()
        let opened = drafts.question("approval-1")
        opened.selections["Which platforms?"] = ["iOS", "macOS"]
        opened.custom["Anything else?"] = "Include keyboard navigation"

        let reopened = drafts.question("approval-1")
        XCTAssertTrue(opened === reopened)
        XCTAssertEqual(reopened.selections["Which platforms?"], ["iOS", "macOS"])
        XCTAssertEqual(reopened.custom["Anything else?"], "Include keyboard navigation")

        // A second rendering of the same question writes into the same draft.
        reopened.custom["Anything else?"] = ""
        XCTAssertEqual(opened.custom["Anything else?"], "")
    }

    func testANewApprovalDoesNotInheritAnAnswerToTheSameQuestion() {
        let drafts = ApprovalReviewDrafts()
        let previous = drafts.question("approval-1")
        previous.selections["Proceed?"] = ["Yes"]
        previous.custom["Proceed?"] = "After checking the build"

        let next = drafts.question("approval-2")
        XCTAssertFalse(previous === next)
        XCTAssertTrue(next.selections.isEmpty)
        XCTAssertTrue(next.custom.isEmpty)
        XCTAssertEqual(drafts.question("approval-1").custom["Proceed?"], "After checking the build")
    }

    func testOwnerReviewKeepsAnswersForItsRequestAndStartsANewRequestEmpty() {
        let drafts = ApprovalReviewDrafts()
        let opened = drafts.owner("request-1")
        opened.choicesFor = "review-record-1"
        opened.choices = ["n1": .option(1), "n2": .other("Check the phone first")]

        let reopened = drafts.owner("request-1")
        XCTAssertTrue(opened === reopened)
        XCTAssertEqual(reopened.choicesFor, "review-record-1")
        XCTAssertEqual(reopened.choices,
                       ["n1": .option(1), "n2": .other("Check the phone first")])

        let newer = drafts.owner("request-2")
        XCTAssertFalse(opened === newer)
        XCTAssertNil(newer.choicesFor)
        XCTAssertTrue(newer.choices.isEmpty)
    }

    func testCoordinatorQuestionKeepsItsDraftAndThenItsSentReceipt() {
        let drafts = ApprovalReviewDrafts()
        let opened = drafts.coordinator("item-1")
        opened.chosen = .other
        opened.text = "Neither option fits"

        let reopened = drafts.coordinator("item-1")
        XCTAssertTrue(opened === reopened)
        XCTAssertEqual(reopened.chosen, .other)
        XCTAssertEqual(reopened.text, "Neither option fits")
        reopened.sent = "Neither option fits"
        reopened.receipt = OwnerAnswerReceipt(itemId: "item-1")

        let receipt = drafts.coordinator("item-1")
        XCTAssertEqual(receipt.sent, "Neither option fits")
        XCTAssertEqual(receipt.receipt?.itemId, "item-1")
        let next = drafts.coordinator("item-2")
        XCTAssertNil(next.chosen)
        XCTAssertEqual(next.text, "")
        XCTAssertEqual(next.sent, "")
        XCTAssertNil(next.receipt)
    }

    func testChangingConversationsStartsAllThreeDraftFamiliesEmpty() {
        let previous = ApprovalReviewDrafts()
        previous.question("same-id").custom["Question"] = "Answer"
        previous.owner("same-id").choices["n1"] = .other("Keep this answer")
        previous.coordinator("same-id").text = "My reply"

        let next = ApprovalReviewDrafts()
        XCTAssertTrue(next.question("same-id").custom.isEmpty)
        XCTAssertTrue(next.owner("same-id").choices.isEmpty)
        XCTAssertEqual(next.coordinator("same-id").text, "")
        XCTAssertEqual(previous.question("same-id").custom["Question"], "Answer")
        XCTAssertEqual(previous.owner("same-id").choices["n1"], .other("Keep this answer"))
        XCTAssertEqual(previous.coordinator("same-id").text, "My reply")
    }
}
