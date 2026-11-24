import Foundation

public enum SessionPhase: String, Codable, Sendable {
    case pending = "PENDING"
    case running = "RUNNING"
    case idle = "IDLE"
}

public enum SessionTurnOutcome: String, Codable, Sendable {
    case answered = "ANSWERED"
    case failed = "FAILED"
    case interrupted = "INTERRUPTED"
    case cancelled = "CANCELLED"
}

public enum SessionWaitingOn: String, Codable, Sendable {
    case person = "PERSON"
    case hold = "HOLD"
    case wake = "WAKE"
}

/// The additive session fields can be missing or carry a value from a newer server.
/// Keep the field optional without making the surrounding payload fail to decode.
@propertyWrapper
public struct LenientSessionField<Value: Codable & Equatable & Sendable>: Codable, Equatable, Sendable {
    public var wrappedValue: Value?

    public init(wrappedValue: Value? = nil) {
        self.wrappedValue = wrappedValue
    }

    public init(from decoder: Decoder) throws {
        wrappedValue = try? decoder.singleValueContainer().decode(Value.self)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(wrappedValue)
    }
}

extension KeyedDecodingContainer {
    func decode<Value>(_ type: LenientSessionField<Value>.Type, forKey key: Key) throws -> LenientSessionField<Value> {
        try decodeIfPresent(type, forKey: key) ?? LenientSessionField()
    }
}

extension KeyedEncodingContainer {
    mutating func encode<Value>(_ field: LenientSessionField<Value>, forKey key: Key) throws {
        try encodeIfPresent(field.wrappedValue, forKey: key)
    }
}
