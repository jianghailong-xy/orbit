import Foundation

/// The queue a waiting merge is in (§2.2 J1), in the words both clients draw it in.
///
/// Mirrors web's `lib/projectMerge.ts` queue block word for word — `ProjectMergeCopyParityTests`
/// reads that file — so the phone and the page say one thing about one queue. The queue belongs to
/// the repository and the target ref: a landing claim is serialised per repository-and-ref, so the
/// row ahead of a project's merge can be another project's, and the card that says "queued 70m" has
/// to be able to say what it is queued behind.
public enum PromotionQueueCards {
    /// The chip a queue row carries when it is the asking owner's own merge.
    public static let queueYou = "You"
    /// The chip a queue row carries when the Automatic setting confirmed it rather than a press (M-T11).
    public static let queueAutomatic = "Automatic"

    /// `Queue for main` — the sheet's title: the line this queue is the queue FOR.
    public static func title(_ upstreamRef: String) -> String {
        "Queue for \(PromotionCards.shortRef(upstreamRef))"
    }

    /// `1 running · 3 waiting` — the queue in two numbers.
    public static func summary(_ queue: ProjectIntegrationQueue) -> String {
        "\(queue.running) running · \(queue.waiting) waiting"
    }

    /// `2nd of 4 for main` — where one job stands; nil when it is not in the queue at all.
    public static func position(_ jobId: String, in queue: ProjectIntegrationQueue) -> String? {
        guard let index = queue.jobs.firstIndex(where: { $0.jobId == jobId }),
              let target = queue.targetRef else { return nil }
        return "\(ordinal(index + 1)) of \(queue.jobs.count) for \(PromotionCards.shortRef(target))"
    }

    /// `1st`, `2nd`, `3rd`, `4th`… A position is read, not counted, so it is spelled.
    static func ordinal(_ n: Int) -> String {
        let rest = n % 100
        let suffix = rest >= 11 && rest <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10]
        return "\(n)\(suffix)"
    }

    /// How a queue row names one job. Another account's work is not named, and says so.
    public static func jobTitle(_ job: ProjectIntegrationQueueJob) -> String {
        if let title = job.title { return "“\(title)”" }
        let word = (ProjectPage.integrationJobWords[job.kind] ?? "Integration").lowercased()
        return job.mine ? "Your \(word)" : "Another account’s \(word)"
    }

    /// `Merge to main · fetching` — the row's kind and what the runner is doing, or that it waits.
    public static func jobStatus(_ job: ProjectIntegrationQueueJob) -> String {
        let word = ProjectPage.integrationJobWords[job.kind] ?? "Integration"
        guard job.state == "RUNNING" else { return "\(word) · queued" }
        return "\(word) · \(job.phase.flatMap { ProjectPage.integrationPhaseWords[$0] } ?? "running")"
    }

    /// How long a job has been waiting or at work: enqueue to claim for a queued one, claim to the
    /// last report for a running one — the same two instants the row's own clock counts from.
    public static func jobSpan(_ job: ProjectIntegrationQueueJob, now: Date = Date()) -> String {
        guard let from = RelativeTime.parse(job.startedAt ?? job.enqueuedAt) else { return "—" }
        return RelativeTime.span(Swift.max(0, now.timeIntervalSince(from)))
    }

    /// `no report for 2h 3m — it may be stuck`, or nil for a job that is not silent. The claim's own
    /// lease window, said in words (`INTEGRATION_CLAIM_STALE_MS`, worked out by the server).
    public static func jobStaleClause(_ job: ProjectIntegrationQueueJob, now: Date = Date()) -> String? {
        job.stale ? "no report for \(jobSpan(job, now: now)) — it may be stuck" : nil
    }

    /// The one line a waiting merge carries about the queue: who is ahead of it and what that one is
    /// doing — or nil when nothing is ahead (this merge is the head) or the queue is unreadable.
    ///
    /// The stale head is the reason this sentence has two shapes: a head that has gone quiet is not
    /// "running first", and the reader is owed the difference.
    public static func waitLine(_ jobId: String, in queue: ProjectIntegrationQueue,
                                now: Date = Date()) -> String? {
        guard let index = queue.jobs.firstIndex(where: { $0.jobId == jobId }), index > 0,
              let head = queue.jobs.first, let target = queue.targetRef else { return nil }
        let into = PromotionCards.shortRef(target)
        let what: String
        if let title = head.title {
            what = head.kind == "LAND_TASK" ? "the landing of “\(title)”" : "“\(title)”"
        } else if head.mine {
            what = head.kind == "LAND_TASK" ? "a landing" : "a merge to main"
        } else {
            what = head.kind == "LAND_TASK"
                ? "another account’s landing" : "another account’s merge to main"
        }
        if let stale = jobStaleClause(head, now: now) {
            return "Waiting to merge: \(what) has \(stale)"
        }
        return "Waiting to merge: \(what) is running on \(into) first"
    }
}
