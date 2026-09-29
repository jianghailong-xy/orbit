import Foundation

// Auth + admin-area DTOs mirroring auth.controller (change-password) and admin.controller (user
// management). The user list reuses `User` (its createdAt/preferences are optional, so the admin
// `{id,email,name,role,createdAt}` shape decodes fine).

/// POST /auth/change-password
public struct ChangePasswordRequest: Encodable, Sendable {
    public let currentPassword: String
    public let newPassword: String
    public init(currentPassword: String, newPassword: String) {
        self.currentPassword = currentPassword
        self.newPassword = newPassword
    }
}

/// PATCH /users/me — the account's own name, the one thing on it its owner changes themselves.
public struct UpdateProfileRequest: Encodable, Sendable {
    public let name: String
    public init(name: String) { self.name = name }
}

/// POST /admin/users — create, or reset an existing user's password (`force`).
public struct CreateUserRequest: Encodable, Sendable {
    public let email: String
    public let name: String?
    /// Omit to have a strong password generated and returned once.
    public let password: String?
    /// Reset the password of an existing user instead of failing on conflict.
    public let force: Bool?
    public init(email: String, name: String? = nil, password: String? = nil, force: Bool? = nil) {
        self.email = email
        self.name = name
        self.password = password
        self.force = force
    }
}

/// Result of creating/resetting a user. `password` is present once when the server generated one.
public struct CreateUserResult: Codable, Equatable, Sendable {
    public let id: String?
    public let email: String?
    public let name: String?
    public let role: String?
    public let password: String?
}

/// PATCH /admin/users/:id/role
public struct UpdateRoleRequest: Encodable, Sendable {
    public let role: String   // "MEMBER" | "ADMIN"
    public init(role: String) { self.role = role }
}
