package io.orbitd.android.core.protocol

import kotlinx.serialization.Serializable

@Serializable
data class User(val id: String, val email: String, val name: String, val role: String? = null)

@Serializable
data class LoginRequest(val email: String, val password: String) {
    override fun toString() = "LoginRequest([redacted])"
}

@Serializable
data class RefreshRequest(val refreshToken: String) {
    override fun toString() = "RefreshRequest([redacted])"
}

@Serializable
data class LoginResponse(val accessToken: String, val refreshToken: String, val user: User) {
    init {
        require(accessToken.isNotBlank() && refreshToken.isNotBlank() && user.id.isNotBlank())
        require(accessToken.all { it.code in 33..126 } && refreshToken.all { it.code in 33..126 })
    }
    override fun toString() = "LoginResponse([redacted])"
}
