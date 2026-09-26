import Foundation

/// The Tasks list's words, in one place so the iPhone page and the browser say the same thing.
///
/// Every string the web page also shows is the web's own, and `TaskListCopyParityTests` reads the
/// web sources to hold them there: two clients naming one view differently is how a reader decides
/// one of them is wrong. The few words only the phone says (its section header for the rest of the
/// rows, its menu entries) are marked as such.
public enum TaskListCopy {
    // MARK: scopes (the title switcher)

    /// Every task outside projects — the web page's title for the same view.
    public static let allTasks = "All tasks"
    /// The tasks in no list, outside projects.
    public static let noList = "No list"
    /// The sheet the title switcher opens: the directory of lists.
    public static let taskListsTitle = "Task Lists"
    public static let searchLists = "Search lists"

    // MARK: the header

    /// The progress line's only words: done of total. The other tallies are on the chips.
    public static func doneOfTotal(done: Int, total: Int) -> (lead: String, done: String, tail: String) {
        ("Done", done.formatted(), "/ \(total.formatted())")
    }

    /// The one sentence about the work the page does not list, split where the web bolds the count.
    public static let scopeNoteLead = "Tasks outside projects."
    public static func scopeNote(tasks: Int, projects: Int) -> (lead: String, count: String, tail: String) {
        (scopeNoteLead, tasks.formatted(), "tasks in \(projects.formatted()) projects are on their project pages.")
    }
    public static let projectsLink = "Projects ›"

    /// What a list's own page offers: the conversation the list is steered from.
    public static let steeringSession = "Steering session ›"

    // MARK: sections

    /// The pinned section: running, queued, in progress or failed.
    public static let happeningNow = "Happening now"

    /// The header over the rest of the rows, naming their order. Phone-only: the web draws the order
    /// as its column headers' carets instead.
    public static func restHeader(sort: TaskSort, descending: Bool) -> String {
        switch sort {
        case .created:  return descending ? "Newest first" : "Oldest first"
        case .status:   return "By status"
        case .title:    return "By title"
        case .assignee: return "By assignee"
        }
    }

    // MARK: a row's second line

    /// The lock's two sentences — the web row's tooltips, word for word.
    public static let prerequisiteCancelled = "Prerequisite cancelled — resolve it"
    public static let waitingForPrerequisites = "Waiting for prerequisites"
    /// "Starts Sep 27, 9:00 AM" — the web row's scheduled-start marker.
    public static let startsPrefix = "Starts "
    public static let unassigned = "Unassigned"

    // MARK: the one menu (phone-only words, iOS menu grammar)

    public static let selectTasks = "Select Tasks"
    public static let viewAs = "View as"
    /// The two views — the web's segmented control, word for word.
    public static let tasksView = "Tasks"
    public static let batchesView = "Batches"
    public static let groupedByLabel = "Grouped by label"
    public static let sortBy = "Sort By"
    public static let filterByLabel = "Filter by Label…"

    // MARK: search

    public static let searchTasks = "Search tasks"
    public static let searchLabels = "Search labels"

    // MARK: labels and batches

    public static let labelsTitle = "Labels"
    public static let clearLabels = "Clear"
    public static let byLabel = "by label"
    /// A batch row's second line: how many are left, or that none are.
    public static func left(_ count: Int) -> String { count == 0 ? "All done" : "\(count.formatted()) left" }
    /// Under a capped batch table — the web's sentence.
    public static func showingLargest(_ shown: Int, of total: Int) -> String {
        "Showing the \(shown.formatted()) largest of \(total.formatted()) labels."
    }

    // MARK: selecting

    public static func selected(_ count: Int) -> String { "\(count.formatted()) selected" }
    public static let selectAll = "Select All"
    public static let deselectAll = "Deselect All"
    public static let run = "Run"
    public static let stop = "Stop"
    public static let setAssignee = "Set assignee"
    public static let delete = "Delete"

    // MARK: empty states — the web's sentences

    public static let noneReady = "No tasks are ready to run."
    public static let noneRunning = "No tasks are running."
    public static let noneInList = "No tasks in this list yet."
    public static let noneUnlisted = "No tasks without a list yet."
    public static let noneYet = "No tasks yet."
    public static func noneMatch(_ query: String) -> String { "No tasks match “\(query)”." }
    /// Batches with nothing to group — the web table's sentence.
    public static let noLabels = "No labels here yet. Agents add them when they file a task."
}
