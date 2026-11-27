import SwiftUI
import OrbitKit

/// Set as default chrome drawn by `RunnerEnginePage`, and by `SetDefaultShotsTests` through
/// ImageRenderer — the same views, fed a fixture `Runner`.
enum RunnerEngineSetDefaultViews {

    /// Web's DEFAULT chip: a Default renamed in Orbit (or promoted by Set as default while keeping its name).
    static let defaultChip = "DEFAULT"

    /// The Set as default item in an account's long-press menu: its name, and what it does or why not.
    struct MenuItemLabel: View {
        let blocked: String?

        var body: some View {
            VStack(alignment: .leading, spacing: 2) {
                Text(RunnerAccountCopy.RUNNER_ACCOUNT_SET_DEFAULT)
                Text(blocked ?? RunnerAccountCopy.RUNNER_ACCOUNT_SET_DEFAULT_HINT)
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// The confirmation's title, body and Make default / Cancel — what `.orbitConfirmation` asks.
    struct Confirm: View {
        let question: RunnerPageFormat.RemovalQuestion
        var confirm = RunnerAccountCopy.RUNNER_ACCOUNT_SET_DEFAULT_CONFIRM

        var body: some View {
            VStack(spacing: 14) {
                Text(question.title)
                    .font(.headline)
                    .multilineTextAlignment(.center)
                Text(question.message)
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                HStack(spacing: 0) {
                    Text("Cancel")
                        .frame(maxWidth: .infinity)
                        .foregroundStyle(Color.accentColor)
                    Divider().frame(height: 36)
                    Text(confirm)
                        .fontWeight(.semibold)
                        .frame(maxWidth: .infinity)
                        .foregroundStyle(Color.accentColor)
                }
                .font(.body)
            }
            .padding(18)
            .frame(width: 360)
            .background(.background, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
    }

    /// Under an account while a swap waits, fails, or — with nothing left — once it is done.
    struct SwapStatus: View {
        let runner: Runner
        let line: RunnerPageFormat.AccountLine

        var body: some View {
            VStack(alignment: .leading, spacing: 2) {
                if let setting = RunnerPageFormat.settingDefaultLine(runner, line: line) {
                    Text(setting)
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                }
                if let failed = RunnerPageFormat.failedSwap(runner, line: line) {
                    Text(RunnerAccountCopy.runnerAccountSetDefaultFailed(name: line.name))
                        .font(.orbitLabel)
                        .foregroundStyle(RunnerInk.red)
                    if let message = failed.message, !message.isEmpty {
                        Text(message)
                            .font(.orbitLabel)
                            .foregroundStyle(RunnerInk.red)
                    }
                    Text(RunnerAccountCopy.RUNNER_ACCOUNT_SET_DEFAULT_UNCHANGED)
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    /// One account's head on the engine page: name, DEFAULT / NEXT chips, directory, sign-in status.
    struct AccountHead: View {
        let line: RunnerPageFormat.AccountLine
        var next = false
        var status: String? = nil
        var statusTone: RunnerPageFormat.Tone = .ok

        var body: some View {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        Text(line.name).font(.headline)
                        if line.isDefault && line.name != "Default" {
                            PoolChip(text: RunnerEngineSetDefaultViews.defaultChip)
                        }
                        if next { PoolChip(text: SharedPoolPage.nextChip) }
                    }
                    if let subtitle = line.subtitle {
                        Text(subtitle)
                            .font(.orbitLabel)
                            .foregroundStyle(Color.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                Spacer(minLength: 8)
                if let status {
                    Text(status)
                        .font(.orbitListSubtitle)
                        .foregroundStyle(RunnerInk.status(statusTone))
                }
            }
        }
    }

    /// The engine-page account row as Set as default shots draw it: head + swap status.
    struct AccountRow: View {
        let runner: Runner
        let line: RunnerPageFormat.AccountLine
        var next = false

        var body: some View {
            VStack(alignment: .leading, spacing: 10) {
                AccountHead(line: line, next: next,
                            status: RunnerPageFormat.authStatus(line.auth)?.text,
                            statusTone: RunnerPageFormat.authStatus(line.auth)?.tone ?? .muted)
                SwapStatus(runner: runner, line: line)
            }
            .padding(.vertical, 4)
        }
    }

    /// An added account's menu as the long-press draws it, with Set as default and its hint open.
    struct MenuPanel: View {
        let blocked: String?

        var body: some View {
            VStack(alignment: .leading, spacing: 0) {
                menuRow("Rename…")
                menuRow("Sign In Again")
                menuRow("Pause…")
                MenuItemLabel(blocked: blocked)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Divider()
                Text("Remove…")
                    .foregroundStyle(RunnerInk.red)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
            }
            .frame(width: 280)
            .background(.background, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .shadow(color: .black.opacity(0.18), radius: 14, y: 6)
        }

        private func menuRow(_ title: String) -> some View {
            Text(title)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
