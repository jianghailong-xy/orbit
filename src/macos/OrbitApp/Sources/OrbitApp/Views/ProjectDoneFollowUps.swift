import SwiftUI
import PhotosUI
import OrbitKit

// MARK: - The done card's follow-ups

/// What the done card's follow-ups press, handed in by whoever draws the card — the project page
/// (`ProjectDetailModel`) or the coordinator conversation (`ConsoleModel`). A press left nil is not
/// drawn. Every write answers nil when it went through, or the sentence to show.
struct ProjectDoneFollowUpActions {
    /// Open, on a task holding an unmet criterion.
    var openTask: ((String) -> Void)? = nil
    /// Change, on the non-code banner: the project page's Delivers row.
    var openDelivers: (() -> Void)? = nil
    /// Move to a follow-up… — the owner's alone.
    var move: ((_ criterionKey: String, _ body: MoveCriterionBody) async -> String?)? = nil
    /// The open projects a criterion can move to.
    var openProjects: (() async -> [ProjectSummary])? = nil
    /// The Confirm sheet's press, and the screenshot it is given with.
    var confirm: ((_ criterionID: String, _ body: ConfirmCriterionBody) async -> String?)? = nil
    var upload: ((_ data: Data, _ filename: String, _ mimeType: String) async throws -> String)? = nil
}

/// The non-code banner (decided board ③ A): what the mark means, who set it and when, and Change.
struct NonCodeBanner: View {
    let mark: NonCodeMark?
    var onChange: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "info.circle").foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 3) {
                (Text(ProjectDone.nonCodeLead).bold() + Text(" \(ProjectDone.nonCodeBody)")
                    + Text(ProjectDone.nonCodeProvenance(mark).map { " \($0)" } ?? ""))
                    .fixedSize(horizontal: false, vertical: true)
                if let onChange {
                    Button(ProjectDone.nonCodeChange, action: onChange)
                        .linkButtonStyle()
                        .accessibilityIdentifier("non-code-change")
                }
                if let reason = ProjectDone.nonCodeReasonLine(mark) {
                    Text(reason).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .font(.orbitLabel)
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.green.opacity(0.45)))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("non-code-banner")
    }
}

/// What the done check found, grouped the way the decided board ③ draws it: what stands in the way
/// — each unmet criterion naming its open tasks with Open, and Move to a follow-up…; then the other
/// refusals — and apart from it what Orbit cannot prove about where work landed.
struct DoneFindingsView: View {
    let subject: ProjectDoneSubject
    let findings: [ProjectDoneFinding]
    var openTask: ((String) -> Void)? = nil
    var onMove: ((ProjectDoneFinding) -> Void)? = nil

    var body: some View {
        let grouped = ProjectDone.Findings(findings)
        VStack(alignment: .leading, spacing: 8) {
            if let heading = grouped.blockingHeading {
                VStack(alignment: .leading, spacing: 8) {
                    Text(heading).bold()
                    ForEach(Array(grouped.unmet.enumerated()), id: \.offset) { _, finding in
                        unmetRow(finding)
                    }
                    ForEach(Array(grouped.otherRefusals.enumerated()), id: \.offset) { _, finding in
                        Text(finding.line(main: subject.main))
                    }
                }
                .font(.orbitLabel)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.red.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.red.opacity(0.3)))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("done-blockers")
            }
            if let heading = grouped.warningsHeading {
                VStack(alignment: .leading, spacing: 3) {
                    Text(heading).bold()
                    ForEach(Array(grouped.warnings.enumerated()), id: \.offset) { _, finding in
                        Text(finding.line(main: subject.main)).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .font(.orbitLabel)
                .foregroundStyle(ProjectPalette.warningInk)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.orange.opacity(0.09), in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.orange.opacity(0.35)))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("done-findings")
            }
            Text(grouped.explanation)
                .font(.orbitLabel).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func unmetRow(_ finding: ProjectDoneFinding) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("\(finding.criterion?.ordinal ?? 0)").monospacedDigit().foregroundStyle(.secondary)
                Text(finding.line(main: subject.main,
                                  confirmation: ProjectDone.confirmationMode(finding, subject: subject)))
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(finding.tasks, id: \.taskId) { task in
                HStack(alignment: .center, spacing: 8) {
                    Circle().fill(Color.orange).frame(width: 6, height: 6)
                    Text(task.title.isEmpty ? task.taskId : task.title)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 4)
                    if let openTask {
                        Button(ProjectDone.cardOpen) { openTask(task.taskId) }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .accessibilityIdentifier("done-open-\(task.taskId)")
                    }
                }
                .padding(8)
                .background(Color(light: .white, dark: Color.black.opacity(0.25)), in: RoundedRectangle(cornerRadius: 8))
            }
            if let onMove, let ordinal = finding.criterion?.ordinal {
                HStack(alignment: .center, spacing: 8) {
                    Button(ProjectDone.moveToFollowUp) { onMove(finding) }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .accessibilityIdentifier("done-move-\(ordinal)")
                    Text(ProjectDone.moveHint(ordinal))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

/// Board 02 G: the criteria this project moved out — "Criterion 4 moved to <project> by you · <when>".
struct MovedOutLines: View {
    let movedOut: [CriterionMovedOut]
    var openProject: ((String) -> Void)? = nil

    var body: some View {
        ForEach(movedOut) { moved in
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(ProjectDone.movedOutLead(moved)).foregroundStyle(.secondary)
                if let openProject {
                    Button(moved.toProjectTitle) { openProject(moved.toProjectId) }.linkButtonStyle()
                } else {
                    Text(moved.toProjectTitle)
                }
                Text(ProjectDone.movedByLine(moved.movedAt)).foregroundStyle(.secondary)
            }
            .font(.orbitLabel)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

// MARK: - Move to a follow-up…

/// The criterion the done card offers to move, and what the sheet needs to say about the rest.
struct MoveCriterionSubject: Identifiable {
    let projectTitle: String
    let criterionKey: String
    let ordinal: Int
    let text: String
    let openTasks: [ProjectDoneFinding.Task]
    let keeps: Int
    let keepsAllMet: Bool
    let currentProjectID: String?

    var id: String { criterionKey }

    init(subject: ProjectDoneSubject, finding: ProjectDoneFinding) {
        let key = finding.criterion?.key ?? ""
        let item = subject.criterion(key)
        let others = (subject.derivedDone?.criteria ?? []).filter { $0.definitionId != item?.id }
        projectTitle = subject.title
        criterionKey = key
        ordinal = finding.criterion?.ordinal ?? item?.ordinal ?? 0
        text = finding.criterion?.text.isEmpty == false ? finding.criterion!.text : (item?.text ?? "")
        openTasks = finding.tasks
        keeps = others.count
        keepsAllMet = others.allSatisfy(\.satisfied)
        currentProjectID = subject.projectID
    }
}

/// "Move to a follow-up…" (board 02 ②–④): one sheet, two steps. The first says what moves, what
/// stays and where to; the second says what each project becomes, and its press is the move.
struct MoveCriterionSheet: View {
    let subject: MoveCriterionSubject
    let move: (_ criterionKey: String, _ body: MoveCriterionBody) async -> String?
    var openProjects: (() async -> [ProjectSummary])? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var confirming = false
    @State private var newProject = true
    @State private var title = ""
    @State private var search = ""
    @State private var picked: ProjectSummary?
    @State private var projects: [ProjectSummary] = []
    @State private var moving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                if confirming { confirmStep } else { pickStep }
            }
            .formStyle(.grouped)
            .navigationTitle(ProjectDone.moveTitle)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if confirming {
                        Button(ProjectDone.moveBack) { confirming = false }.disabled(moving)
                    } else {
                        Button(ProjectDone.moveCancel) { dismiss() }
                    }
                }
                if !confirming {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(ProjectDone.moveNext) { confirming = true }
                            .disabled(!ready)
                            .accessibilityIdentifier("move-next")
                    }
                }
            }
        }
        .onAppear { if title.isEmpty { title = ProjectDone.moveFollowUpTitle(subject.projectTitle) } }
        .task {
            let all = await openProjects?() ?? []
            projects = all.filter { $0.status == .open && $0.id != subject.currentProjectID }
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 520)
        #endif
    }

    private var ready: Bool {
        newProject ? !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty : picked != nil
    }

    private var destination: String {
        newProject ? title.trimmingCharacters(in: .whitespacesAndNewlines) : (picked?.title ?? "")
    }

    @ViewBuilder
    private var pickStep: some View {
        Section(ProjectDone.moveMoves) {
            HStack(alignment: .top, spacing: 8) {
                Text("\(subject.ordinal)").monospacedDigit().bold()
                Text(subject.text).fixedSize(horizontal: false, vertical: true)
            }
            if !subject.openTasks.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text(ProjectDone.moveTasksPhrase(subject.openTasks.count)).foregroundStyle(.secondary)
                    ForEach(subject.openTasks, id: \.taskId) { task in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Circle().fill(Color.orange).frame(width: 6, height: 6)
                            Text(task.title.isEmpty ? task.taskId : task.title)
                        }
                    }
                }
                .font(.orbitLabel)
            }
        }
        Section {
            Text("\(ProjectDone.moveStays) \(ProjectDone.moveKeepsLine(subject.keeps, allMet: subject.keepsAllMet))")
                .font(.orbitLabel).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        Section(ProjectDone.moveTo) {
            Picker(ProjectDone.moveTo, selection: $newProject) {
                Text(ProjectDone.moveNewProject).tag(true)
                Text(ProjectDone.moveExistingProject).tag(false)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            if newProject {
                TextField(ProjectDone.moveNewProject, text: $title, axis: .vertical)
                Text(ProjectDone.moveNewHint)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                TextField(ProjectDone.moveSearch, text: $search)
                let shown = projects.filter {
                    search.isEmpty || $0.title.localizedCaseInsensitiveContains(search.trimmingCharacters(in: .whitespaces))
                }
                ForEach(shown) { row in
                    Button {
                        picked = row
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(row.title).foregroundStyle(.primary)
                                Text(ProjectDone.moveProjectTasks.replacingOccurrences(of: "{n}", with: String(row.taskCount)))
                                    .font(.orbitLabel).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if picked?.id == row.id { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                Text(projects.isEmpty ? ProjectDone.moveNoOpenProjects : ProjectDone.moveOpenOnly)
                    .font(.orbitLabel).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var confirmStep: some View {
        Section {
            Text(ProjectDone.moveConfirmTitle(subject.ordinal, project: destination))
                .font(.orbitProse.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            Text(ProjectDone.moveKeepsLine(subject.keeps, allMet: subject.keepsAllMet, confirming: true))
                .fixedSize(horizontal: false, vertical: true)
            Text(ProjectDone.moveConfirmDestination(destination, ordinal: subject.ordinal,
                                                    openTasks: subject.openTasks.count, newProject: newProject))
                .fixedSize(horizontal: false, vertical: true)
            Text(ProjectDone.moveConfirmRecord)
                .font(.orbitLabel).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        Section {
            Button {
                Task { await press() }
            } label: {
                Text(ProjectDone.moveConfirmAction(subject.ordinal)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(moving)
            .accessibilityIdentifier("move-confirm")
            if let error {
                Text("\(ProjectDone.moveNotMoved) — \(error)").font(.orbitLabel).foregroundStyle(.red)
            }
        }
    }

    private func press() async {
        guard !moving else { return }
        moving = true
        defer { moving = false }
        let body: MoveCriterionBody = newProject
            ? .new(title: destination, goal: ProjectDone.moveFollowUpGoal(subject.projectTitle, ordinal: subject.ordinal))
            : .existing(picked?.id ?? "")
        if let refused = await move(subject.criterionKey, body) {
            error = refused
        } else {
            dismiss()
        }
    }
}

// MARK: - the Confirm sheet

/// The criterion a Confirm sheet confirms.
struct ConfirmCriterionSubject: Identifiable {
    let criterionID: String
    let ordinal: Int
    let text: String
    let verificationMethod: String?
    let revision: Int?

    var id: String { criterionID }
}

/// The Confirm sheet (board 03 ④): the criterion and how it is checked on top, then the optional
/// "What did you check?" and one optional screenshot. The server keeps who and when.
struct ConfirmCriterionSheet: View {
    let subject: ConfirmCriterionSubject
    let confirm: (_ criterionID: String, _ body: ConfirmCriterionBody) async -> String?
    var upload: ((_ data: Data, _ filename: String, _ mimeType: String) async throws -> String)? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var note = ""
    @State private var photo: PhotosPickerItem?
    @State private var shotID: String?
    @State private var uploading = false
    @State private var shotError: String?
    @State private var sending = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(subject.text).fixedSize(horizontal: false, vertical: true)
                        if let method = subject.verificationMethod, !method.isEmpty {
                            Text("\(ProjectDone.confirmSheetHowChecked) \(method)")
                                .font(.orbitLabel).foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                Section {
                    TextField(ProjectDone.confirmSheetPlaceholder, text: $note, axis: .vertical)
                        .lineLimit(3...6)
                        .accessibilityIdentifier("confirm-note")
                } header: {
                    Text("\(ProjectDone.confirmSheetWhatChecked) · \(ProjectDone.confirmSheetOptional)")
                }
                if upload != nil {
                    Section {
                        if shotID != nil {
                            HStack {
                                Label(ProjectDone.confirmSheetScreenshot, systemImage: "photo")
                                Spacer()
                                Button(ProjectDone.confirmSheetRemove) { shotID = nil; photo = nil }
                                    .linkButtonStyle()
                            }
                        } else {
                            PhotosPicker(selection: $photo, matching: .images) {
                                Label(uploading ? ProjectDone.confirmSheetUploading : ProjectDone.confirmSheetAttach,
                                      systemImage: "plus")
                            }
                            .disabled(uploading || sending)
                        }
                        if let shotError {
                            Text("\(ProjectDone.confirmSheetNotUploaded) — \(shotError)")
                                .font(.orbitLabel).foregroundStyle(.red)
                        }
                    } header: {
                        Text("\(ProjectDone.confirmSheetScreenshot) · \(ProjectDone.confirmSheetOptional)")
                    } footer: {
                        Text(ProjectDone.confirmSheetFootnote)
                    }
                } else {
                    Section { } footer: { Text(ProjectDone.confirmSheetFootnote) }
                }
                if let error {
                    Text("\(ProjectDone.confirmSheetNotRecorded) — \(error)").font(.orbitLabel).foregroundStyle(.red)
                }
            }
            .formStyle(.grouped)
            .navigationTitle(ProjectDone.confirmSheetTitle(subject.ordinal))
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(ProjectDone.confirmSheetCancel) { dismiss() }.disabled(sending)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(ProjectDone.confirmSheetConfirm) { Task { await press() } }
                        .disabled(sending || uploading)
                        .accessibilityIdentifier("confirm-press")
                }
            }
            .onChange(of: photo) { _, item in
                guard let item, let upload else { return }
                Task { await take(item, upload) }
            }
        }
        #if os(macOS)
        .frame(minWidth: 440, minHeight: 420)
        #endif
    }

    private func take(_ item: PhotosPickerItem,
                      _ upload: (Data, String, String) async throws -> String) async {
        uploading = true
        defer { uploading = false }
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else { return }
            shotID = try await upload(data, "screenshot.png", "image/png")
            shotError = nil
        } catch {
            shotError = APIClient.failureReason(error)
        }
    }

    private func press() async {
        guard !sending else { return }
        sending = true
        defer { sending = false }
        let body = ConfirmCriterionBody(note: note, revision: subject.revision, attachmentIds: shotID.map { [$0] })
        if let refused = await confirm(subject.criterionID, body) {
            error = refused
        } else {
            dismiss()
        }
    }
}
