import Foundation

/// The words the folder rows and folder pages say (docs/session-folders-move-design.md §3.3–3.4):
/// the two management entries a folder offers, the delete confirmation, and what a refused create,
/// rename or delete tells you. OrbitKit owns them so the entry points that ask the same question —
/// a folder row's long-press menu and a folder page's ⋯ — ask it in the same words, and so the
/// sentences can be read (and tested) without a device.
public enum SessionFolderCopy {
    // MARK: the management entries

    /// Long-press a folder row (or open a folder page's ⋯) and these are what it offers.
    public static let rename = "Rename…"
    public static let delete = "Delete Folder…"
    /// The list's ≡ menu, where a folder is made without moving a session into it. The Move panel
    /// offers the same entry under `SessionMoveCopy.newFolder`; this is that spelling. Its prompt
    /// and its refusal are the panel's too (`SessionMoveCopy`); only the message differs, since no
    /// session goes in with this one.
    public static let newFolder = SessionMoveCopy.newFolder
    public static let newFolderMessage = "It appears at the top of this list."

    // MARK: Rename…

    public static let renameTitle = "Rename Folder"
    public static let namePlaceholder = "Name"
    public static let save = "Save"
    public static let cancel = "Cancel"

    /// Rename… raised when the server refused the new name; `renameFailure` is why.
    public static let couldNotRename = "Couldn’t Rename Folder"

    /// Why a folder wasn't renamed, in one sentence. A name its workspace already has is refused
    /// with a 409 (the server's `UNIQUE (workspace_id, name)`) and said in so many words, as the
    /// Move panel says it; anything else is the server's own reason.
    public static func renameFailure(_ error: Error, name: String, workspace: String) -> String {
        if case APIError.http(let status, _) = error, status == 409 {
            return "There’s already a folder named “\(name)” in \(workspace). Choose another name."
        }
        return "The folder couldn’t be renamed: \(APIClient.failureReason(error))."
    }

    // MARK: Delete Folder…

    /// The confirmation's title: which folder is about to go (§3.4 — `Delete “<name>”?`).
    public static func deleteTitle(_ name: String) -> String { "Delete “\(name)”?" }

    /// The confirmation's body: what happens to what is inside it — nothing is deleted, the
    /// sessions go back to the list (§3.4).
    public static func deleteMessage(sessionCount: Int) -> String {
        sessionCount == 1
            ? "The 1 session in it moves back to the list. No session is deleted."
            : "The \(sessionCount) sessions in it move back to the list. No session is deleted."
    }

    /// The confirmation's confirm button — Delete Folder…'s own words, so the button and the entry
    /// that raised it read alike.
    public static let deleteConfirm = "Delete"

    /// Delete Folder… raised when the server refused; `deleteFailure` is why.
    public static let couldNotDelete = "Couldn’t Delete Folder"
    public static let ok = "OK"

    /// Why a folder wasn't deleted, in one sentence — the server's own reason.
    public static func deleteFailure(_ error: Error) -> String {
        "The folder couldn’t be deleted: \(APIClient.failureReason(error))."
    }
}
