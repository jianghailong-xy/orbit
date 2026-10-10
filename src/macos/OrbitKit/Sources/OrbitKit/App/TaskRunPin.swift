import Foundation

/// A task's engine and provider pins (docs/provider-engine-contract.md §1.2, board 6): what its runs use
/// instead of its assignee workspace's, read and written the web's way (TaskDetailPanel's Engine and
/// Provider fields). The engine is the CLI that runs it; the provider where its credential comes from —
/// one that engine runs. Unpinned, a task runs on what its assignee's project last ran.
public struct TaskRunPin: Equatable, Sendable {
    /// The engine pinned on the task, nil when it inherits one.
    public let pinnedEngine: String?
    /// The credential pinned on the task, nil when it inherits one.
    public let pinnedProvider: String?
    /// What the assignee's project last ran on, engine and provider both — what an unpinned task runs.
    public let assigneeEngine: String
    public let assigneeProvider: String
    /// The engine its runs use: its own pin, else — under a provider an older client pinned alone — that
    /// provider's default engine, else the assignee's.
    public let runEngine: String

    public init(task: TaskItem, assignee: Agent?, configured: [ConfiguredProvider]) {
        pinnedProvider = task.provider
        pinnedEngine = ProviderEngines.isEngine(task.engine) ? task.engine : nil
        assigneeProvider = assignee?.defaultProvider ?? "claude"
        assigneeEngine = assignee?.defaultEngine(configured: configured) ?? "claude"
        runEngine = pinnedEngine
            ?? pinnedProvider.flatMap { ProviderEngines.defaultEngine(ofProvider: $0, configured: configured) }
            ?? assigneeEngine
    }

    /// What the Engine field says while no engine is pinned: the assignee's — or, under a provider an
    /// older client pinned alone, that provider's engine (web's placeholder).
    public var inheritedEngine: String {
        pinnedProvider != nil
            ? ProviderEngines.cliName(runEngine)
            : "\(TaskDetailCopy.assigneesEngine) · \(ProviderEngines.cliName(assigneeEngine))"
    }

    /// What "Engine default" runs a task on (only an engine named, contract §3.2): the runner's own
    /// sign-in, OpenCode's own configuration, the first DeepSeek key — by its name when there is one.
    public static func engineDefaultLabel(engine: String, firstDeepSeekKey: String?, runnerName: String?) -> String {
        switch engine {
        case "dsh": return firstDeepSeekKey ?? "first DeepSeek key"
        case "opencode": return "OpenCode's own sign-in"
        default: return runnerName.map { "sign-in on \($0)" } ?? "runner sign-in"
        }
    }

    /// The credential whose model space the Model picker lists: the task's own pin, the engine's default
    /// credential under an engine pinned alone (DeepSeek Harness's first DeepSeek key), else the
    /// assignee's.
    public func runProvider(firstDeepSeekKey: String?) -> String {
        if let pinnedProvider { return pinnedProvider }
        guard let pinnedEngine else { return assigneeProvider }
        return pinnedEngine == "dsh" ? firstDeepSeekKey ?? "dsh" : pinnedEngine
    }

    /// The write the Engine field makes (board 6 ③), nil when nothing moves. A pinned credential the new
    /// engine does not run gives way to that engine's default, one it runs stays, and a model never
    /// survives the move. Back on the assignee's, nothing stays pinned.
    public func engineRequest(_ engine: String?, configured: [ConfiguredProvider]) -> UpdateTaskRequest? {
        guard engine != pinnedEngine else { return nil }
        guard let engine else { return UpdateTaskRequest(engine: .clear, provider: .clear, model: .clear) }
        let keep = pinnedProvider.map { ProviderEngines.engines(ofProvider: $0, configured: configured).contains(engine) }
        return UpdateTaskRequest(engine: .set(engine), provider: keep == false ? .clear : .keep, model: .clear)
    }

    /// The write the Provider field makes, nil when nothing moves: a credential is pinned with the
    /// engine it runs on — the shown one — so a task names the pair (contract §3.5); "Engine default"
    /// (nil) takes the credential pin back. The model goes with either.
    public func providerRequest(_ slug: String?) -> UpdateTaskRequest? {
        guard let slug else {
            return pinnedProvider == nil ? nil : UpdateTaskRequest(provider: .clear, model: .clear)
        }
        guard slug != pinnedProvider else { return nil }
        return UpdateTaskRequest(engine: .set(runEngine), provider: .set(slug), model: .clear)
    }
}
