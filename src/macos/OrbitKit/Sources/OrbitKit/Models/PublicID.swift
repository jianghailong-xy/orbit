import Foundation

/// The base62 public id the server is moving to as *the* id above the API line
/// (docs/public-id-migration-design.md). Mirrors `@orbit/shared`'s `toUuid` and the runner's
/// `decodeSessionID`.
///
/// The decode direction is what keys local caches: the native clients never build a URL out of an
/// id (there is no address bar to put it in). Both spellings of a session must name the same cache
/// entry, so a snapshot written before the server switched is still found afterwards instead of
/// silently re-fetching.
///
/// The encode direction exists for the one id these clients ORIGINATE rather than receive: the
/// `triggerId` naming one press of Run now (`RunTaskRequest`). It is spelled the way every id above
/// the API line is spelled, which is also the only spelling `@IsPublicId` guarantees to accept
/// unchanged across the migration.
public enum PublicID {
    private static let alphabet = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")

    private static let value: [Character: UInt32] = {
        var map: [Character: UInt32] = [:]
        for (i, ch) in alphabet.enumerated() { map[ch] = UInt32(i) }
        return map
    }()

    /// Canonical lowercase UUID for either spelling, or nil if the input is neither.
    ///
    /// Swift has no 128-bit integer, so the base62 digits are accumulated straight into the 16
    /// bytes of the UUID: `bytes = bytes * 62 + digit`, big-endian, carrying upward. A carry out
    /// of the top byte means the value needs more than 128 bits, which no UUID does.
    public static func toUUID(_ id: String) -> String? {
        if isUUID(id) { return id.lowercased() }
        guard !id.isEmpty else { return nil }

        var bytes = [UInt8](repeating: 0, count: 16)
        for ch in id {
            guard let digit = value[ch] else { return nil }
            var carry = digit
            for i in stride(from: 15, through: 0, by: -1) {
                let acc = UInt32(bytes[i]) * 62 + carry
                bytes[i] = UInt8(acc & 0xFF)
                carry = acc >> 8
            }
            if carry != 0 { return nil }
        }

        let hex = bytes.map { String(format: "%02x", $0) }.joined()
        let groups = [hex.prefix(8), hex.dropFirst(8).prefix(4), hex.dropFirst(12).prefix(4),
                      hex.dropFirst(16).prefix(4), hex.dropFirst(20)]
        return groups.map(String.init).joined(separator: "-")
    }

    /// A fresh Base62 public id, drawn here rather than received.
    ///
    /// 128 bits of `UUID`, encoded by repeated division: the 16 bytes are treated as one big-endian
    /// integer and divided by 62 until nothing is left, which is `uuidToBase62`'s loop written for a
    /// language with no 128-bit integer. Round-trips through `toUUID` by construction, so what the
    /// server decodes is exactly the id this client drew.
    ///
    /// No failure path, unlike the web and the runner: `UUID()` draws from the platform CSPRNG and
    /// is non-failable, so there is no "could not name this request" case to fail closed on here.
    public static func newToken() -> String {
        let u = UUID().uuid
        return base62([u.0, u.1, u.2, u.3, u.4, u.5, u.6, u.7,
                       u.8, u.9, u.10, u.11, u.12, u.13, u.14, u.15])
    }

    /// The 16 bytes of a value, big-endian, as Base62. Internal to `newToken`; `toUUID` is the
    /// inverse and `PublicIDTests` pins them against the other clients' shared vector.
    static func base62(_ bytes: [UInt8]) -> String {
        var digits = bytes
        var out: [Character] = []
        while let top = digits.firstIndex(where: { $0 != 0 }) {
            var remainder: UInt32 = 0
            for i in top..<digits.count {
                let acc = (remainder << 8) | UInt32(digits[i])
                digits[i] = UInt8(acc / 62)
                remainder = acc % 62
            }
            out.append(alphabet[Int(remainder)])
        }
        return out.isEmpty ? "0" : String(out.reversed())
    }

    /// Either spelling in, a stable key out. Total: an id that is neither is returned unchanged,
    /// because a cache miss is survivable and a crash on the load path is not.
    public static func storageKey(_ id: String) -> String { toUUID(id) ?? id }

    private static func isUUID(_ id: String) -> Bool {
        let parts = id.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.map(\.count) == [8, 4, 4, 4, 12] else { return false }
        return parts.allSatisfy { $0.allSatisfy(\.isHexDigit) }
    }
}
