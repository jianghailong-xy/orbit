import Foundation

/// A pause is independent of authentication, quota and a contributor's enabled switch.
public enum AccountPause {
    public static func isPaused(_ until: String?, now: Date = Date()) -> Bool {
        guard let until, let date = RelativeTime.parse(until) else { return false }
        return date > now
    }

    public static func minutes(hours: String) -> Int? {
        guard let hours = Double(hours.trimmingCharacters(in: .whitespacesAndNewlines)),
              hours.isFinite, hours > 0, hours <= 168 else { return nil }
        let minutes = hours * 60
        guard minutes >= 1, abs(minutes.rounded() - minutes) < 0.000001 else { return nil }
        return Int(minutes.rounded())
    }
}

/// An explicit null resumes the account; omitting the property would not mean resume.
public struct AccountPauseRequest: Encodable, Sendable {
    public let durationMinutes: Int?

    public init(durationMinutes: Int?) { self.durationMinutes = durationMinutes }

    private enum CodingKeys: CodingKey { case durationMinutes }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if let durationMinutes {
            try container.encode(durationMinutes, forKey: .durationMinutes)
        } else {
            try container.encodeNil(forKey: .durationMinutes)
        }
    }
}
