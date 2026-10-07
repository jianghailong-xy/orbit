import Foundation

/// The SOURCE chain's refusal, as a session row carries it.
///
/// The vocabulary belongs to `docs/project-source-contract.md` §10.1, and the one place every
/// implementation reads it from is `src/shared/src/source.ts`. This client only READS it: the code
/// and the `fixAction` are the server's, and §10.1 pairs them precisely so that a client does not
/// carry a second copy of that table which can disagree with it (SR49) — so nothing here computes
/// an action from a code.
public struct SourceRefusalDetail: Codable, Equatable, Sendable {
    /// §10.1's sixth column: the one thing a person can do about this refusal.
    public let fixAction: String?
    /// The full name of the ref-valued selector that failed, e.g. `refs/heads/project/<id>`.
    public let ref: String?
    /// git's own words, when a checkout is where this was decided.
    public let stderr: String?
    /// The runner's sentence when it is not git's. The server reads the same two keys in the same
    /// order (`refusalReason()` in `projects/session-source.ts`).
    public let reason: String?

    public init(fixAction: String? = nil, ref: String? = nil, stderr: String? = nil,
                reason: String? = nil) {
        self.fixAction = fixAction
        self.ref = ref
        self.stderr = stderr
        self.reason = reason
    }

    /// What the runner said, in whichever key it used — blank counts as unsaid.
    public var said: String? {
        for candidate in [stderr, reason] {
            let trimmed = candidate?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let trimmed, !trimmed.isEmpty { return trimmed }
        }
        return nil
    }
}
