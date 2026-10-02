import Foundation

/// Who re-sends the message a failure card's Retry offers to re-send
/// (docs/session-request-reply-contract.md §2.1, §8 criterion 15).
///
/// The reader's own words go through the console's own send, as anything typed there does. Another
/// Orbit session's words do not: sent that way they would go out again in the owner's name, signed by
/// nobody, and the request they were would stay behind on the turn that failed. The server re-sends
/// those the way the automatic retry does — as that session's, with its request, charged to nobody's
/// hourly limit (`APIClient.resendRetryMessage`).
///
/// Whose they are is read off the same bubble as the words, and off the server's answer
/// (`RetryMessage.sessionMessage`) only when the loaded window holds no bubble — the same precedence
/// the words themselves have (`ConsoleModel.retryMessageText`). Web parity: `retryFromSession` in
/// WorkspaceView.tsx.
public enum RetryRoute: Equatable, Sendable {
    /// Send these words through the console's own send.
    case send(String)
    /// Ask the server to re-send them as the session that sent them.
    case serverResend
    /// There is nothing to re-send.
    case nothing

    public static func of(loadedText: String, loadedSender: SessionMessage?,
                          serverText: String, serverSender: SessionMessage?) -> RetryRoute {
        if !loadedText.isEmpty { return loadedSender == nil ? .send(loadedText) : .serverResend }
        if serverText.isEmpty { return .nothing }
        return serverSender == nil ? .send(serverText) : .serverResend
    }
}
