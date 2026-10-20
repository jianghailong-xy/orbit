import Foundation

/// What the clients need to know about Cursor CLI (`cursor`) that no other engine shares, read the way
/// the runner and the server read it (docs/cursor-runtime-contract.md; the owner's design board,
/// docs/mocks/cursor-engine).
///
/// Orbit runs one pinned build of Cursor CLI (contract §1) and installs it itself, so a runner is asked
/// whether it can START Cursor CLI — it declares `provider:cursor` once that build is ready there, and
/// its engine report says what is missing when it is not — and, separately, whether the account a
/// session would run on is signed in.
///
/// Mirrors web's `lib/cursorRuntime.ts`; keep the two in sync (`CursorRuntimeTests` reads it back).
public enum CursorRuntime {
    public static let engine = "cursor"
    /// Cursor CLI's name, as every list of engines writes it (shared `ENGINE_CLI_NAMES`).
    public static let name = ProviderEngines.cliName(engine)
    /// The heartbeat capability the server requires before it hands out, resumes or leases a Cursor CLI
    /// session (contract §16.1): declared only while the pinned build is ready on that runner.
    public static let runnerCapability = "provider:cursor"
    /// What a runner declares once it signs a Cursor CLI account the control plane names into that
    /// account's own directory (contract §16.1, P4b). Without it nothing offers to add one.
    public static let accountLoginCapability = "cursor-account-login/v1"
    /// What a runner declares once it can carry a Cursor conversation to another account or key
    /// (contract §13.3, D5). No runner declares it until two real identities have shown it works.
    public static let accountMoveCapability = "cursor-account-move/v1"
    /// The Cursor CLI build Orbit runs (contract §1): newer releases are not followed.
    public static let pinnedVersion = "2026.10.14-941492e"
    /// The preset a Cursor User API Key is connected from — not `cursor`, the engine's own name.
    public static let keyPreset = "cursor-api"
    /// Auto in Cursor CLI's catalogue (the parameterized model picker, contract §10): it takes no
    /// parameters, and naming no model at all runs it too.
    public static let autoModel = "default"

    // MARK: - the runner

    /// Why a runner can't start Cursor CLI, most fundamental first, or `ready` (web `CursorRunnerState`).
    public enum RunnerState: String, Equatable, Sendable {
        case ready, updateRunner, unsupportedPlatform, unsupportedVersion, notInstalled

        /// The words a picker row or a machine's row uses for a state that blocks a session.
        public var label: String? {
            switch self {
            case .ready: return nil
            case .updateRunner: return "Update runner"
            case .unsupportedPlatform: return "Not supported here"
            case .unsupportedVersion: return "Unsupported version"
            case .notInstalled: return "Not installed"
            }
        }

        /// A runner too old for Cursor CLI, on a platform its pinned build was never measured on, or with
        /// a build other than the pinned one: the machine's whole story, which nothing signed in or read
        /// there changes. Not installed is every engine's missing CLI, with its Install.
        public var blocks: Bool { self == .updateRunner || self == .unsupportedPlatform || self == .unsupportedVersion }

        /// The label of a state that `blocks`, nil otherwise.
        public var blocksLabel: String? { blocks ? label : nil }
    }

    /// The runner's own report of Cursor CLI, when it has one.
    static func health(_ engines: [RunnerEngineHealth]?) -> RunnerEngineHealth? {
        engines?.first { $0.engine == engine }
    }

    /// Whether this runner knows Cursor CLI at all: it declares it, or reports it among its engines —
    /// every engine its release knows, installed or not. A runner that does neither predates it.
    public static func runnerKnows(_ runner: Runner) -> Bool {
        runner.capabilities?.contains(runnerCapability) == true || health(runner.engines) != nil
    }

    /// Whether this runner can start a Cursor CLI session, in the board's order of what is most
    /// fundamental (Web 1 ②): a runner that predates Cursor CLI, then a platform the pinned build was never
    /// measured on, then a build other than the pinned one, then none at all. A runner whose report says
    /// the pinned build is ready and still does not declare it carries no session driver for it, which an
    /// update brings — the server refuses it a session either way. Signed in or not is the credential's
    /// question, not the runner's: a key carries its own.
    public static func state(capabilities: [String]?, engines: [RunnerEngineHealth]?) -> RunnerState {
        let declared = capabilities?.contains(runnerCapability) == true
        guard let health = health(engines) else { return declared ? .ready : .updateRunner }
        let error = health.installationError ?? ""
        if error.hasPrefix("CURSOR_PLATFORM_UNSUPPORTED") { return .unsupportedPlatform }
        if error.hasPrefix("CURSOR_VERSION_INCOMPATIBLE") { return .unsupportedVersion }
        if health.installed != true { return .notInstalled }
        return declared ? .ready : .updateRunner
    }

    public static func state(of runner: Runner?) -> RunnerState {
        state(capabilities: runner?.capabilities, engines: runner?.engines)
    }

    /// One sentence under a machine's Cursor CLI row on what the state means and what fixes it. Not
    /// installed has none: its row offers the install itself. A platform the pinned build does not run on
    /// is the runner's own sentence, which names both platforms.
    public static func stateHint(_ state: RunnerState, installationError: String? = nil) -> String? {
        switch state {
        case .updateRunner:
            return "This runner predates \(name). It updates itself when no session is running on it."
        case .unsupportedVersion:
            return "Orbit runs \(name) \(pinnedVersion). Reinstall puts that version back on this runner; "
                + "sessions here can’t start until then."
        case .unsupportedPlatform:
            var said = installationError ?? ""
            if said.hasPrefix("CURSOR_PLATFORM_UNSUPPORTED:") {
                said = String(said.dropFirst("CURSOR_PLATFORM_UNSUPPORTED:".count))
            }
            said = said.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !said.isEmpty else { return "Orbit doesn’t run \(name) on this runner’s platform yet." }
            while said.hasSuffix(".") { said.removeLast() }
            return said + "."
        default:
            return nil
        }
    }

    /// The fix a machine's Cursor CLI row offers for its state: the pinned build put there, or put back.
    public static func installLabel(_ state: RunnerState) -> String? {
        switch state {
        case .notInstalled: return "Install \(name)"
        case .unsupportedVersion: return "Reinstall \(name)"
        default: return nil
        }
    }

    /// The machine page's footer once it draws Cursor CLI (board iOS 2 ②): the other CLIs follow their
    /// releases every 30 minutes, Cursor CLI stays on the build Orbit pins.
    public static let machineEnginesFooter =
        "Orbit keeps these CLIs updated every 30 min — \(name) stays on the version Orbit pins. Sign-ins live "
        + "on this machine — a session spends that subscription, nothing to paste."

    /// Cursor CLI's own page's footer (board iOS 2 ③), in place of the other engines' words about being
    /// kept updated: its version is the one Orbit pins.
    public static let enginePageFooter =
        "Orbit keeps \(name) on the version it pins, \(pinnedVersion). Sign-ins live on this machine — a "
        + "session spends that account’s Cursor plan."

    // MARK: - a session

    /// Whether a Cursor CLI session has a conversation another account or key would have to continue: a
    /// turn of it settled, Cursor opened its conversation (runtimeSessionId, reported right before the
    /// first prompt), or a turn is running now. The same question the server asks before it moves one
    /// (P6b), so the Provider menu never offers a move the server refuses.
    public static func conversationStarted(_ session: Session?) -> Bool {
        guard let session else { return false }
        return (session.numTurns ?? 0) > 0 || !(session.runtimeSessionId ?? "").isEmpty || session.isGenerating
    }

    /// Under the Provider menu of a Cursor CLI session that has talked, on a runner that can't carry its
    /// conversation: why its other accounts and keys are listed but can't be picked (D5). The server's
    /// refusal of the same request says the same in its own words.
    public static let moveBlockedNote =
        "\(name) can’t carry a conversation to another account or key yet. Start a new session to use one of these."

    /// In the model menu under Auto, which has no parameters to set (contract §10): the board's words (iOS
    /// 5 ①), context among them now that the menu has its row — the web, with none yet, leaves context out.
    public static let autoNote =
        "Auto picks a model for each request. Cursor doesn’t report which one it used, and Auto has no effort or context to set."

    /// Under the tray of messages waiting for a running Cursor CLI turn (contract §3.2: a prompt sent
    /// mid-turn cancels the turn, so Orbit queues it).
    public static let queueNote =
        "\(name) can’t take a message mid-turn — sending one would stop the turn. These go in order once it ends."

    /// The composer's placeholder while a Cursor CLI turn runs.
    public static let runningPlaceholder = "Reply — it goes to \(name) when this turn ends…"

    /// The context gauge's sheet: Cursor CLI never reports context use over ACP (contract §4.1).
    public static let contextUnavailable =
        "\(name) doesn’t report how much of the window a session has used, so there is no reading to show."

    /// Whether `model` is Auto: its catalogue's `default`, or no model named at all, which runs as Auto
    /// (web `cursorAuto`, read off the model the value names).
    public static func isAuto(_ model: String?) -> Bool {
        let name = decodeModel(model).model
        return name.isEmpty || name == autoModel
    }

    // MARK: - a model's settings (shared `cursorModels.ts`, contract §10)

    /// The settings a Cursor model value carries, by Cursor's option ids: the context size and the fast
    /// lane (shared `CURSOR_VARIANT_PARAMETERS`). Its effort stays in the session's effort field, and Auto
    /// takes none.
    public static let variantParameters = ["context", "fast"]
    public static let contextParameter = "context"
    public static let fastParameter = "fast"

    /// One `id=value` of a variant (shared `PAIR`): neither side empty, nor holding what the syntax itself is
    /// made of.
    private static func pair<S: StringProtocol>(_ text: S) -> (id: String, value: String)? {
        let sides = text.split(separator: "=", omittingEmptySubsequences: false)
        func plain(_ side: S.SubSequence) -> Bool {
            !side.isEmpty && !side.contains { $0.isWhitespace || "=,[]".contains($0) }
        }
        guard sides.count == 2, plain(sides[0]), plain(sides[1]) else { return nil }
        return (String(sides[0]), String(sides[1]))
    }

    /// Reads a Cursor model value (shared `decodeCursorModel`): `name[id=value,…]`, with at least one setting,
    /// is the model `name` with those settings; anything else is a model's name as it stands, naming no
    /// settings — `default[]`, Claude Code's `claude-opus-5[1m]`, a malformed or repeated setting.
    public static func decodeModel(_ value: String?) -> (model: String, parameters: [String: String]) {
        let text = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let asIs = (model: text, parameters: [String: String]())
        guard let open = text.firstIndex(of: "["), open != text.startIndex, text.hasSuffix("]"),
              text.firstIndex(of: "]") == text.index(before: text.endIndex),
              text.lastIndex(of: "[") == open else { return asIs }
        var parameters: [String: String] = [:]
        let inside = text[text.index(after: open)..<text.index(before: text.endIndex)]
        for piece in inside.split(separator: ",", omittingEmptySubsequences: false) {
            guard let (id, value) = pair(piece), parameters[id] == nil else { return asIs }
            parameters[id] = value
        }
        return (String(text[..<open]), parameters)
    }

    /// Writes a Cursor model value (shared `encodeCursorModel`): the model's bare name, followed by the
    /// settings given, in the order of their ids. A setting with no value, one at the model's own default
    /// (where its catalogue row says what that is) and one the syntax can't hold are left out; Auto, or no
    /// model at all, takes none.
    public static func encodeModel(_ model: String, _ parameters: [String: String?] = [:],
                                   row: RunnerModelInfo? = nil) -> String {
        let name = model.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty || name == autoModel { return name }
        var defaults: [String: String] = [:]
        for parameter in row?.parameters ?? [] { defaults[parameter.id] = parameter.defaultValue }
        let pairs = parameters.compactMap { id, value -> (String, String)? in
            guard let value, value != defaults[id], pair("\(id)=\(value)") != nil else { return nil }
            return (id, value)
        }.sorted { $0.0 < $1.0 }
        return pairs.isEmpty ? name : "\(name)[\(pairs.map { "\($0.0)=\($0.1)" }.joined(separator: ","))]"
    }

    /// The model a Cursor model value names, without the settings it carries: `claude-opus-5-5[context=1m]`
    /// is `claude-opus-5-5`.
    public static func modelBase(_ model: String) -> String { decodeModel(model).model }

    /// A Cursor CLI session's model value read against the runner's catalogue (web `cursorModelPick`): the
    /// model the menu checks, its row, and the settings the value names beside it. A value the catalogue
    /// lists as it stands is a model of its own.
    public struct Pick: Equatable, Sendable {
        public let model: String
        public let row: RunnerModelInfo?
        public let parameters: [String: String]
    }

    public static func pick(_ value: String, catalog: RunnerModelCatalog?) -> Pick {
        let row = catalog?.modelInfo(for: engine, model: value)
        if let row, row.value == value { return Pick(model: value, row: row, parameters: [:]) }
        let decoded = decodeModel(value)
        return Pick(model: decoded.model, row: row, parameters: decoded.parameters)
    }

    /// A row of the model menu for one of a Cursor model's own settings (web `CursorSettingRow`): what it is
    /// called there, the value in effect — the one the model value names when the model offers it, else the
    /// model's own — and the values to pick from, as the runner's catalogue lists them.
    public struct SettingRow: Equatable, Sendable {
        public let id: String
        public let title: String
        public let value: String
        public let label: String
        public let defaultValue: String
        public let values: [RunnerModelParameterValue]
    }

    /// The menu's rows for a Cursor model's context size and fast lane, in the board's order (web
    /// `cursorSettingRows`): Context, then Speed — Cursor's `fast`, which reads Standard or Fast as every
    /// engine's Speed row does — each only where the model's row lists it. Auto has none.
    public static func settingRows(_ pick: Pick?) -> [SettingRow] {
        guard let pick else { return [] }
        return [(contextParameter, "Context"), (fastParameter, "Speed")].compactMap { id, title in
            guard let parameter = pick.row?.parameters?.first(where: { $0.id == id }) else { return nil }
            let values = parameter.values.filter { !$0.value.isEmpty }.map { option in
                id == fastParameter && option.value != "true"
                    ? RunnerModelParameterValue(value: option.value, label: "Standard") : option
            }
            guard !values.isEmpty else { return nil }
            let defaultValue = parameter.defaultValue ?? ""
            let named = pick.parameters[id]
            let value = named.flatMap { named in values.contains { $0.value == named } ? named : nil } ?? defaultValue
            let label = values.first { $0.value == value }?.label ?? value
            return SettingRow(id: id, title: title, value: value, label: label, defaultValue: defaultValue,
                              values: values)
        }
    }

    /// What the chip says after a Cursor model's effort (web `cursorChipSettings`, the board's "Claude Opus 5.5
    /// High · 1M · Fast"): a context other than the model's own, then the fast lane when it is on.
    public static func chipSettings(_ rows: [SettingRow]) -> [String] {
        rows.compactMap { row in
            (row.id == fastParameter ? row.value == "true" : row.value != row.defaultValue) ? row.label : nil
        }
    }

    // MARK: - permission modes (D6)

    /// The modes Cursor CLI enforces (shared `CURSOR_PERMISSION_MODES`): every one but Default, which it
    /// cannot honour — it edits files inside the workspace without asking in every mode.
    public static let permissionModes: [PermissionMode] = [.acceptEdits, .plan, .auto, .dontAsk, .bypass]
    /// Where a session lands that names no mode, or one Cursor CLI refuses (the owner's choice D6 A).
    public static let defaultPermissionMode = PermissionMode.acceptEdits

    /// A mode's subtitle in the mode menu (board iOS 6 ②): the shared `permissionSemantics` short note
    /// for Cursor CLI, first letter capitalised — the same words the web's mode picker writes after the
    /// mode's name. Nil for a mode it keeps as it says.
    public static func modeNote(_ mode: PermissionMode) -> String? {
        switch mode {
        case .default: return "Unsupported on \(name); session configuration is rejected"
        case .dontAsk: return "Partly enforced, edits inside the workspace still run"
        default: return nil
        }
    }

    // MARK: - an account's quota (contract §11)

    /// A spent account: when its included usage comes back, when Cursor said.
    public struct UsageLimit: Equatable, Sendable {
        public let resetsAt: String?
    }

    /// When a Cursor CLI account met Cursor's usage limit this period ("Upgrade your plan to continue",
    /// contract §12): spent until its included usage resets, which `resetsAt` names when Cursor did — and
    /// not at all once that has passed, or for a limit met before this period began. Nil for an account
    /// that can run. Mirrors web's `cursorUsageLimit`.
    public static func usageLimit(_ snapshot: PlanUsageSnapshot?, now: Date = Date()) -> UsageLimit? {
        guard let included = snapshot?.includedUsage,
              let reached = included.limitReachedAt.flatMap(RelativeTime.parse) else { return nil }
        if let starts = included.startsAt.flatMap(RelativeTime.parse), reached < starts { return nil }
        let resets = included.resetsAt.flatMap(RelativeTime.parse)
        if let resets, resets <= now { return nil }
        if let resets, resets > reached { return UsageLimit(resetsAt: included.resetsAt) }
        return UsageLimit(resetsAt: nil)
    }

    /// How long a period is, from Cursor's own name for it (shared `CURSOR_PERIOD_MINS`).
    static let periodMins: [String: Int] = ["weekly": 7 * 24 * 60, "monthly": 30 * 24 * 60]

    /// A Cursor CLI account's included usage as the windows quota is weighed by (shared `cursorWindows`):
    /// `limit`, a turn on it met Cursor's usage limit this period, so it is spent until the included usage
    /// resets; `reading`, the share used, which Cursor reports only above 0 to mean anything — it orders
    /// accounts and never says one is spent.
    static func windows(_ snapshot: PlanUsageSnapshot) -> (limit: PlanUsageWindow?, reading: PlanUsageWindow?) {
        guard let included = snapshot.includedUsage else { return (nil, nil) }
        let mins = included.period.flatMap { periodMins[$0] }
        let resets = included.resetsAt.flatMap(RelativeTime.parse)
        var limit: PlanUsageWindow?
        if let reached = included.limitReachedAt.flatMap(RelativeTime.parse),
           !(included.startsAt.flatMap(RelativeTime.parse).map { reached < $0 } ?? false) {
            limit = PlanUsageWindow(utilization: 100, resetsAt: (resets.map { $0 > reached } ?? false) ? included.resetsAt : nil,
                                    windowDurationMins: mins)
        }
        var reading: PlanUsageWindow?
        if let used = included.percentUsed, used.isFinite, used > 0 {
            reading = PlanUsageWindow(utilization: used, resetsAt: resets == nil ? nil : included.resetsAt,
                                      windowDurationMins: mins)
        }
        return (limit, reading)
    }

    /// What an account's line says where Cursor reports no share of its usage (board iOS 2 ③): no number
    /// at all rather than one Orbit made up — the Free plan's requests by their own name.
    public static func usageUnavailable(plan: String?) -> String {
        guard let plan, !plan.isEmpty else {
            return "Usage unavailable — Cursor doesn’t report how much of this account’s usage is left."
        }
        if plan == "Free" { return "Usage unavailable — Cursor doesn’t report how many of the Free plan’s requests are left." }
        return "Usage unavailable — Cursor doesn’t report how much of the \(plan) plan’s usage is left."
    }

    /// A spent account's status (web's `Spent · resets …`), its reset in the reader's own words.
    public static func spentStatus(_ limit: UsageLimit, now: Date, timeZone: TimeZone = .current) -> String {
        guard let resets = limit.resetsAt, let when = RunnerPageFormat.resetsWhen(resets, now: now, timeZone: timeZone)
        else { return "Spent" }
        return "Spent · resets \(when)"
    }

    // MARK: - an API key (P2, P2 follow-up)

    /// Whether a configured row is a Cursor User API Key: it runs on Cursor CLI alone.
    public static func isKey(_ key: ConfiguredProvider) -> Bool {
        key.runtime == engine || key.presetSlug == keyPreset
    }

    /// Where Cursor's API lives, as a key's page names it.
    public static let keyEndpoint = "api2.cursor.sh"

    /// What a Cursor key's last check came to, as its row and its page say it (board iOS 4 ②④⑤).
    public enum KeyCheck: Equatable, Sendable {
        /// Cursor accepted it.
        case valid
        /// Cursor refused it: "The provided API key is invalid."
        case rejected
        /// The runner that checked it couldn't reach Cursor — which says nothing about the key.
        case unreachable
    }

    public static func keyCheck(_ key: ConfiguredProvider) -> KeyCheck? {
        switch key.keyCheckState {
        case "VALID": return .valid
        case "INVALID": return .rejected
        case "UNREACHABLE": return .unreachable
        default: return nil
        }
    }

    /// The key's row's end in the API keys list: Rejected, in orange, where Cursor refused it — the
    /// place a DeepSeek key's balance takes.
    public static let keyRejectedTag = "Rejected"

    /// The key's page's Last check (board iOS 4 ④⑤): what Cursor answered and how long ago, in the key
    /// page's own words for a time (`DeepSeekBalance.ago`).
    public static func lastCheck(_ check: KeyCheck?, at: String?, now: Date = Date()) -> String {
        let when = at.map { " · " + DeepSeekBalance.ago($0, now: now).lowercased() } ?? ""
        switch check {
        case .valid?: return "Valid" + when
        case .rejected?: return "Rejected" + when
        case .unreachable?: return "Couldn’t check" + when
        case nil: return "Not checked yet"
        }
    }

    /// Under the Check section: what the check is, or what its answer means (board iOS 4 ④⑤).
    public static func checkFooter(_ check: KeyCheck?) -> String {
        switch check {
        case .rejected?:
            return "Cursor said “The provided API key is invalid.” Paste a new key on the web, then check again."
        case .unreachable?:
            // The server's own sentence for the same answer (providers.service `cursorKeyCheckAnswer`).
            return "Couldn’t reach Cursor from the runner that checks keys. The key itself may be fine."
        default:
            return "A runner with \(name) checks the key with Cursor (no request is spent)."
        }
    }

    /// The key's one engine, on its page (board iOS 4 ③), and the sentence under it.
    public static let keyRunsLine = "Billed to this key’s Cursor plan"
    public static let keyRunsFooter =
        "Pick it for a \(name) session in the composer’s model menu → Provider. It runs no other engine."
    /// The key's page's footer: keys are added and changed on the web.
    public static let keyPageFooter = "Adding or changing a key happens on the web. Turning it off there stops it on \(name)."
}
