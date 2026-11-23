import SwiftUI
import OrbitKit

/// An account Orbit has stopped routing to: why, since when, when it is tried again, and Check again
/// (docs/routing-account-health-design.md §8 item 2). Drawn only while a block stands.
struct AccountHealthRow: View {
    let block: AccountHealthBlock
    let now: Date
    let checkAgain: () async -> String?

    @State private var checking = false
    @State private var failure: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(AccountHealth.line(block, now: now))
                .font(.orbitLabel)
                .foregroundStyle(AccountHealth.isClassified(block) ? Color.orange : Color.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("account-health-line")
            Button {
                checking = true
                failure = nil
                Task {
                    failure = await checkAgain()
                    checking = false
                }
            } label: { Text(checking ? "Checking…" : AccountHealth.checkAgainTitle) }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
                .disabled(checking)
                .accessibilityIdentifier("account-health-check-again")
            if let failure {
                Text(failure).font(.orbitLabel).foregroundStyle(Color.red)
            }
        }
    }
}
