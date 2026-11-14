import Foundation
import Observation

/// A session's Settings sheet (docs/mocks/session-settings native.html ①–④): Session, Environment,
/// Notifications and Info, opened from the session's ⋯ menu. Nothing the composer already offers
/// (model, permission mode, effort, fast mode, provider) is here. Every change saves at once.
///
/// This file is the part of it that runs on Linux: the words, the Compact at sizes, the variable
/// rows, the restart banner, the Info rows, and `SessionSettingsModel`, which reads and writes.
public enum SessionSettingsPanel {
    // MARK: words

    public static let title = "Session Settings"
    public static let menuItem = "Settings…"
    public static let done = "Done"

    public static let sessionGroup = "Session"
    public static let labels = "Labels"
    public static let addLabel = "Add"
    public static let publicLink = "Public link"
    public static let publicLinkLive = "Live · anyone with the link can read it"
    public static let publicLinkOff = "Only you can open this session"
    public static let copy = "Copy"
    public static let linkCopied = "Link copied"
    public static let turnOffTitle = "Turn off the public link?"
    public static let turnOffMessage = "The link stops working at once. Turning it on again makes a new link."
    public static let turnOff = "Turn Off"

    public static let environmentGroup = "Environment"
    public static let environmentNote = "Applies when the engine next starts"
    public static let workingDirectory = "Working directory"
    public static let compactAt = "Compact at"
    public static let variables = "Variables"

    public static let notificationsGroup = "Notifications"
    /// There is no web browser push: the overrides reach the phone apps' pushes only.
    public static let notificationsNote = "iOS and Android"
    public static let whenTurnFinishes = "When a turn finishes"
    public static let whenItNeedsYou = "When it needs you"
    public static let mute = "Mute this session"
    public static let muteNote = "No notifications at all, until you turn this off"

    public static let infoGroup = "Info"
    public static let engine = "Engine"
    public static let runner = "Runner"
    public static let account = "Account"
    public static let branch = "Branch"
    public static let created = "Created"
    public static let tokens = "Tokens"
    public static let cost = "Cost"
    public static let sessionID = "Session ID"
    public static let engineSession = "Engine session"
    #if os(macOS)
    public static let copyHint = "Right-click an ID to copy it."
    #else
    public static let copyHint = "Touch and hold an ID to copy it."
    #endif
    public static let copyID = "Copy"
    public static let idCopied = "Copied"

    // The Variables page (③).
    public static let variablesBack = "Settings"
    public static let addVariable = "Add"
    public static let thisSession = "This session"
    public static let fromWorkspace = "From the workspace"
    public static let noSessionVariables = "No variables of this session's own."
    public static let replacedByThisSession = "Replaced by this session's"
    #if os(macOS)
    public static let variablesFootnote = "A session variable with the same name replaces the workspace's."
    #else
    public static let variablesFootnote = "A session variable with the same name replaces the workspace's. Swipe left to delete."
    #endif
    public static let newVariable = "New Variable"
    public static let editVariable = "Edit Variable"
    public static let name = "Name"
    public static let value = "Value"
    public static let save = "Save"
    public static let cancel = "Cancel"
    public static let delete = "Delete"

    // MARK: Compact at — a session value of Claude Code's own variable (web AutoCompactSelect)

    public static let autoCompactVariable = "CLAUDE_CODE_AUTO_COMPACT_WINDOW"
    public static let compactDefault = "default"

    public struct CompactOption: Equatable, Sendable, Identifiable {
        public let value: String
        public let label: String
        public var id: String { value }
    }

    public static let compactSizes: [CompactOption] = [
        CompactOption(value: compactDefault, label: "Default"),
        CompactOption(value: "700000", label: "700K tokens"),
        CompactOption(value: "500000", label: "500K tokens"),
        CompactOption(value: "300000", label: "300K tokens"),
    ]

    /// What the session compacts at: its own value, else Default. The workspace's value is not the
    /// session's choice, so Default here means "as the workspace says".
    public static func compactValue(_ env: [String: String]) -> String {
        let v = env[autoCompactVariable]?.trimmingCharacters(in: .whitespaces) ?? ""
        return v.isEmpty ? compactDefault : v
    }

    /// The sizes offered, with a size typed as a variable kept as an option of its own.
    public static func compactOptions(current: String) -> [CompactOption] {
        compactSizes.contains { $0.value == current }
            ? compactSizes : compactSizes + [CompactOption(value: current, label: "\(current) tokens")]
    }

    /// The session's variables with this size in place, or without the variable for Default.
    public static func env(_ env: [String: String], compactAt size: String) -> [String: String] {
        var out = env
        if size == compactDefault { out[autoCompactVariable] = nil } else { out[autoCompactVariable] = size }
        return out
    }

    // MARK: notifications

    public static func notifyLabel(_ value: SessionNotifyOverride) -> String {
        switch value {
        case .inherit: return "As in Settings"
        case .on: return "Notify"
        case .off: return "Don't notify"
        }
    }

    // MARK: variables (③)

    public struct VariableRow: Equatable, Sendable, Identifiable {
        public let key: String
        public let value: String
        /// A workspace variable a session one of the same name replaces.
        public let replaced: Bool
        public var id: String { key }
    }

    public static func sessionRows(_ settings: SessionSettingsValues) -> [VariableRow] {
        settings.env.keys.sorted().map { VariableRow(key: $0, value: settings.env[$0] ?? "", replaced: false) }
    }

    public static func workspaceRows(_ settings: SessionSettingsValues) -> [VariableRow] {
        settings.workspaceEnv.keys.sorted().map {
            VariableRow(key: $0, value: settings.workspaceEnv[$0] ?? "", replaced: settings.env[$0] != nil)
        }
    }

    /// The Variables row's trailing count: the session's own variables.
    public static func variablesCount(_ settings: SessionSettingsValues) -> String { "\(settings.env.count)" }

    /// Why a name can't be saved, in the server's own rule (`SESSION_ENV_KEY`, no `ORBIT_`), or nil.
    public static func nameProblem(_ raw: String) -> String? {
        let name = raw.trimmingCharacters(in: .whitespaces)
        if name.isEmpty { return "Give the variable a name." }
        let valid = name.range(of: "^[A-Za-z_][A-Za-z0-9_]*$", options: .regularExpression) != nil
        if !valid { return "Use letters, digits and _, not starting with a digit." }
        if name.uppercased().hasPrefix("ORBIT_") { return "ORBIT_ variables are set by Orbit." }
        return nil
    }

    // MARK: the restart banner (③)

    public struct RestartBanner: Equatable, Sendable {
        public let title: String
        public let body: String
        /// Nil once the restart is queued: there is nothing more to press.
        public let button: String?
    }

    /// The banner while the engine owes a restart: a turn running waits for it to end; an idle engine
    /// restarts now; an ended engine shows none — the next message starts with the new variables.
    /// `changedKeys` are the variables changed in this sheet, named when there is exactly one.
    public static func restartBanner(pending: Bool, turnRunning: Bool, queued: SessionRestartResponse?,
                                     changedKeys: Set<String> = []) -> RestartBanner? {
        if let queued {
            return RestartBanner(
                title: "The engine restarts with the new variables.",
                body: queued.afterTurn
                    ? "Orbit restarts it when this turn ends. The conversation is kept."
                    : "Orbit is restarting it now. The conversation is kept.",
                button: nil)
        }
        guard pending else { return nil }
        let title = changedKeys.count == 1
            ? "\(changedKeys.first!) is waiting for the engine to restart."
            : "The new variables are waiting for the engine to restart."
        if turnRunning {
            return RestartBanner(
                title: title,
                body: "A turn is running. Orbit restarts the engine with the new variables when it ends. The conversation is kept.",
                button: "Restart after this turn")
        }
        return RestartBanner(
            title: title,
            body: "Orbit restarts the engine with the new variables. The conversation is kept.",
            button: "Restart")
    }

    // MARK: Info (④)

    /// `1.82M`, `108K`, `9.5K`, `640`.
    public static func tokenCount(_ n: Int) -> String {
        func trimmed(_ v: Double, _ digits: Int) -> String {
            var s = String(format: "%.\(digits)f", v)
            while s.contains("."), s.hasSuffix("0") { s.removeLast() }
            if s.hasSuffix(".") { s.removeLast() }
            return s
        }
        if n >= 1_000_000 { return trimmed(Double(n) / 1_000_000, 2) + "M" }
        if n >= 10_000 { return "\(Int((Double(n) / 1000).rounded()))K" }
        if n >= 1000 { return trimmed(Double(n) / 1000, 1) + "K" }
        return "\(n)"
    }

    /// Input plus output: the cache is reported beside it, as the board's `1.82M` over
    /// `in 1.71M · out 108K · cache 1.52M`.
    public static func tokensTotal(_ u: SessionUsage) -> String { tokenCount(u.inputTokens + u.outputTokens) }

    public static func tokensSplit(_ u: SessionUsage) -> String {
        "in \(tokenCount(u.inputTokens)) · out \(tokenCount(u.outputTokens)) · cache \(tokenCount(u.cacheReadTokens + u.cacheCreationTokens))"
    }

    public static func cost(_ u: SessionUsage) -> String { String(format: "$%.2f", u.costUsd) }

    public static func turns(_ u: SessionUsage) -> String { u.numTurns == 1 ? "1 turn" : "\(u.numTurns) turns" }

    /// `Claude Code 2.4.1`, or the engine's name alone when the runner reports no version.
    public static func engineLabel(_ engine: String?, version: String?) -> String? {
        guard let engine, !engine.isEmpty else { return nil }
        let name = ProviderEngines.cliName(engine)
        guard let version = version?.trimmingCharacters(in: .whitespaces), !version.isEmpty else { return name }
        // A CLI's `--version` may already lead with its own name ("2.4.1 (Claude Code)"): keep the number.
        let number = version.split(separator: " ").first.map(String.init) ?? version
        return "\(name) \(number)"
    }

    /// The account the session runs on: an engine's own sign-in named as the runner names it
    /// (`Claude Code · Max`), or a Codex pool's ChatGPT account. Nil when it runs on a key or pool
    /// the panel can't name.
    public static func accountLabel(engine: String?, provider: String?, accountID: String?,
                                    accounts: [RunnerEngineAccount]?, poolLogin: String?) -> String? {
        if let poolLogin, !poolLogin.isEmpty { return poolLogin }
        guard let engine, !engine.isEmpty,
              provider == nil || ProviderEngines.isLoginProvider(provider) else { return nil }
        let id = (accountID?.isEmpty == false ? accountID : nil) ?? CodexAccounts.defaultID
        return "\(ProviderEngines.cliName(engine)) · \(CodexAccounts.label(id, accounts: accounts))"
    }

    /// `Sep 28, 20:00`.
    public static func created(_ iso: String?, timeZone: TimeZone = .current) -> String? {
        guard let iso, let date = RelativeTime.parse(iso) else { return nil }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = timeZone
        f.dateFormat = "MMM d, HH:mm"
        return f.string(from: date)
    }

    /// An ID's tail, as the board shows it: `…ac2e648c946c`.
    public static func shortID(_ id: String, keep: Int = 12) -> String {
        id.count <= keep ? id : "…" + id.suffix(keep)
    }

    /// The working directory's tail: `…/01a1c927…`-style, the last path component behind an ellipsis.
    public static func shortPath(_ path: String) -> String {
        let parts = path.split(separator: "/")
        guard parts.count > 1, let last = parts.last else { return path }
        return "…/" + last
    }
}

/// What the Settings sheet reads and writes through: `APIClient` in the app, a fake in tests.
public protocol SessionSettingsAPI: Sendable {
    func sessionSettingsDetail(_ id: String) async throws -> SessionSettingsDetail
    func patchSessionSettings(_ id: String, _ patch: SessionSettingsPatch) async throws -> SessionSettingsValues
    func restartSession(_ id: String) async throws -> SessionRestartResponse
    func shareLink(_ kind: ShareRootKind, _ id: String) async throws -> ShareLinkRead
    func putShareLink(_ kind: ShareRootKind, _ id: String, _ body: PutShareLinkRequest) async throws -> ShareLink
    func turnOffShareLink(_ kind: ShareRootKind, _ id: String) async throws
}

extension APIClient: SessionSettingsAPI {}

/// The sheet's state: one read of the session detail and its public link, then a write per change.
/// A change shows at once and is put back, with the server's reason, if the server refuses it.
@available(macOS 14.0, *)
@MainActor
@Observable
public final class SessionSettingsModel {
    public let sessionID: String
    @ObservationIgnored private let api: SessionSettingsAPI

    public private(set) var detail: SessionSettingsDetail?
    public private(set) var settings: SessionSettingsValues?
    public private(set) var shareLink: ShareLink?
    public private(set) var loading = false
    public private(set) var loadError: String?
    /// The last write the server refused, with its reason.
    public var saveError: String?
    /// The restart this sheet asked for, once the server queued it.
    public private(set) var restartQueued: SessionRestartResponse?
    public private(set) var restarting = false
    /// Variables changed while the sheet is open, which the restart banner names.
    public private(set) var changedKeys: Set<String> = []
    /// Set by the sheet from the session row: a turn is in flight.
    public var turnRunning = false

    public init(sessionID: String, api: SessionSettingsAPI, detail: SessionSettingsDetail? = nil,
                shareLink: ShareLink? = nil) {
        self.sessionID = sessionID
        self.api = api
        self.detail = detail
        self.settings = detail?.settings
        self.shareLink = shareLink
    }

    // MARK: reads

    public func load() async {
        loading = true
        defer { loading = false }
        do {
            let read = try await api.sessionSettingsDetail(sessionID)
            detail = read
            settings = read.settings ?? settings
            loadError = read.settings == nil ? "This server doesn't offer session settings yet." : nil
        } catch {
            loadError = APIClient.failureReason(error)
        }
        if let read = try? await api.shareLink(.session, sessionID) { shareLink = read.link }
    }

    public var publicLinkOn: Bool { shareLink.map { $0.state == .active } ?? false }

    public var compactAt: String { SessionSettingsPanel.compactValue(settings?.env ?? [:]) }

    public var restartBanner: SessionSettingsPanel.RestartBanner? {
        SessionSettingsPanel.restartBanner(pending: settings?.envPendingRestart ?? false, turnRunning: turnRunning,
                                           queued: restartQueued, changedKeys: changedKeys)
    }

    // MARK: writes — each one at once

    public func setNotifyTurnFinished(_ value: SessionNotifyOverride) async {
        await write(SessionSettingsPatch(notifyTurnFinished: value)) { $0.notifyTurnFinished = value }
    }

    public func setNotifyNeedsYou(_ value: SessionNotifyOverride) async {
        await write(SessionSettingsPatch(notifyNeedsYou: value)) { $0.notifyNeedsYou = value }
    }

    public func setMuted(_ value: Bool) async {
        await write(SessionSettingsPatch(muted: value)) { $0.muted = value }
    }

    public func setCompactAt(_ size: String) async {
        guard let env = settings?.env else { return }
        await writeEnv(SessionSettingsPanel.env(env, compactAt: size), changed: SessionSettingsPanel.autoCompactVariable)
    }

    /// Adds or changes one of the session's variables; renaming one drops the old name.
    public func setVariable(_ key: String, value: String, replacing old: String? = nil) async {
        guard var env = settings?.env else { return }
        let key = key.trimmingCharacters(in: .whitespaces)
        if let old, old != key { env[old] = nil }
        env[key] = value
        await writeEnv(env, changed: key)
    }

    public func removeVariable(_ key: String) async {
        guard var env = settings?.env, env[key] != nil else { return }
        env[key] = nil
        await writeEnv(env, changed: key)
    }

    public func restart() async {
        guard !restarting else { return }
        restarting = true
        defer { restarting = false }
        do {
            restartQueued = try await api.restartSession(sessionID)
            saveError = nil
        } catch APIError.http(409, _) {
            // The engine ended meanwhile: nothing to restart, the next message starts with the new env.
            if let read = try? await api.sessionSettingsDetail(sessionID) {
                detail = read
                settings = read.settings ?? settings
            }
            settings?.envPendingRestart = false
        } catch {
            saveError = APIClient.failureReason(error)
        }
    }

    public func setPublicLink(_ on: Bool) async {
        let before = shareLink
        do {
            if on {
                shareLink = try await api.putShareLink(.session, sessionID, PutShareLinkRequest())
            } else {
                shareLink = nil
                try await api.turnOffShareLink(.session, sessionID)
            }
            saveError = nil
        } catch {
            shareLink = before
            saveError = APIClient.failureReason(error)
        }
    }

    private func writeEnv(_ env: [String: String], changed key: String) async {
        let ok = await write(SessionSettingsPatch(env: env)) { $0.env = env }
        if ok {
            changedKeys.insert(key)
            restartQueued = nil
        }
    }

    @discardableResult
    private func write(_ patch: SessionSettingsPatch, _ apply: (inout SessionSettingsValues) -> Void) async -> Bool {
        guard let before = settings else { return false }
        var next = before
        apply(&next)
        settings = next
        do {
            settings = try await api.patchSessionSettings(sessionID, patch)
            saveError = nil
            return true
        } catch {
            settings = before
            saveError = APIClient.failureReason(error)
            return false
        }
    }
}
