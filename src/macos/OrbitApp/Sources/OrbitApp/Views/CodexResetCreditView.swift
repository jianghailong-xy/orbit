#if os(iOS)
import SwiftUI
import OrbitKit

/// The native iOS counterpart of the web Plan usage reset-credit card. It deliberately lives in
/// the shared source tree but is compiled only for iOS; macOS keeps its compact usage popover.
struct CodexResetCreditCard: View {
    let console: ConsoleModel
    @State private var confirmationPresented = false
    @State private var now = Date()

    private var countLabel: String {
        if let count = console.codexResetAvailableCount { return "\(count) available" }
        return "Count unavailable"
    }

    private var expiryLabel: String? {
        guard let summary = console.codexResetBlock?.rateLimitResetCredits,
              summary.availableCount > 0 else { return nil }
        guard let listed = summary.credits else { return "Expiry not reported" }
        let available = listed.filter { $0.status == "available" }
        let partial = available.count < summary.availableCount
        if let expiry = console.codexResetNextExpiry {
            let date = formatCodexResetDate(expiry)
            return partial
                ? "Earliest listed expires \(date) · partial list"
                : summary.availableCount > 1 ? "Next expires \(date)" : "Expires \(date)"
        }
        if available.isEmpty { return "Expiry not reported" }
        return partial ? "Listed credits don't expire · partial list" : "Doesn't expire"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "checkmark.shield")
                    .font(.title2)
                    .foregroundStyle(.tint)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Reset credit")
                        .font(.headline)
                        .foregroundStyle(.tint)
                    Text(countLabel)
                        .font(.title3.weight(.semibold))
                    if let expiryLabel {
                        Text(expiryLabel)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if let freshness = console.codexResetFreshnessText(now) {
                        Text(freshness)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.blue.opacity(0.10), in: RoundedRectangle(cornerRadius: 14))

            if let operation = console.codexResetOperation, operation.isActive {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(resetOperationProgress(operation))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else if let operation = console.codexResetOperation,
                      !operation.isActive,
                      operation.status != "" {
                Text(resetOperationResult(operation))
                    .font(.caption)
                    .foregroundStyle(operation.status == "SUCCEEDED" ? Color.green : Color.secondary)
            }

            if let reason = console.codexResetEligibilityReason,
               !console.codexResetEligible {
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let error = console.codexResetError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            Button {
                confirmationPresented = true
            } label: {
                HStack {
                    Spacer(minLength: 0)
                    if console.codexResetBusy {
                        ProgressView().tint(.white)
                    } else {
                        Text("Use reset credit")
                            .font(.body.weight(.semibold))
                    }
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 10)
            }
            .buttonStyle(.borderedProminent)
            .tint(.blue)
            .disabled(!console.codexResetEligible || console.codexResetBusy)
            .accessibilityLabel("Use reset credit")
            .orbitConfirmation("Use reset credit?", isPresented: $confirmationPresented) {
                Button("Use reset") {
                    Task { await console.useCodexReset() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This consumes 1 earned credit and resets eligible Codex usage windows. This action can't be undone. Your conversations and context aren't affected.")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: console.runnerID) {
            await console.loadCodexResetOperations()
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                if Task.isCancelled { break }
                now = Date()
                await console.loadCodexResetOperations()
            }
        }
        .accessibilityElement(children: .contain)
    }
}

private func resetOperationProgress(_ operation: CodexRateLimitResetOperation) -> String {
    switch operation.status {
    case "PENDING": return "Waiting for the runner…"
    case "CONSUMING": return "Using reset credit…"
    case "REFRESHING":
        return operation.consumeOutcome == "reset" || operation.consumeOutcome == "alreadyRedeemed"
            ? "Limits reset — refreshing usage…" : "Refreshing plan usage…"
    default: return "Reset in progress…"
    }
}

private func resetOperationResult(_ operation: CodexRateLimitResetOperation) -> String {
    switch operation.status {
    case "SUCCEEDED":
        return operation.consumeOutcome == "alreadyRedeemed"
            ? "Usage limits reset · credit was already used"
            : "Usage limits reset · 1 credit used"
    case "NOTHING_TO_RESET": return "Nothing to reset"
    case "NO_CREDIT": return "No reset credit was available"
    case "REFRESH_FAILED":
        return operation.consumeOutcome == "alreadyRedeemed"
            ? "Limits reset · credit was already used, usage not refreshed"
            : "Limits reset · 1 credit used, usage not refreshed"
    case "NOT_ATTEMPTED": return "The reset was not attempted"
    case "UNRESOLVED": return "Result unknown · a credit may have been used"
    default: return "Reset could not be completed"
    }
}

private func formatCodexResetDate(_ iso: String) -> String {
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date = parser.date(from: iso) ?? {
        parser.formatOptions = [.withInternetDateTime]
        return parser.date(from: iso)
    }()
    guard let date else { return iso }
    let formatter = DateFormatter()
    formatter.dateFormat = "MMM d, h:mm a"
    return formatter.string(from: date)
}
#endif
