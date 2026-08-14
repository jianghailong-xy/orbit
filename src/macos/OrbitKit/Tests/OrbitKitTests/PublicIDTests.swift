import XCTest
@testable import OrbitKit

/// Cross-checked against `@orbit/shared`'s codec and the runner's `decodeSessionID` — the three
/// implementations have to agree exactly, or a session's cache entry moves when the client that
/// wrote it differs from the client that reads it.
final class PublicIDTests: XCTestCase {
    private let uuid = "019fcbf3-0fa8-7f83-9302-46b25389cb16"
    private let base62 = "341DOGTVEs0Fk0gAn1mje"

    func testDecodesBase62ToTheSameUUIDTheOtherClientsProduce() {
        XCTAssertEqual(PublicID.toUUID(base62), uuid)
    }

    func testPassesACanonicalUUIDThrough() {
        XCTAssertEqual(PublicID.toUUID(uuid), uuid)
        XCTAssertEqual(PublicID.toUUID(uuid.uppercased()), uuid)
    }

    /// The property the whole migration rests on: both spellings name one cache entry.
    func testBothSpellingsShareOneStorageKey() {
        XCTAssertEqual(PublicID.storageKey(uuid), PublicID.storageKey(base62))
    }

    func testRejectsWhatIsNeitherSpelling() {
        XCTAssertNil(PublicID.toUUID(""))
        XCTAssertNil(PublicID.toUUID("not an id"))
        XCTAssertNil(PublicID.toUUID("019fcbf3-0fa8-7f83-9302-46b25389cb1"), "too short for a UUID")
        // 23 base62 digits exceed 128 bits, which no UUID does.
        XCTAssertNil(PublicID.toUUID(String(repeating: "z", count: 23)))
    }

    /// A miss is survivable; a crash on the cache-load path is not.
    func testStorageKeyIsTotal() {
        XCTAssertEqual(PublicID.storageKey("not an id"), "not an id")
    }

    /// Leading zeros are stripped by the encoder, so the decoder has to re-pad them — otherwise
    /// every id with high-order zero bits decodes short and lands on the wrong cache entry.
    func testDecodesASmallValueIntoAFullyPaddedUUID() {
        XCTAssertEqual(PublicID.toUUID("1"), "00000000-0000-0000-0000-000000000001")
        XCTAssertEqual(PublicID.toUUID("0"), "00000000-0000-0000-0000-000000000000")
    }
}
