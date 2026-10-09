import Foundation

/// The card a session page draws when no engine ever ran on the session — the native half of the
/// "this run never started" design (`docs/mocks/source-refused/01` and `02`).
///
/// A session whose run never began has an empty transcript, so every card the app already has is
/// unreachable: the transcript's repair cards are drawn from turns that arrived, and the status
/// glyph can only say `Starting` while the row still holds a claim. This is the one surface that
/// answers "why is nothing happening" for a run that produced nothing.
///
/// TWO TIERS, ONE CARD.
///
/// 1. **A refused SOURCE** (`sourceState == "REFUSED"`, §6.1 T4/T8). The run never reached a
///    checkout, the refusal is terminal and a refused session never re-resolves (SR34), so the
///    way on is a NEW run — hence "Start it again". The card carries the code, the ref it could
///    not resolve and the runner's own words, all of which the server already wrote down; the
///    next step is §10.1's `fixAction`, which travels WITH the code precisely so this client does
///    not re-derive it (SR49).
/// 2. **A machine-side reason** (`session.error`). Nothing about the work is wrong; the runner
///    could not start an engine on it. The conversation itself is resumable, so the way on is a
///    re-send — hence "Send it again".
///
/// WHY THE SENTENCES ARE WHERE THEY ARE. Every sentence this card shows already exists somewhere,
/// and this file reads it from there rather than saying it a second time:
///
/// - the engine repairs come from `EngineAuth` and `DshRuntime`, the two modules that hold the
///   words web's `Transcript.tsx` repair cards show (web is the source; the Swift modules mirror
///   it and their own tests compare them character for character);
/// - the claim's sentences are the server's `runner-api/runner-provider-support.ts` ones, which
///   are what the row's `error` actually says — the card quotes the version the server names
///   rather than carrying a number of its own that would go stale;
/// - `Disconnected — runner went offline` is `SessionStatusGlyph`'s (web's `WorkspaceView.tsx`);
/// - the one sentence that is new to Swift is a refusal's NEXT STEP, and it is not written here
///   either: it is the server's own `dispatchRefusalNextStep` (`tasks/task-dispatch-refusal.ts`),
///   the sentence the task's comment and the coordinator's message already give, ported so a phone
///   gives the same advice. `SessionRunStartCopyParityTests` reads that file back and compares.
///
/// NOT CLAIMED HERE, deliberately: an Antigravity or DeepSeek Harness engine that is missing or
/// refusing to start. Both already have a card of their own on this page —
/// `AntigravityRepairCardView` and `DshRepairCardView`, drawn above the composer — which carry
/// machinery this one does not (the sign-in relay, the install poll). One fact, one card: those
/// return nil here, and the reasons this card DOES claim are the ones nothing else draws.
public enum SessionRunStart {
    /// The card's title, both tiers, exactly as the design spells it.
    public static let title = "This run never started"

    /// What the session page draws. `why` and `body` are the two lines of prose; `lines` are the
    /// machine facts under them, drawn monospaced.
    public struct Card: Equatable, Sendable {
        public let why: String
        public let body: String
        public let lines: [String]
        /// The next step: what the design draws as buttons. The first is the primary press.
        public let actions: [Action]
        /// The run's own epitaph under the card.
        public let footer: String?

        public init(why: String, body: String, lines: [String] = [], actions: [Action] = [],
                    footer: String? = nil) {
            self.why = why
            self.body = body
            self.lines = lines
            self.actions = actions
            self.footer = footer
        }
    }

    /// A press the card offers. The kind is what the view wires; the label is what it says.
    public struct Action: Equatable, Sendable {
        public enum Kind: String, Equatable, Sendable {
            /// A new run on the task (SR34's recovery) — the task tier.
            case startItAgain
            /// Re-send the last message: the conversation is resumable — the ordinary tier.
            case sendItAgain
            /// Open the runner this session is assigned to.
            case openRunner
            /// Hand the composer a reply about this run.
            case chatAboutThis
        }

        public let kind: Kind
        public let label: String

        public init(kind: Kind, label: String) {
            self.kind = kind
            self.label = label
        }

        /// The press that answers the card, rather than the one that only looks around.
        public var primary: Bool { kind == .startItAgain || kind == .sendItAgain }
    }

    /// §6.1's terminal state, as the DB spells it (`session_source_state_chk`).
    public static let refusedState = "REFUSED"

    /// §10.3 SR50's one project blocker kind, which every SOURCE refusal routes to — this one
    /// spells the session state, that one routes the project's page.
    public static let unresolvedBlockerKind = "SOURCE_UNRESOLVED"

    /// The card for a session whose engine never ran, or nil for a session this card has nothing
    /// to say about — one that never claimed a run, or one whose reason another card owns.
    public static func card(for session: Session, runnerName: String? = nil,
                            runnerVersion: String? = nil) -> Card? {
        card(error: session.error, sourceState: session.sourceState,
             sourceRefusalCode: session.sourceRefusalCode,
             sourceRefusalDetail: session.sourceRefusalDetail,
             status: session.effectiveRunStatus,
             runnerName: runnerName, runnerVersion: runnerVersion)
    }

    /// The same card from the facts themselves, for a caller that holds them one by one rather
    /// than holding the whole row (the console adopts the fields it needs by name).
    public static func card(error: String?, sourceState: String?, sourceRefusalCode: String?,
                            sourceRefusalDetail: SourceRefusalDetail?, status: RunStatus,
                            runnerName: String? = nil, runnerVersion: String? = nil) -> Card? {
        // A refusal is terminal (§6.1 T8) and says so from its own column, whatever the run's
        // status is — which is the whole point: the bug this card exists for is a refused session
        // sitting on its claim forever, reading `Starting`.
        if let refused = refusalCard(sourceState: sourceState, code: sourceRefusalCode,
                                     detail: sourceRefusalDetail) {
            return refused
        }
        guard machineReasonStands(status: status) else { return nil }
        return machineCard(error: error, runnerName: runnerName, runnerVersion: runnerVersion)
    }

    /// Whether a machine-side reason is still this session's news.
    ///
    /// A failed or queued run is where such a reason lives. A session that is running again has
    /// left it behind, and the row does not say so by itself: a claim keeps the previous run's
    /// `error` (the claim SQL clears it for two named sentences only), so the status is what says
    /// whether the reason still describes the state of things.
    public static func machineReasonStands(status: RunStatus) -> Bool {
        status == .failed || status == .pending
    }

    // MARK: - the refused SOURCE

    /// The refusal's card, from the row the server wrote: the code, the ref and the runner's own
    /// words. Nothing here is inferred from `error` — a refusal is a column, not a sentence.
    static func refusalCard(sourceState: String?, code: String?,
                            detail: SourceRefusalDetail?) -> Card? {
        guard sourceState == refusedState else { return nil }
        let fixAction = detail?.fixAction
        let ref = detail?.ref

        // The design's words for the one code the incident that prompted this card actually had
        // (`BASE_REF_NOT_FOUND`, whose fixAction is FIX_REF): a project's integration line is
        // created by its first landing, so before that landing the ref does not exist.
        let prose = refusalProse(fixAction)
        var lines: [String] = []
        if let code { lines.append(code) }
        if let ref { lines.append(ref) }
        if let said = detail?.said { lines.append(said) }

        return Card(why: prose.why, body: prose.body, lines: lines,
                    actions: [Action(kind: .startItAgain, label: "Start it again"),
                              Action(kind: .chatAboutThis, label: chatAction)],
                    footer: "No engine ran — the task is still open.")
    }

    /// The two lines of prose, by §10.1's `fixAction` — the same key the next step is on, so the
    /// card cannot pair one action's explanation with another's advice.
    static func refusalProse(_ fixAction: String?) -> (why: String, body: String) {
        switch fixAction {
        case "FIX_REF":
            return ("Its baseline is a branch that doesn't exist yet",
                    "This project's integration line has not been created.")
        case "SYNC_INTEGRATION_LINE":
            return ("The line hasn't absorbed what the prerequisite landed",
                    "The commit this run needed has landed upstream, and this project's line has not caught up with it.")
        case "RESTORE_COMMIT":
            return ("This run's commit isn't in the runner's repository",
                    "The commit is pinned, so the machine that was going to start from it has to have it.")
        case "ENABLE_ISOLATION":
            return ("The runner couldn't make an isolated checkout",
                    "This run needed its own worktree on the pinned commit, and the workspace wouldn't give it one.")
        case "BIND_CODEBASE":
            return ("This project has no repository bound to it",
                    "A task that produces code starts from a commit, and nothing says which repository this project's code lives in.")
        case "FIX_WORKSPACE_REPO":
            return ("This workspace's checkout isn't this project's repository",
                    "The run starts from the project's repository, and the machine it was handed checks out a different one.")
        case "RETRY_OR_FIX_CREDENTIALS":
            return ("The runner couldn't reach the repository",
                    "Asking the authority for this ref failed — the network, the credentials or the remote itself.")
        case "FIX_CODEBASE_CONFIG":
            return ("This project's repository binding isn't usable",
                    "A ref name or a commit in it is written in a form the server won't resolve.")
        default:
            return ("This run's baseline couldn't be resolved",
                    "The start stopped before an engine was given anything to do, and starting it again alone would meet the same refusal.")
        }
    }

    /// §10.1's one sentence for the next step, in the server's own words.
    ///
    /// A port of `dispatchRefusalNextStep` (`src/apiserver/src/tasks/task-dispatch-refusal.ts`),
    /// which is what the task's comment and the coordinator's message say about the same refusal.
    /// Ported rather than restated: Swift cannot import the TypeScript, so
    /// `SessionRunStartCopyParityTests` reads that file and compares every sentence below.
    public static func nextStep(fixAction: String?, ref: String?) -> String {
        let again = "在那之前重新开工只会得到同一个拒绝。"
        let line = ref.map { "集成线 \(branchName($0))" } ?? "这次起跑的线"
        switch fixAction {
        case "SYNC_INTEGRATION_LINE":
            return "前置已经落地了——缺的是它落地的提交不在\(line)上：前置的成果进了 upstream，而这条线还没吸收 "
                + "upstream。先让这条线追上它（下一次任务落地时的 main 同步会做；等不及就从这条线的 tip 出发把 "
                + "upstream 合进来、推回这条线，不 rebase、不 force push），再开工。"
                + "在那之前重新开工只会得到同一个拒绝：新的开工从同一个 tip 起跑，要求的是同一组提交。"
        case "FIX_REF":
            return "解析的时候仓库里没有 \(ref.map { "`\($0)`" } ?? "这次起跑要用的 ref")："
                + "它还不存在、已经被删掉，或者和项目绑定里的名字对不上。先把它建出来"
                + "（这个项目在这条线上的第一次落地会创建它），或者把绑定的 integrationRef 改成实际存在的那一条，"
                + "再开工。" + again
        case "RESTORE_COMMIT":
            return "执行它的 runner 的仓库里没有这次钉住的提交：把它取回或恢复到那个仓库里，再开工。" + again
        case "ENABLE_ISOLATION":
            return "runner 没能在钉住的提交上建出独立的 worktree：确认这个工作区的 workDir 是 git 仓库、"
                + "没有关掉 worktree 隔离，并按上面 runner 的原话排查 `git worktree add` 的报错，再开工。" + again
        default:
            return "按处置 \(fixAction ?? "") 修好之后再开工。" + again
        }
    }

    /// The branch a full ref names, the way the server spells it (`branchName`,
    /// `projects/project-criterion-landing.ts`): a ref outside `refs/heads/` comes back whole.
    static func branchName(_ ref: String) -> String {
        ref.hasPrefix("refs/heads/") ? String(ref.dropFirst("refs/heads/".count)) : ref
    }

    // MARK: - the machine side

    /// Every reason here is the runner's own sentence arriving as `session.error`, recognized
    /// rather than composed. The sentences themselves are read from `EngineAuth` / `DshRuntime`
    /// (the modules that mirror web's repair cards) and from the server's own claim errors
    /// (`runner-provider-support.ts`), so a row and this card cannot drift apart.
    static func machineCard(error rawError: String?, runnerName: String?,
                            runnerVersion: String?) -> Card? {
        guard let error = rawError?.trimmingCharacters(in: .whitespacesAndNewlines),
              !error.isEmpty else { return nil }

        // An Antigravity or DeepSeek Harness engine repair already has a card of its own on this
        // page. One fact, one card (see the type's note).
        if EngineAuth.antigravityRepair(error) != nil || DshRuntime.repair(error) != nil { return nil }

        let machine = machineName(runnerName)

        if isRunnerOffline(error) {
            return Card(why: "The runner holding this session went offline",
                        body: "\(machine) stopped reporting while this run was starting. "
                            + "Nothing was produced, and nothing was sent anywhere.",
                        lines: [SessionStatusGlyph.offlineLabel],
                        actions: [Action(kind: .sendItAgain, label: "Send it again"),
                                  Action(kind: .chatAboutThis, label: chatAction)],
                        footer: "No engine ran — your message is still here.")
        }

        if let upgrade = runnerUpgrade(error) {
            return Card(why: EngineAuth.antigravityTitle(.updateRunner, runnerName: runnerName),
                        body: "\(machine) runs Orbit runner \(runnerVersion?.isEmpty == false ? runnerVersion! : "an unknown version")"
                            + "; \(upgrade.engine) needs \(upgrade.needs). "
                            + "The runner updates itself when no session is running on it, and this run starts then.",
                        actions: [Action(kind: .openRunner, label: "Open the runner")],
                        footer: "No engine ran — your message is still here.")
        }

        if let engine = notInstalled(error) {
            return Card(why: "\(engine) isn't installed on \(machine)",
                        body: installAdvice,
                        actions: [Action(kind: .openRunner, label: "Open the runner")],
                        footer: "No engine ran — your message is still here.")
        }

        return nil
    }

    /// The word web and this client both use for a run the reaper ended because the machine
    /// stopped reporting (`SessionStatusGlyph`, `WorkspaceView.tsx`). A reaped run's `error` is
    /// the server's bare `runner offline`.
    static func isRunnerOffline(_ error: String) -> Bool {
        error.lowercased().contains("offline")
    }

    /// The same advice every not-installed card in the app gives, character for character
    /// (`EngineAuth.antigravityBody(.notInstalled)`, `DshRuntime.Repair.notInstalled.detail`).
    static let installAdvice = "Install it from Infrastructure, then send your message again."

    /// The engine a not-installed failure names, when that is what the runner said. The runner's
    /// sentence is `<name> isn't installed on this runner and installing it failed (…)`, and the
    /// name in it is the CLI's own — taken from the sentence rather than from a second list here.
    static func notInstalled(_ error: String) -> String? {
        guard let range = error.range(of: " isn't installed on this runner") else { return nil }
        let name = String(error[error.startIndex..<range.lowerBound])
        return name.isEmpty ? nil : name
    }

    /// The engine and the release it wants, out of the server's claim sentences
    /// (`runner-provider-support.ts`): `OpenCode requires Orbit runner 0.1.82 or newer; update this
    /// runner first`, and Antigravity's and Harness's unversioned twins. Reading the number out of
    /// the sentence keeps the card from carrying a version of its own that would go stale.
    static func runnerUpgrade(_ error: String) -> (engine: String, needs: String)? {
        let suffix = "; update this runner first"
        guard error.hasSuffix(suffix),
              let marker = error.range(of: " requires ") else { return nil }
        let engine = String(error[error.startIndex..<marker.lowerBound])
        guard !engine.isEmpty else { return nil }
        let requirement = String(error[marker.upperBound..<error.index(error.endIndex, offsetBy: -suffix.count)])
        if let version = requirement.range(of: "Orbit runner "), requirement.hasSuffix(" or newer") {
            let number = String(requirement[version.upperBound..<requirement.index(requirement.endIndex, offsetBy: -" or newer".count)])
            return (engine, "\(number) or newer")
        }
        return (engine, "a newer release")
    }

    /// What the view prints for a session's machine, in the words the rest of the app uses
    /// (`EngineAuth`'s own fallback).
    static func machineName(_ name: String?) -> String {
        name?.isEmpty == false ? name! : "this runner"
    }

    /// `Approvals.chatAction` — the same press, with the same word, as every other card that hands
    /// a reply to the composer.
    public static let chatAction = Approvals.chatAction
}
