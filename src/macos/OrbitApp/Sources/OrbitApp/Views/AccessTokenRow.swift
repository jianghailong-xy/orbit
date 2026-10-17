import SwiftUI
import OrbitKit

/// One personal access token as Settings lists it — on the iOS page and in the macOS form alike:
/// the web table's columns as lines. Its name and the end of the token, what it can reach, when it
/// stops working (one that never does is marked, as the web marks it), and when and from where it
/// was last used. Never the token itself: Orbit does not keep it. The words are `AccessTokensList`'s.
struct AccessTokenRow: View {
    let token: AccessToken
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(token.name)
                    .lineLimit(2)
                Spacer(minLength: 8)
                Text(AccessTokensList.hint(token))
                    .font(.orbitMono)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .layoutPriority(1)
            }
            line(AccessTokensList.accessLine(token))
            if AccessTokensList.isNeverExpiring(token) {
                Text(AccessTokensList.neverExpires)
                    .font(.orbitLabel.weight(.semibold))
                    .foregroundStyle(Color.orange)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(Color.orange.opacity(0.14), in: Capsule())
            } else {
                line(AccessTokensList.expiryLine(token, now: now))
            }
            line(AccessTokensList.lastUsedLine(token, now: now))
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private func line(_ text: String) -> some View {
        Text(text)
            .font(.orbitListSubtitle)
            .foregroundStyle(.secondary)
    }
}
