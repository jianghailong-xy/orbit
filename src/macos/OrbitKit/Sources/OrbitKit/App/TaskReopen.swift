import Foundation

// Taking a stopped task back to Open, in place — the native half of the door the browser's task
// panel and the CLI open (`components/TaskDetailPanel.tsx`, `src/runner-go/task_reopen.go`).
//
// The words below are hand-mirrored from that panel's declarations and pinned by
// `TaskJudgmentCopyParityTests`, for the reason that file gives: the two clients share no compiler,
// so a sentence reworded at one end simply never appears at the other. One web string is
// deliberately NOT mirrored — the toast that confirms the write, which has no counterpart here
// because no task mutation in this app toasts; the row redrawing is the answer.

public enum TaskReopenCopy {
    /// The button, and the labels of the question it opens.
    public static let actionLabel = "Reopen task"
    public static let modalTitle = "Reopen this task?"
    public static let modalOK = "Reopen"

    /// What the write does, and what it deliberately leaves alone.
    public static let modalBody = "Reopening puts this task back to Open and changes nothing else: "
        + "its history, its evidence, its dependencies and the project it is filed under stay as they "
        + "are. It is how an attempt that stopped is picked up again as this task, rather than as a new "
        + "one filed beside it."

    /// Said only of a task filed under a project: the project's own status is a projection of the
    /// work under it, so this is the sentence that says reopening has a consequence outside the row.
    public static let modalProject = "If this task serves one of its project’s acceptance criteria, "
        + "the project stops reading as done while it is open again."

    /// Said only of a row that carries a retirement, and the reason this door exists: a replaced
    /// attempt cannot be run again until the record is gone.
    public static let modalRetired = "This attempt is recorded as superseded or dropped, and "
        + "reopening clears that record — a replaced attempt cannot be run again until it is gone."
}

/// Reopening a stopped task, in place.
public enum TaskReopen {
    /// The statuses the press is offered on: the work has stopped. The same three the browser's
    /// `REOPENABLE_STATUSES` lists — an open task is already open, and the verb there would be a
    /// second name for a state it is in.
    public static let statuses: Set<TaskStatus> = [.done, .cancelled, .failed]

    public static func isOffered(_ task: TaskItem) -> Bool { statuses.contains(task.status) }

    /// The question's sentences, in the order they are read. The two conditional ones are
    /// conditional because the two facts are — and an empty string reads as absent, so a server
    /// that spells "none" that way does not produce a sentence about nothing.
    public static func paragraphs(_ task: TaskItem?) -> [String] {
        var out = [TaskReopenCopy.modalBody]
        if task?.projectId?.isEmpty == false { out.append(TaskReopenCopy.modalProject) }
        if task?.terminalReason?.isEmpty == false { out.append(TaskReopenCopy.modalRetired) }
        return out
    }

    /// The write itself, spelled once for this client.
    ///
    /// `status: OPEN` alone is refused on a row that carries a retirement — the rows this door
    /// exists for — so both retirement fields go out as an explicit null in the SAME request, which
    /// is what `TasksService.update`'s SU4 guard asks for. The same three fields are spelled at the
    /// other doors (`src/runner-go/task_reopen.go` for MCP and the CLI, the browser's
    /// `reopenMutationOptions`), because they are three transports onto one server rule rather than
    /// three rules.
    public static var request: UpdateTaskRequest {
        UpdateTaskRequest(status: .open, supersededByTaskId: .clear, terminalReason: .clear)
    }
}
