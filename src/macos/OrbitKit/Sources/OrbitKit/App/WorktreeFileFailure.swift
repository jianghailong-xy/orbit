import Foundation

/// The actions a current-worktree file failure can actually offer. A deleted file has no current
/// bytes; a transient runner/network failure can be retried without reopening the diff sheet.
public struct WorktreeFileFailure: Equatable, Sendable {
    public let title: String
    public let detail: String
    public let canRetry: Bool

    public static let deleted = WorktreeFileFailure(
        title: "File deleted", detail: "This file is no longer in the current worktree.", canRetry: false)

    public static let invalidImage = WorktreeFileFailure(
        title: "Couldn't preview image",
        detail: "The image may be incomplete or damaged. Try reading the file again.", canRetry: true)

    public static func from(_ error: Error) -> WorktreeFileFailure {
        if case APIError.http(let status, _) = error {
            switch status {
            case 404:
                return .init(title: "File not found",
                             detail: "The file may have moved or been removed from the current worktree.", canRetry: true)
            case 413:
                return .init(title: "File too large",
                             detail: "This file exceeds the download limit. Open it on the runner instead.", canRetry: false)
            case 503:
                return .init(title: "Runner unavailable",
                             detail: "The runner is offline or cannot read this file right now. Try again when it is connected.", canRetry: true)
            case 504:
                return timedOut
            case 400, 403:
                return .init(title: "File unavailable", detail: APIClient.failureReason(error), canRetry: false)
            default:
                break
            }
        }
        if (error as? URLError)?.code == .timedOut { return timedOut }
        return .init(title: "Couldn't load file", detail: APIClient.failureReason(error), canRetry: true)
    }

    private static let timedOut = WorktreeFileFailure(
        title: "File request timed out", detail: "The runner did not return this file in time. Try again.", canRetry: true)
}
