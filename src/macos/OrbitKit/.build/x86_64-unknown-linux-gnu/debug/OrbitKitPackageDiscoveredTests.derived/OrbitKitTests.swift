import XCTest
@testable import OrbitKitTests

fileprivate extension AppLogicTests {
    @available(*, deprecated, message: "Not actually deprecated. Marked as deprecated to allow inclusion of deprecated tests (which test deprecated functionality) without warnings")
    static nonisolated(unsafe) let __allTests__AppLogicTests = [
        ("testActiveGroupingOrdersAndBuckets", testActiveGroupingOrdersAndBuckets),
        ("testEmptyGrouping", testEmptyGrouping),
        ("testServerURLNormalization", testServerURLNormalization)
    ]
}

fileprivate extension ModelsCodableTests {
    @available(*, deprecated, message: "Not actually deprecated. Marked as deprecated to allow inclusion of deprecated tests (which test deprecated functionality) without warnings")
    static nonisolated(unsafe) let __allTests__ModelsCodableTests = [
        ("testEnumRawValuesMatchWireStrings", testEnumRawValuesMatchWireStrings),
        ("testJSONValueScalarCoercions", testJSONValueScalarCoercions),
        ("testLoginResponseDecodes", testLoginResponseDecodes),
        ("testRunEventDecodesWithNestedPayload", testRunEventDecodesWithNestedPayload),
        ("testRunEventToleratesMissingPayload", testRunEventToleratesMissingPayload),
        ("testUnknownEventTypeFallsBackNotThrows", testUnknownEventTypeFallsBackNotThrows)
    ]
}

fileprivate extension Phase2LogicTests {
    @available(*, deprecated, message: "Not actually deprecated. Marked as deprecated to allow inclusion of deprecated tests (which test deprecated functionality) without warnings")
    static nonisolated(unsafe) let __allTests__Phase2LogicTests = [
        ("testAgentDefaults", testAgentDefaults),
        ("testBashPrefix", testBashPrefix),
        ("testFilePatchDecode", testFilePatchDecode),
        ("testMakeTurn", testMakeTurn),
        ("testMultipartBody", testMultipartBody),
        ("testParseQuestions", testParseQuestions),
        ("testRememberRule", testRememberRule),
        ("testSendAvailability", testSendAvailability)
    ]
}

fileprivate extension SSEFrameParserTests {
    @available(*, deprecated, message: "Not actually deprecated. Marked as deprecated to allow inclusion of deprecated tests (which test deprecated functionality) without warnings")
    static nonisolated(unsafe) let __allTests__SSEFrameParserTests = [
        ("testIncrementalConsumeDispatchesOnBlankLine", testIncrementalConsumeDispatchesOnBlankLine),
        ("testMultiLineDataIsJoinedWithNewline", testMultiLineDataIsJoinedWithNewline),
        ("testParsesFramesIgnoringCommentsAndCRLF", testParsesFramesIgnoringCommentsAndCRLF),
        ("testSSEToReducerPath", testSSEToReducerPath)
    ]
}

fileprivate extension TranscriptReducerTests {
    @available(*, deprecated, message: "Not actually deprecated. Marked as deprecated to allow inclusion of deprecated tests (which test deprecated functionality) without warnings")
    static nonisolated(unsafe) let __allTests__TranscriptReducerTests = [
        ("testDurableDedupKeepsSingleItem", testDurableDedupKeepsSingleItem),
        ("testFoldsRecordedSession", testFoldsRecordedSession),
        ("testOptimisticUserReconciledByClientTurnId", testOptimisticUserReconciledByClientTurnId),
        ("testTextDeltaWithoutDurableFinalizeStillRenders", testTextDeltaWithoutDurableFinalizeStillRenders)
    ]
}
@available(*, deprecated, message: "Not actually deprecated. Marked as deprecated to allow inclusion of deprecated tests (which test deprecated functionality) without warnings")
func __OrbitKitTests__allTests() -> [XCTestCaseEntry] {
    return [
        testCase(AppLogicTests.__allTests__AppLogicTests),
        testCase(ModelsCodableTests.__allTests__ModelsCodableTests),
        testCase(Phase2LogicTests.__allTests__Phase2LogicTests),
        testCase(SSEFrameParserTests.__allTests__SSEFrameParserTests),
        testCase(TranscriptReducerTests.__allTests__TranscriptReducerTests)
    ]
}