import Foundation

/// One version of a task's completion evidence, as `GET /tasks/:id/evidence` lists it (oldest
/// first) — the web's `TaskEvidenceRevision`. Decoded leniently: a field this build cannot read
/// costs the card that field, never the task page it sits on.
public struct TaskEvidenceRevision: Decodable, Equatable, Sendable, Identifiable {
    public struct Check: Decodable, Equatable, Sendable {
        /// `TOOL_CALL`, `COMMIT`, `ARTIFACT` or `FILE`.
        public let kind: String
        public let ref: String
        /// TOOL_CALL only: the command the cited call ran.
        public let command: String?
        /// TOOL_CALL only: whether it did what the submitter says.
        public let succeeded: Bool?

        public init(kind: String, ref: String, command: String? = nil, succeeded: Bool? = nil) {
            self.kind = kind
            self.ref = ref
            self.command = command
            self.succeeded = succeeded
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            kind = (try? c.decode(String.self, forKey: .kind)) ?? ""
            ref = (try? c.decode(String.self, forKey: .ref)) ?? ""
            command = try? c.decodeIfPresent(String.self, forKey: .command)
            succeeded = try? c.decodeIfPresent(Bool.self, forKey: .succeeded)
        }

        enum CodingKeys: String, CodingKey { case kind, ref, command, succeeded }
    }

    public struct Envelope: Decodable, Equatable, Sendable {
        public let claim: String?
        public let gaps: [String]
        public let checks: [Check]

        public init(claim: String? = nil, gaps: [String] = [], checks: [Check] = []) {
            self.claim = claim
            self.gaps = gaps
            self.checks = checks
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            claim = try? c.decodeIfPresent(String.self, forKey: .claim)
            gaps = (try? c.decodeIfPresent([String].self, forKey: .gaps)) ?? []
            checks = (try? c.decodeIfPresent([Check].self, forKey: .checks)) ?? []
        }

        enum CodingKeys: String, CodingKey { case claim, gaps, checks }
    }

    public struct Decision: Decodable, Equatable, Sendable {
        /// `CONFIRM` or `SEND_BACK`.
        public let decision: String
        public let note: String?
        public let decidedAt: String?
        /// `USER` or `AGENT`.
        public let decidedByType: String?

        public init(decision: String, note: String? = nil, decidedAt: String? = nil, decidedByType: String? = nil) {
            self.decision = decision
            self.note = note
            self.decidedAt = decidedAt
            self.decidedByType = decidedByType
        }
    }

    /// The version's number in the task's own order, as the server writes it ("1", "2", …).
    public let revision: String
    public let submittedAt: String?
    public let evidence: Envelope?
    public let decision: Decision?

    public var id: String { revision }

    public init(revision: String, submittedAt: String? = nil, evidence: Envelope? = nil, decision: Decision? = nil) {
        self.revision = revision
        self.submittedAt = submittedAt
        self.evidence = evidence
        self.decision = decision
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let text = try? c.decode(String.self, forKey: .revision) {
            revision = text
        } else if let number = try? c.decode(Int.self, forKey: .revision) {
            revision = String(number)
        } else {
            revision = "?"
        }
        submittedAt = try? c.decodeIfPresent(String.self, forKey: .submittedAt)
        evidence = try? c.decodeIfPresent(Envelope.self, forKey: .evidence)
        decision = try? c.decodeIfPresent(Decision.self, forKey: .decision)
    }

    enum CodingKeys: String, CodingKey { case revision, submittedAt, evidence, decision }
}

/// Where a run of the task last said it was (`task_progress_report`), as the task detail carries it
/// in `progress`. Revision 0 is a task that never reported. Lenient like the evidence above.
public struct TaskProgressView: Codable, Equatable, Sendable {
    public let phase: String?
    public let current: Int?
    public let total: Int?
    public let message: String?
    public let revision: Int
    public let lastProgressAt: String?

    public init(phase: String? = nil, current: Int? = nil, total: Int? = nil, message: String? = nil,
                revision: Int = 0, lastProgressAt: String? = nil) {
        self.phase = phase
        self.current = current
        self.total = total
        self.message = message
        self.revision = revision
        self.lastProgressAt = lastProgressAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        phase = try? c.decodeIfPresent(String.self, forKey: .phase)
        current = try? c.decodeIfPresent(Int.self, forKey: .current)
        total = try? c.decodeIfPresent(Int.self, forKey: .total)
        message = try? c.decodeIfPresent(String.self, forKey: .message)
        revision = (try? c.decodeIfPresent(Int.self, forKey: .revision)) ?? 0
        lastProgressAt = try? c.decodeIfPresent(String.self, forKey: .lastProgressAt)
    }

    enum CodingKeys: String, CodingKey { case phase, current, total, message, revision, lastProgressAt }
}
