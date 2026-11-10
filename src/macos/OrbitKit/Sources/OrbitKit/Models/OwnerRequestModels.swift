import Foundation

/// What a session asked the account owner to do (apiserver `owner-requests`): the wire shapes, read
/// leniently so one field a newer server adds or an older one omits never costs the whole list.
/// The rules over them are `OwnerRequests` (App/OwnerRequests.swift); web parity: `lib/ownerRequests.ts`.
public enum OwnerRequestKind: String, Codable, Sendable, CaseIterable {
    case decision = "DECISION"
    case secret = "SECRET"
    case manualStep = "MANUAL_STEP"
    case confirm = "CONFIRM"
}

public enum OwnerRequestState: String, Codable, Sendable, CaseIterable {
    case pending = "PENDING"
    case done = "DONE"
    case declined = "DECLINED"
    case expired = "EXPIRED"
    case withdrawn = "WITHDRAWN"
}

public struct OwnerRequestOption: Codable, Equatable, Sendable {
    public let label: String
    public let description: String?
    public init(label: String, description: String? = nil) {
        self.label = label
        self.description = description
    }
}

public struct OwnerRequestStep: Codable, Equatable, Sendable {
    public let text: String
    public let command: String?
    public let link: String?
    public init(text: String, command: String? = nil, link: String? = nil) {
        self.text = text
        self.command = command
        self.link = link
    }
}

public struct OwnerRequestSecretSpec: Codable, Equatable, Sendable {
    public let name: String
    public let runnerId: String
    public let envVar: String?
    public let filePath: String?
    public init(name: String, runnerId: String, envVar: String? = nil, filePath: String? = nil) {
        self.name = name
        self.runnerId = runnerId
        self.envVar = envVar
        self.filePath = filePath
    }
}

/// Where the key a SECRET request delivered stands. Never the value or anything derived from it.
public struct OwnerRequestSecretGrant: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable {
        case pendingDelivery = "PENDING_DELIVERY"
        case active = "ACTIVE"
        case removing = "REMOVING"
        case removed = "REMOVED"
    }
    public let state: State
    public let endReason: String?
    public let exposure: String
    public let expiresAt: String
    public let deliveredAt: String?
    public let removedAt: String?
    public let removalNote: String?
    public let runnerOnline: Bool
    public let runnerLastSeenAt: String?

    public init(state: State, endReason: String? = nil, exposure: String = "ENV", expiresAt: String,
                deliveredAt: String? = nil, removedAt: String? = nil, removalNote: String? = nil,
                runnerOnline: Bool = true, runnerLastSeenAt: String? = nil) {
        self.state = state
        self.endReason = endReason
        self.exposure = exposure
        self.expiresAt = expiresAt
        self.deliveredAt = deliveredAt
        self.removedAt = removedAt
        self.removalNote = removalNote
        self.runnerOnline = runnerOnline
        self.runnerLastSeenAt = runnerLastSeenAt
    }
}

public struct OwnerRequestAnswer: Codable, Equatable, Sendable {
    public let option: Int?
    public let text: String?
    public init(option: Int? = nil, text: String? = nil) {
        self.option = option
        self.text = text
    }
}

public struct OwnerRequest: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: OwnerRequestKind
    public let state: OwnerRequestState
    public let title: String
    public let why: String
    public let blocksTaskIds: [String]
    public let ifUnanswered: String?
    public let options: [OwnerRequestOption]?
    public let recommendedOption: Int?
    public let steps: [OwnerRequestStep]?
    public let secretSpec: OwnerRequestSecretSpec?
    /// SECRET: what ends the key — `TASK` or `SESSION` (design §6.1).
    public let secretScope: String?
    public let secretGrant: OwnerRequestSecretGrant?
    public let verifyHint: String?
    public let expiresAt: String?
    public let askedBySessionId: String
    public let projectId: String?
    public let resolvedAt: String?
    public let resolvedByUserId: String?
    public let resolutionNote: String?
    public let answer: OwnerRequestAnswer?
    /// The client that ended it, from `X-Orbit-Client`, when the server serves it.
    public let resolvedClient: String?
    public let createdAt: String

    public init(id: String, kind: OwnerRequestKind, state: OwnerRequestState = .pending, title: String,
                why: String, blocksTaskIds: [String] = [], ifUnanswered: String? = nil,
                options: [OwnerRequestOption]? = nil, recommendedOption: Int? = nil,
                steps: [OwnerRequestStep]? = nil, secretSpec: OwnerRequestSecretSpec? = nil,
                secretScope: String? = nil, secretGrant: OwnerRequestSecretGrant? = nil,
                verifyHint: String? = nil, expiresAt: String? = nil, askedBySessionId: String,
                projectId: String? = nil, resolvedAt: String? = nil, resolvedByUserId: String? = nil,
                resolutionNote: String? = nil, answer: OwnerRequestAnswer? = nil,
                resolvedClient: String? = nil, createdAt: String) {
        self.id = id
        self.kind = kind
        self.state = state
        self.title = title
        self.why = why
        self.blocksTaskIds = blocksTaskIds
        self.ifUnanswered = ifUnanswered
        self.options = options
        self.recommendedOption = recommendedOption
        self.steps = steps
        self.secretSpec = secretSpec
        self.secretScope = secretScope
        self.secretGrant = secretGrant
        self.verifyHint = verifyHint
        self.expiresAt = expiresAt
        self.askedBySessionId = askedBySessionId
        self.projectId = projectId
        self.resolvedAt = resolvedAt
        self.resolvedByUserId = resolvedByUserId
        self.resolutionNote = resolutionNote
        self.answer = answer
        self.resolvedClient = resolvedClient
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, kind, state, title, why, blocksTaskIds, ifUnanswered, options, recommendedOption, steps
        case secretSpec, secretScope, secretGrant, verifyHint, expiresAt, askedBySessionId, projectId
        case resolvedAt, resolvedByUserId, resolutionNote, answer, resolvedClient, createdAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decode(OwnerRequestKind.self, forKey: .kind)
        state = try c.decode(OwnerRequestState.self, forKey: .state)
        title = try c.decode(String.self, forKey: .title)
        why = (try? c.decodeIfPresent(String.self, forKey: .why)) ?? ""
        blocksTaskIds = (try? c.decodeIfPresent([String].self, forKey: .blocksTaskIds)) ?? []
        ifUnanswered = try? c.decodeIfPresent(String.self, forKey: .ifUnanswered)
        options = try? c.decodeIfPresent([OwnerRequestOption].self, forKey: .options)
        recommendedOption = try? c.decodeIfPresent(Int.self, forKey: .recommendedOption)
        steps = try? c.decodeIfPresent([OwnerRequestStep].self, forKey: .steps)
        secretSpec = try? c.decodeIfPresent(OwnerRequestSecretSpec.self, forKey: .secretSpec)
        secretScope = try? c.decodeIfPresent(String.self, forKey: .secretScope)
        secretGrant = try? c.decodeIfPresent(OwnerRequestSecretGrant.self, forKey: .secretGrant)
        verifyHint = try? c.decodeIfPresent(String.self, forKey: .verifyHint)
        expiresAt = try? c.decodeIfPresent(String.self, forKey: .expiresAt)
        askedBySessionId = try c.decode(String.self, forKey: .askedBySessionId)
        projectId = try? c.decodeIfPresent(String.self, forKey: .projectId)
        resolvedAt = try? c.decodeIfPresent(String.self, forKey: .resolvedAt)
        resolvedByUserId = try? c.decodeIfPresent(String.self, forKey: .resolvedByUserId)
        resolutionNote = try? c.decodeIfPresent(String.self, forKey: .resolutionNote)
        answer = try? c.decodeIfPresent(OwnerRequestAnswer.self, forKey: .answer)
        resolvedClient = try? c.decodeIfPresent(String.self, forKey: .resolvedClient)
        createdAt = try c.decode(String.self, forKey: .createdAt)
    }
}

/// `GET /owner-requests?state=…`. A row this build cannot read is dropped, not the list.
public struct OwnerRequestList: Decodable, Sendable {
    public let requests: [OwnerRequest]

    public init(requests: [OwnerRequest]) { self.requests = requests }

    private enum CodingKeys: String, CodingKey { case requests }
    private struct Lenient: Decodable {
        let value: OwnerRequest?
        init(from decoder: Decoder) throws { value = try? OwnerRequest(from: decoder) }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requests = try c.decode([Lenient].self, forKey: .requests).compactMap(\.value)
    }
}

/// A saved account secret, by label only: no route returns a value.
public struct AccountSecret: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public init(id: String, label: String) {
        self.id = id
        self.label = label
    }
}

public struct AccountSecretList: Decodable, Sendable {
    public let secrets: [AccountSecret]
}

/// `POST /owner-requests/:id/done`. A DECISION needs an option or words; the other kinds send nothing.
public struct OwnerRequestDoneBody: Encodable, Equatable, Sendable {
    public let option: Int?
    public let text: String?
    public init(option: Int? = nil, text: String? = nil) {
        self.option = option
        self.text = text
    }
}

/// `POST /owner-requests/:id/decline`. The reason is required: the asking session acts on it.
public struct OwnerRequestDeclineBody: Encodable, Equatable, Sendable {
    public let reason: String
    public init(reason: String) { self.reason = reason }
}

/// `POST /owner-requests/:id/secret`: the key, optionally saved under a label, or a saved secret's id.
/// Built at the press and handed straight to the request: never stored, logged or put in a URL.
public enum OwnerRequestSecretBody: Encodable, Sendable {
    case value(String, saveAs: String?)
    case saved(id: String)

    private enum CodingKeys: String, CodingKey { case value, saveAs, savedSecretId }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .value(value, saveAs):
            try c.encode(value, forKey: .value)
            try c.encodeIfPresent(saveAs, forKey: .saveAs)
        case let .saved(id):
            try c.encode(id, forKey: .savedSecretId)
        }
    }
}
