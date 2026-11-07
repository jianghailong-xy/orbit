import Foundation

/// Where one control event goes (docs/list-freshness-design.md §4 R5): the one list it is about,
/// and nothing at all for a type this client does not know. `AppModel.apply` switches on this, so
/// what each event costs is decided here, where it can be tested.
///
/// The Open list is the app's most expensive read, so only the routes that say so read it:
/// `.openList` and `.sessionLeft` always, `.sessionRow` and `.approvalRow` only when the event cannot
/// be folded into the row it names. Every other route reads its own list and never the Open list —
/// before this, `watch.changed`, `project.criteria_decisions.changed`, macOS's `folder.changed`
/// and every type a newer server adds fell through to a whole Open-list read.
public enum ControlEventRoute: Equatable, Sendable {
    /// `session.created` / `session.updated`: fold the summary into its row; the Open list only for
    /// what the summary cannot carry.
    case sessionRow
    /// `approval.requested` / `approval.resolved`: set the row's count; the Open list only when the
    /// row is not loaded.
    case approvalRow
    /// `session.ended`: the row leaves Open, and membership is the list's to say.
    case sessionLeft
    /// A field only the list query returns: a run error's line (`session.error`), a background count
    /// (`background.task`), a tag's name and color on the rows that carry it (`tag.changed`).
    case openList
    /// `task.changed`: the rows it names, or the whole task page for a coarse change.
    case tasks
    /// `task.list.changed`.
    case taskLists
    /// `agent.changed`: the workspace list.
    case agents
    /// `provider.changed`.
    case providers
    /// `project.changed`: the project summaries.
    case projects
    /// `project.criteria_decisions.changed`: that project's pending decisions — nil when the event
    /// names no project, which reads as every loaded one.
    case projectDecisions(projectID: String?)
    /// `watch.changed`: the watch list.
    case watches
    /// `folder.changed`: the folder library. macOS draws no folders, so there it reads nothing.
    case folders
    /// `wiki.changed`: what the Wiki has loaded, and the wiki chat.
    case wiki
    /// Nothing to read: the reserved `notification` channel, and any type this client does not know.
    case nothing

    public static func of(_ event: ControlEvent) -> ControlEventRoute {
        switch event.type {
        case .sessionCreated, .sessionUpdated: return .sessionRow
        case .approvalRequested, .approvalResolved: return .approvalRow
        case .sessionEnded: return .sessionLeft
        case .sessionError, .backgroundTask, .tagChanged: return .openList
        case .taskChanged: return .tasks
        case .taskListChanged: return .taskLists
        case .agentChanged: return .agents
        case .providerChanged: return .providers
        case .projectChanged: return .projects
        case .projectCriteriaDecisionsChanged:
            let id = event.payload(ControlResourceChanged.self)?.id
            return .projectDecisions(projectID: id?.isEmpty == false ? id : nil)
        case .watchChanged: return .watches
        case .folderChanged: return .folders
        case .wikiChanged: return .wiki
        case .notification, .unknown: return .nothing
        }
    }

    /// Whether the route always reads the Open list. `.sessionRow` and `.approvalRow` read it only
    /// when their row cannot take the event, which the app decides with the row in hand.
    public var readsOpenList: Bool {
        switch self {
        case .openList, .sessionLeft: return true
        default: return false
        }
    }
}
