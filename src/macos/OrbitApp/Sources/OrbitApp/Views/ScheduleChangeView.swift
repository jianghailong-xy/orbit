import SwiftUI
import OrbitKit

// A schedule's change conversation (docs/scheduled-tasks-design.md §8.2, docs/mocks/scheduled-tasks/03-change.png
// ② 3 and ③): Change… no longer opens a blank composer. `GET /schedules/:id/change` answers the schedule's open
// change conversation — go straight there — or the opening a new one would start with, drawn here as a draft: the
// strip naming the schedule, Orbit's first message (what it does now, and what can change at once or needs your
// Allow), and a composer whose first words open the session (`POST /schedules/:id/change`). The same opening is
// drawn at the head of the conversation itself (`ScheduleConsoleCard`), so the draft and the session read alike.
// The words and the rows are OrbitKit's (`ScheduleCopy.ChangeConversation`, `ScheduleDisplay.changeOpeningRows`),
// the web's `ScheduleChangePage.tsx` and `ScheduleChangeOpeningView` behave the same.

private typealias SC = ScheduleCopy

/// A change conversation's head: the strip naming the schedule, which opens it, and Orbit's opening — the
/// schedule as it was when the conversation was opened, and what can change at once or needs Allow (board ② 3).
struct ScheduleChangeOpeningView: View {
    @Environment(AppModel.self) private var model
    let opening: ScheduleChangeOpening

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            strip
            lead
            rows
            Text(SC.ChangeConversation.tail)
                .font(.orbitSubtext)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("schedule-change-opening")
    }

    /// 📅 **Codex stable check** · apiserver · Codex agent — Open returns to the schedule's detail panel.
    private var strip: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "calendar").foregroundStyle(Color.scheduleAccent)
            (Text(opening.title).bold() + Text("\(SC.separator)\(opening.runsIn)"))
                .lineLimit(2)
            Spacer(minLength: 8)
            Button(openLabel) { model.openSchedule(opening.scheduleId) }
                .buttonStyle(.plain)
                .foregroundStyle(Color.scheduleAccent)
                .accessibilityIdentifier("schedule-change-open-schedule")
        }
        .font(.orbitSubtext)
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    /// The phone's strip says Open, the Mac's — as the web's — Open in Scheduled.
    private var openLabel: String {
        #if os(iOS)
        SC.ChangeConversation.openSchedule
        #else
        SC.ChangeConversation.openInScheduled
        #endif
    }

    /// "What should change about **Codex stable check**? This is what it does now:" — the title in bold.
    private var lead: some View {
        let text = ScheduleDisplay.changeConversationLead(opening.title)
        let parts = text.components(separatedBy: opening.title)
        var out = Text("")
        for (index, part) in parts.enumerated() {
            out = out + Text(part)
            if index < parts.count - 1 { out = out + Text(opening.title).bold() }
        }
        return out
            .font(.orbitSubtext)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// The bordered key/value box: Does, When, Runs in, May, Costs.
    private var rows: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(ScheduleDisplay.changeOpeningRows(opening), id: \.label) { row in
                ScheduleFactRow(label: row.label) { Text(row.text) }
            }
        }
        .padding(14)
        .background(Color.scheduleCardFill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.scheduleCardEdge))
    }
}

/// The draft change conversation (board ② 3, ③): shown before any session exists. The person's first words open
/// the change conversation and the page gives way to it; a schedule that gained one meanwhile goes straight there.
struct ScheduleChangePage: View {
    @Environment(AppModel.self) private var model
    let scheduleID: String
    @State private var opening: ScheduleChangeOpening?
    @State private var failed = false
    @State private var words = ""
    @State private var sending = false
    @FocusState private var typing: Bool

    var body: some View {
        #if os(iOS)
        NavigationStack {
            bodyContent
                .navigationTitle(opening.map { ScheduleDisplay.changeConversationTitle($0.title) } ?? "")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { model.scheduled?.changeDraft = nil } label: {
                            Label(SC.Nav.scheduled, systemImage: "chevron.left")
                        }
                        .accessibilityIdentifier("schedule-change-back")
                    }
                }
        }
        #else
        bodyContent
        #endif
    }

    private var bodyContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    #if os(macOS)
                    // The web board ③: the title over the strip, as the Mac's right-hand panel.
                    if let opening {
                        Text(ScheduleDisplay.changeConversationTitle(opening.title))
                            .font(.title2.weight(.bold))
                    }
                    #endif
                    if let opening {
                        ScheduleChangeOpeningView(opening: opening)
                    } else if failed {
                        if let error = model.scheduled?.errorText {
                            Text(error).font(.orbitLabel).foregroundStyle(.red)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    } else {
                        ProgressView().frame(maxWidth: .infinity)
                    }
                }
                .padding(16)
            }
            if opening != nil { composer }
        }
        .background(Color.schedulePanelFill)
        .task(id: scheduleID) { await load() }
        .accessibilityIdentifier("schedule-change-page")
    }

    /// The composer, focused: "Say what to change…". The first words open the conversation.
    private var composer: some View {
        HStack(spacing: 10) {
            TextField(SC.ChangeConversation.placeholder, text: $words, axis: .vertical)
                .font(.orbitControl)
                .focused($typing)
                .submitLabel(.send)
                .disabled(sending)
                .onSubmit(send)
                .accessibilityIdentifier("schedule-change-composer")
            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.orbitControl.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(width: 30, height: 30)
                    .background(canSend ? Color.scheduleAccent : Color.secondary.opacity(0.35), in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .accessibilityIdentifier("schedule-change-send")
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(Color.scheduleCardFill)
        .overlay(alignment: .top) { Divider() }
    }

    private var canSend: Bool {
        !words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !sending
    }

    private func load() async {
        guard let scheduled = model.scheduled else { return }
        guard let answer = await scheduled.changeConversation(scheduleID) else {
            failed = true
            return
        }
        if let sessionID = answer.sessionId {
            // The schedule's change conversation is still open (another device opened one): go straight there.
            scheduled.changeDraft = nil
            model.route(to: .session(sessionID))
        } else {
            opening = answer.opening
            typing = true
        }
    }

    private func send() {
        guard let scheduled = model.scheduled, canSend else { return }
        let text = words.trimmingCharacters(in: .whitespacesAndNewlines)
        sending = true
        Task { @MainActor in
            if let answer = await scheduled.openChangeConversation(scheduleID, text: text) {
                scheduled.changeDraft = nil
                // `created` false: another device opened one meanwhile, and the server said the words there.
                model.route(to: .session(answer.sessionId))
            }
            sending = false
        }
    }
}
