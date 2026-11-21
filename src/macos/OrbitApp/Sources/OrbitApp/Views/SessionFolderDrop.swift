import SwiftUI
import OrbitKit
#if os(macOS)
import AppKit
import UniformTypeIdentifiers
#endif

// Dragging a session row onto a folder row, on the Mac: a shortcut for the Move panel's first group
// (docs/session-folders-move-design.md §4). Dropping a row on a folder row files it there; on a
// folder's page, dropping it on the title or the back button takes it out of the folder (No
// Folder). Either way it is `AppModel.moveSession`, the panel's own request and toast. The rules —
// which rows can be picked up, which targets take them — are `SessionFolderDrag`'s. The panel stays
// the complete way to move, to another workspace too; the phone keeps its long press and swipes, so
// none of this is drawn there.

/// The drag in flight in one list: the row picked up, and the target under the pointer that would
/// take it. A list holds one, as it holds its sheets.
@Observable
@MainActor
final class SessionDragState {
    /// A place to drop: one of the workspace's folders, or none (`folderID` nil — No Folder).
    struct Target: Equatable {
        let folderID: String?
    }

    private(set) var session: Session?
    /// The target under the pointer, while it would take the drop — the one that lights up.
    var hover: Target?

    #if os(macOS)
    /// The list's scroll view, found from inside a row (see `sessionDragSource`).
    @ObservationIgnored weak var scrollView: NSScrollView?
    @ObservationIgnored private var timer: Timer?
    #endif

    func begin(_ session: Session) {
        self.session = session
        hover = nil
        #if os(macOS)
        startAutoscroll()
        #endif
    }

    func end() {
        session = nil
        hover = nil
        #if os(macOS)
        timer?.invalidate()
        timer = nil
        #endif
    }

    /// What dropping the dragged row on `folderID` of `workspaceID` would do.
    func verdict(on folderID: String?, workspaceID: String, folders: [SessionFolder]) -> SessionFolderDrag.Verdict {
        guard let session else { return .refused }
        let known = Set(folders.filter { $0.workspaceId == workspaceID }.map(\.id))
        return SessionFolderDrag.verdict(sessionWorkspaceID: session.agent?.id ?? session.agentId,
                                         sessionFolderID: session.folderId,
                                         targetWorkspaceID: workspaceID, targetFolderID: folderID,
                                         knownFolderIDs: known)
    }

    #if os(macOS)
    /// Held near the list's top or bottom edge, a drag scrolls it, so the folders at the top are in
    /// reach from a row far down. A drag session tells the source nothing while it runs, so the
    /// pointer is read on a timer, which also ends the drag once the button is up — dropped
    /// anywhere, taken or not.
    private func startAutoscroll() {
        timer?.invalidate()
        let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.autoscrollTick() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func autoscrollTick() {
        guard NSEvent.pressedMouseButtons & 1 != 0 else {
            end()
            return
        }
        guard let scrollView, let window = scrollView.window, let document = scrollView.documentView else { return }
        let point = scrollView.convert(window.convertPoint(fromScreen: NSEvent.mouseLocation), from: nil)
        let height = scrollView.bounds.height
        guard point.x >= 0, point.x <= scrollView.bounds.width else { return }
        let downward = scrollView.isFlipped ? point.y : height - point.y
        let step = SessionFolderDrag.edgeScrollStep(pointerY: downward, top: 0, bottom: height)
        guard step != 0 else { return }
        let clip = scrollView.contentView
        let insets = scrollView.contentInsets
        var origin = clip.bounds.origin
        let lowest = -insets.top
        let highest = max(lowest, document.frame.height - clip.bounds.height + insets.bottom)
        origin.y = min(max(origin.y + (document.isFlipped ? step : -step), lowest), highest)
        guard origin.y != clip.bounds.origin.y else { return }
        clip.scroll(to: origin)
        scrollView.reflectScrolledClipView(clip)
    }
    #endif
}

#if os(macOS)
extension UTType {
    /// A session row in flight: the app's own type, so the composer and the image drops never read
    /// a dragged row as text or a file of theirs.
    static let orbitSessionRow = UTType(exportedAs: "app.orbit.session-row", conformingTo: .data)
}

/// A folder row, or a folder page's head, as a place to drop a session row. It takes only a row
/// that would move — not one already in that folder, not another workspace's — and only then
/// lights up; the drop is the Move panel's own request and toast.
private struct SessionFolderDropDelegate: DropDelegate {
    let target: SessionDragState.Target
    let workspaceID: String
    let drag: SessionDragState
    let app: AppModel

    private func takes(_ info: DropInfo) -> Bool {
        info.hasItemsConforming(to: [.orbitSessionRow])
            && drag.verdict(on: target.folderID, workspaceID: workspaceID, folders: app.sessionFolders) == .move
    }

    func validateDrop(info: DropInfo) -> Bool { takes(info) }

    func dropEntered(info: DropInfo) {
        if takes(info) { drag.hover = target }
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        DropProposal(operation: takes(info) ? .move : .forbidden)
    }

    func dropExited(info: DropInfo) {
        if drag.hover == target { drag.hover = nil }
    }

    func performDrop(info: DropInfo) -> Bool {
        guard takes(info), let session = drag.session else { return false }
        drag.end()
        app.moveSession(session.id, toFolder: target.folderID)
        return true
    }
}

/// Finds the scroll view a row is drawn in, for the drag's autoscroll.
private struct EnclosingScrollViewProbe: NSViewRepresentable {
    let drag: SessionDragState

    final class Probe: NSView {
        weak var drag: SessionDragState?
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let scrollView = enclosingScrollView { drag?.scrollView = scrollView }
        }
    }

    func makeNSView(context: Context) -> Probe {
        let probe = Probe()
        probe.drag = drag
        return probe
    }

    func updateNSView(_ probe: Probe, context: Context) {
        probe.drag = drag
    }
}
#endif

extension View {
    /// A session row that can be picked up and dropped on a folder (the Mac only): `enabled` is
    /// `SessionFolderDrag.draggable` for it.
    @ViewBuilder
    func sessionDragSource(_ session: Session, enabled: Bool, drag: SessionDragState) -> some View {
        #if os(macOS)
        if enabled {
            self
                .background(EnclosingScrollViewProbe(drag: drag))
                .onDrag {
                    drag.begin(session)
                    let provider = NSItemProvider()
                    provider.registerDataRepresentation(forTypeIdentifier: UTType.orbitSessionRow.identifier,
                                                        visibility: .ownProcess) { done in
                        done(Data(session.id.utf8), nil)
                        return nil
                    }
                    return provider
                }
                .opacity(drag.session?.id == session.id ? 0.5 : 1)
        } else {
            self
        }
        #else
        self
        #endif
    }

    /// A folder row (`folderID`), or a folder page's head (`folderID` nil, No Folder), as a place to
    /// drop a session row of `workspaceID` (the Mac only). Lit while it would take the row under the pointer.
    @ViewBuilder
    func sessionFolderDropTarget(folderID: String?, workspaceID: String, drag: SessionDragState,
                                 app: AppModel) -> some View {
        #if os(macOS)
        let target = SessionDragState.Target(folderID: folderID)
        self
            .background {
                if drag.hover == target {
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(Color.indigo.opacity(0.16))
                        .overlay {
                            RoundedRectangle(cornerRadius: 6, style: .continuous)
                                .strokeBorder(Color.indigo, lineWidth: 1.5)
                        }
                        .padding(.horizontal, -6)
                        .padding(.vertical, -3)
                }
            }
            .onDrop(of: [.orbitSessionRow],
                    delegate: SessionFolderDropDelegate(target: target, workspaceID: workspaceID, drag: drag, app: app))
        #else
        self
        #endif
    }
}
