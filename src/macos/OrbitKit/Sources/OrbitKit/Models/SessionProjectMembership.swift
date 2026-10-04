import Foundation

/// A session's project membership, derived from its coordinator, task, context, judgment or root
/// relation. Distinct from `Session.projectId`, which only names the project it coordinates.
public struct SessionProjectMembership: Codable, Equatable, Sendable {
    public enum Role: String, Codable, Sendable, CaseIterable {
        case coordinator = "COORDINATOR"
        case task = "TASK"
        case context = "CONTEXT"
        case judgment = "JUDGMENT"
        case child = "CHILD"
        case unknown = "UNKNOWN"

        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Role(rawValue: raw) ?? .unknown
        }
    }

    public let projectId: String
    public let projectTitle: String
    public let projectStatus: ProjectStatus
    public let role: Role

    public init(projectId: String, projectTitle: String, projectStatus: ProjectStatus,
                role: Role) {
        self.projectId = projectId
        self.projectTitle = projectTitle
        self.projectStatus = projectStatus
        self.role = role
    }
}
