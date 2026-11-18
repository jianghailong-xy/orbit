/// The shared mapping from a task lifecycle status to its pill style and label.
public enum ReferencedTaskNote {
    public static func pill(status: String) -> TaskPill {
        switch TaskStatus(rawValue: status) {
        case .done:       return TaskPill(kind: .done, label: "Done")
        case .inProgress: return TaskPill(kind: .inProgress, label: "In progress")
        case .open:       return TaskPill(kind: .open, label: "Open")
        case .failed:     return TaskPill(kind: .failed, label: "Failed")
        case .cancelled:  return TaskPill(kind: .cancelled, label: "Cancelled")
        case nil:         return TaskPill(kind: .open, label: status)
        }
    }

}
