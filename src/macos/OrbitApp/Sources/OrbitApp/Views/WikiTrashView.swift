import SwiftUI
import OrbitKit

// Trash (docs/mocks/wiki-trash ②): the wikis moved there, newest move first, each kept 365 days — pushed from Wiki
// settings' Trash row, the space menu's Trash and the empty Wiki's Open Trash. The web's Trash is a dialog over the
// page; here it is a page of its own, as the board draws it.
//
// A row is the wiki's name over when it was moved, what it holds and when it is deleted for good. Its two presses are
// the session Trash's: Restore, and Delete, which asks first. On iOS a swipe shows them; on the Mac a right-click.
// Every word is `WikiModeCopy`'s, which `WikiReviewModeCopyParityTests` holds to the web's and the fixture's.

/// Where a press in Trash goes.
struct WikiTrashActions {
    var restore: (WikiTrashRow) -> Void = { _ in }
    /// Delete permanently, once its question is answered.
    var purge: (WikiTrashRow) -> Void = { _ in }
}

/// Trash, drawn from its read: the rows, then the sentence that says how long a wiki stays.
struct WikiTrashPage: View {
    let rows: [WikiTrashRow]
    var busy = false
    var actions = WikiTrashActions()

    /// The row whose Delete is asking.
    @State private var purging: WikiTrashRow?

    var body: some View {
        List {
            Section {
                if rows.isEmpty {
                    Text(WikiModeCopy.trashPageEmpty).foregroundStyle(.secondary)
                }
                ForEach(rows) { row in self.row(row) }
            } footer: {
                Text(WikiModeCopy.trashPageLead)
            }
        }
        #if os(iOS)
        .listStyle(.insetGrouped)
        #else
        .listStyle(.inset)
        #endif
        .navigationTitle(WikiModeCopy.trashPageTitle)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .disabled(busy)
    }

    private func row(_ row: WikiTrashRow) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(row.title)
            Text(WikiModeCopy.trashRowLine(deletedAt: row.deletedAt, purgeAt: row.purgeAt, entries: row.entries))
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        #if os(iOS)
        // Delete outermost. It is tinted rather than given the destructive role: the press only asks, and the system
        // takes a destructive swipe's row away as it is pressed.
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(WikiModeCopy.trashDeleteSwipe) { purging = row }
                .tint(.red)
            Button(WikiModeCopy.trashRestore) { actions.restore(row) }
                .tint(.blue)
        }
        #else
        .contextMenu {
            Button(WikiModeCopy.trashRestore) { actions.restore(row) }
            Button(WikiModeCopy.trashDeletePermanently, role: .destructive) { purging = row }
        }
        #endif
        // On the row whose press raised it, so the panel opens against the row rather than at the top of the page.
        .orbitConfirmation(WikiModeCopy.trashPurgeQuestion,
                           isPresented: Binding(get: { purging?.id == row.id }, set: { if !$0 { purging = nil } })) {
            Button(WikiModeCopy.trashPurgeConfirm, role: .destructive) { actions.purge(row) }
            Button(WikiModeCopy.cancel, role: .cancel) {}
        } message: {
            Text(WikiModeCopy.trashPurgeBody(entries: row.entries))
        }
    }
}

/// The screen: Trash as the model last read it, read again as the page opens, and where a press goes. A restore says
/// so the way the app says what a press did; a refusal is the server's own sentence, under what was refused.
struct WikiTrashView: View {
    @Environment(AppModel.self) private var model

    @State private var notice: String?
    @State private var noticeTitle = WikiModeCopy.trashRestoreFailed

    var body: some View {
        if let wiki = model.wiki {
            WikiTrashPage(rows: wiki.trash, busy: wiki.busy, actions: actions(wiki))
                .task { await wiki.loadTrash() }
                .alert(noticeTitle, isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
                    Button("OK", role: .cancel) { notice = nil }
                } message: {
                    Text(notice ?? "")
                }
        } else {
            ProgressView()
        }
    }

    private func actions(_ wiki: WikiModel) -> WikiTrashActions {
        WikiTrashActions(
            restore: { row in
                let said = WikiModeCopy.restored(row.title)
                Task {
                    if let answer = await wiki.restoreSpace(row, restored: { model.showToast(said) }) {
                        noticeTitle = WikiModeCopy.trashRestoreFailed
                        notice = answer
                    }
                }
            },
            purge: { row in
                Task {
                    if let answer = await wiki.purgeSpace(row) {
                        noticeTitle = WikiModeCopy.trashPurgeFailed
                        notice = answer
                    }
                }
            })
    }
}
