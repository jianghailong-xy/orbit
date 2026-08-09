import Foundation
import Observation
import OrbitKit

/// Drives one engine's sign-in on one runner, from this app, without a terminal on that machine.
///
/// The runner runs the CLI's sign-in on its own box and reports back what the user has to do. The
/// engines get there differently, which is why the card this backs has two shapes:
///
///  - claude: the CLI prints a URL whose redirect_uri is Anthropic-hosted, so the user approves it
///    in a browser and the callback page shows a code to paste back here. What travels through
///    Orbit is a single-use authorization code, useless without the PKCE verifier that never leaves
///    the runner process.
///  - codex/kimi: their device flows print a URL *and* a one-time code to enter on that page; the
///    CLI then polls for the approval itself, so there is nothing to paste back — we just wait.
///
/// Either way the URL is slow to arrive: the runner is told to start signing in on its next
/// heartbeat, half a minute off at worst, and only then does the CLI print anything. So every step
/// is polled rather than awaited, and every wait says so.
@MainActor
@Observable
final class RunnerSignInModel {
    let runnerID: String
    let engine: LoginEngine

    /// Last state read back from the relay. Nil until the first read lands.
    private(set) var relay: RunnerLoginState?
    /// A start/submit/cancel is in flight — the buttons are disabled while it is.
    private(set) var busy = false
    /// Set while a pasted code is on its way to the runner — see `verifying`.
    private(set) var submitting = false
    /// Whatever the last request failed with, shown above the buttons.
    private(set) var errorText: String?
    /// The authorization code the user pastes back (claude's flow).
    var code = ""
    /// Set once a code has been handed over and this card is waiting on the outcome.
    private var sent = false
    /// Set once this card has seen a sign-in actually running — see `status`.
    private var watched = false

    private let api: APIClient
    private var poll: Task<Void, Never>?

    /// How often the relay is re-read while something is in flight. The runner picks work up on its
    /// heartbeat and reports on the next one, so this is about noticing promptly, not about speed.
    private static let pollNanos: UInt64 = 2_000_000_000

    init(runnerID: String, engine: LoginEngine, baseURL: URL, tokenStore: TokenStore) {
        self.runnerID = runnerID
        self.engine = engine
        self.api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
    }

    // MARK: what the card renders

    /// A runner runs one relay at a time. If the one in flight is for the other engine (another
    /// card, another device), this card has nothing to report — it reads as idle, so pressing its
    /// button takes the relay over.
    private var mine: Bool { relay?.engine == nil || relay?.engine == engine.rawValue }

    /// The status this card may speak for.
    ///
    /// done/failed stay on the runner until the *next* sign-in starts, so they describe the last
    /// attempt rather than whether that machine's credentials are good now. A card raised by a later
    /// failure would otherwise open on "Signed in — this runner is ready" left over from a sign-in
    /// that has since expired — the one thing it must never claim while the engine is signed out.
    /// So an outcome counts only if this card watched the sign-in that produced it; one already
    /// finished when the card appears is history, and the card opens on its button instead.
    var status: RunnerLoginStatus? {
        let reported = mine ? relay?.status : nil
        if watched || reported?.inFlight == true { return reported }
        return nil
    }

    /// Submitting a code only parks it for the runner's next heartbeat — thirty seconds away at
    /// worst — and the CLI still has to exchange it after that. So the POST returning means nothing
    /// has happened yet, and stopping there would drop the user back on an empty form with no sign
    /// their code went anywhere. Hold the wait until the polled state moves: to done/failed, or back
    /// to awaiting_code carrying the CLI's rejection (submitting clears that message server-side, so
    /// a message here can only be news about this paste).
    var verifying: Bool {
        submitting || (sent && status == .awaitingCode && relay?.message == nil)
    }

    /// The sign-in page to open in a browser, once the CLI has printed one.
    var url: URL? { mine ? relay?.url.flatMap(URL.init(string:)) : nil }
    /// The one-time code to type on that page (device flow only).
    var userCode: String? { mine ? relay?.userCode : nil }
    /// The runner's own last word — a rejected code, or why an attempt failed.
    var relayMessage: String? { mine ? relay?.message : nil }

    // MARK: actions

    /// Read the relay once, when the card appears: a sign-in already under way (started from
    /// another device, or before this console was opened) is then picked up and followed, rather
    /// than the card offering a button that would preempt it.
    func refresh() async {
        guard let next = try? await api.runnerLoginState(runnerID) else { return }
        adopt(next)
    }

    func begin() async {
        errorText = nil
        busy = true
        defer { busy = false }
        do { adopt(try await api.startRunnerLogin(runnerID, engine: engine)) }
        catch { errorText = friendly(error) }
    }

    func submitCode() async {
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        errorText = nil
        busy = true
        submitting = true
        defer { busy = false; submitting = false }
        do {
            sent = true
            adopt(try await api.submitRunnerLoginCode(runnerID, code: trimmed))
            code = ""
        } catch {
            sent = false
            errorText = friendly(error)
        }
    }

    func cancel() async {
        errorText = nil
        busy = true
        defer { busy = false }
        do { adopt(try await api.cancelRunnerLogin(runnerID)) }
        catch { errorText = friendly(error) }
    }

    /// Stop polling when the card goes away; the `refresh()` on its next appearance picks the relay
    /// back up where it left off (the state lives on the runner's row, not here).
    func stop() {
        poll?.cancel()
        poll = nil
    }

    // MARK: internals

    private func adopt(_ next: RunnerLoginState) {
        relay = next
        if next.status?.inFlight == true, mine { watched = true }
        // Anything but awaiting_code — cancelled, restarted, finished — settles a pending paste.
        if status != .awaitingCode { sent = false }
        if next.status?.inFlight == true { startPolling() }
    }

    /// Poll only while something is in flight; an idle or settled relay moves only when this card
    /// moves it (web parity — its query stops refetching the moment the relay settles).
    private func startPolling() {
        guard poll == nil else { return }
        poll = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: RunnerSignInModel.pollNanos)
                guard let self, !Task.isCancelled else { return }
                // A failed read is a blip on the way to the same relay — keep waiting on it.
                guard let next = try? await self.api.runnerLoginState(self.runnerID) else { continue }
                self.adopt(next)
                if next.status?.inFlight != true { break }
            }
            // A cancelled loop has already had its handle dropped by `stop()`, and something newer
            // may hold it by now; only a loop that ran to its own end clears it.
            if !Task.isCancelled { self?.poll = nil }
        }
    }

    private func friendly(_ error: Error) -> String {
        if case APIError.unauthorized = error { return "Session expired — sign in to Orbit again." }
        return "Request failed — check your connection."
    }
}
