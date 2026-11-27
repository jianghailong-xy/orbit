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

/// The blocks a page draws on its key, pool member and pool login rows (contract §4), and the press that
/// clears one. Built from the runners model, which reads `GET /account-health`.
struct AccountHealthRows {
    var blocks: [AccountHealthBlock] = []
    var checkAgain: (AccountHealthBlock) async -> String? = { _ in nil }

    init(blocks: [AccountHealthBlock] = [], checkAgain: @escaping (AccountHealthBlock) async -> String? = { _ in nil }) {
        self.blocks = blocks
        self.checkAgain = checkAgain
    }

    @MainActor init(_ runners: RunnersModel) {
        self.init(blocks: runners.healthBlocks, checkAgain: { await runners.checkAccountAgain($0) })
    }

    /// The row's line and Check again, drawn only while `block` stands.
    @ViewBuilder func row(_ block: AccountHealthBlock?, now: Date = Date()) -> some View {
        if let block {
            AccountHealthRow(block: block, now: now) { await checkAgain(block) }
        }
    }
}
