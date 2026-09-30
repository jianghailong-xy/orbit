import Foundation

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   "CONFIRM THE NEW CRITERIA?" — THIS CLIENT'S HALF OF WEB'S `CriteriaChangeCard.tsx`
   ─────────────────────────────────────────────────────────────────────────────────────────────

   WHY ONLY THE CHANGES
   --------------------
   Two kinds of edit land without asking anybody once a project runs: a criterion ADDED, and a
   check made STRICTER (its verification method up the ladder, its words untouched). Each used to
   bring the whole confirmation card back — every criterion again, a button that read like starting
   the project over, and nothing saying which line had moved. So this card lists the changes the
   SERVER computed against what the confirmation stored (`changesSinceConfirmed` on the
   confirmation read) and numbers the rest; the whole set is one toggle away. A change landed some
   other way (an approved proposal, while the confirmation was already behind) is listed too, as
   changed, rather than counted among the unchanged. Nothing here compares two versions itself: a
   client that diffed the criteria would be making the card's central claim a conclusion IT
   reached, the rule `CriteriaProposalChange` states for the weakening card.

   NOTHING STOPS
   -------------
   The project keeps running while this waits: the confirmation gates DONE and nothing else, and the
   card says so. The press confirms the version standing now at the confirmation door, which for a
   started project only confirms; the receipt it leaves says "You confirmed", with what this press
   confirmed — how many new, how many stricter — after the seal.

   The words are `lib/projectStart.ts`'s; `CriteriaChangeCardCopyParityTests` reads them back.
   ───────────────────────────────────────────────────────────────────────────────────────────── */

// MARK: - the wire

/// A criterion stated since the confirmation.
public struct CriterionAddedSinceConfirmed: Codable, Equatable, Sendable {
    /// The criterion's own key, as `acceptanceCriteriaItems` spells it.
    public let key: String
    /// Where it stands in the list now, from 1.
    public let ordinal: Int
    public let text: String

    public init(key: String, ordinal: Int, text: String) {
        self.key = key
        self.ordinal = ordinal
        self.text = text
    }
}

/// A criterion whose words are the ones confirmed and whose check is stricter than the one that was.
public struct CriterionStricterSinceConfirmed: Codable, Equatable, Sendable {
    public let key: String
    public let ordinal: Int
    /// The check it has now.
    public let verificationMethod: String
    /// The check the owner confirmed — the card's "was: …".
    public let confirmedVerificationMethod: String

    public init(key: String, ordinal: Int, verificationMethod: String,
                confirmedVerificationMethod: String) {
        self.key = key
        self.ordinal = ordinal
        self.verificationMethod = verificationMethod
        self.confirmedVerificationMethod = confirmedVerificationMethod
    }
}

/// A criterion changed since the confirmation some other way: reworded, or its check rewritten or
/// loosened, which only an approved proposal lands.
public struct CriterionRevisedSinceConfirmed: Codable, Equatable, Sendable {
    public let key: String
    public let ordinal: Int
    /// Its words now.
    public let text: String

    public init(key: String, ordinal: Int, text: String) {
        self.key = key
        self.ordinal = ordinal
        self.text = text
    }
}

/// What changed in a project's criteria since the owner last confirmed them —
/// `@orbit/shared`'s `CriteriaChangesSinceConfirmed`. Every criterion that stands now is in exactly
/// one of `added`, `stricter`, `revised` and `unchanged`; `removed` names confirmed ones that no
/// longer stand.
public struct CriteriaChangesSinceConfirmed: Codable, Equatable, Sendable {
    public let added: [CriterionAddedSinceConfirmed]
    public let stricter: [CriterionStricterSinceConfirmed]
    public let revised: [CriterionRevisedSinceConfirmed]
    /// The keys of confirmed criteria that are no longer stated.
    public let removed: [String]
    /// The ordinals of the criteria that read exactly as they were confirmed.
    public let unchanged: [Int]

    public init(added: [CriterionAddedSinceConfirmed] = [],
                stricter: [CriterionStricterSinceConfirmed] = [],
                revised: [CriterionRevisedSinceConfirmed] = [], removed: [String] = [],
                unchanged: [Int] = []) {
        self.added = added
        self.stricter = stricter
        self.revised = revised
        self.removed = removed
        self.unchanged = unchanged
    }

    /// Decoded by hand, one field at a time: a server that adds a kind of change is a card that
    /// lists the ones it knows, never a confirmation read that fails to decode.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        added = (try? c.decodeIfPresent([CriterionAddedSinceConfirmed].self, forKey: .added)) ?? []
        stricter = (try? c.decodeIfPresent([CriterionStricterSinceConfirmed].self,
                                           forKey: .stricter)) ?? []
        revised = (try? c.decodeIfPresent([CriterionRevisedSinceConfirmed].self,
                                          forKey: .revised)) ?? []
        removed = (try? c.decodeIfPresent([String].self, forKey: .removed)) ?? []
        unchanged = (try? c.decodeIfPresent([Int].self, forKey: .unchanged)) ?? []
    }

    /// Whether anything moved at all. A set confirmed a moment ago has a list of changes, and every
    /// criterion in it is unchanged.
    public var isEmpty: Bool {
        added.isEmpty && stricter.isEmpty && revised.isEmpty && removed.isEmpty
    }
}

// MARK: - the words and the logic

public enum CriteriaChanges {

    public static let title = "Confirm the new criteria?"
    /// The list of changes, as a screen reader is told it — and, on a phone, the head over it.
    public static let whatChanged = "What changed"
    public static let newKind = "New"
    public static let stricterKind = "Stricter check"
    /// A criterion changed some other way — reworded, or its check rewritten — which only an
    /// approved proposal lands, and only while the confirmation was already behind.
    public static let revisedKind = "Changed"
    /// Where the project stands, as the meta line says it: running, and not held.
    public static let running = "running"
    public static let explains =
        "The project keeps running. Orbit marks it done only against criteria you’ve confirmed, so "
        + "until you confirm these it stays open even if every task finishes."
    public static let chatPlaceholder = "What should change about these?"

    /// The check a stricter criterion replaced, under the one it has now.
    public static func was(_ method: String) -> String {
        "was: \(method)"
    }

    /// "5 · New", "2 · Stricter check": which criterion, and what happened to it.
    public static func kind(_ ordinal: Int, _ kind: String) -> String {
        "\(ordinal) · \(kind)"
    }

    /// Which project, that it is running, how many criteria before and now, and the seal a press
    /// confirms.
    public static func meta(projectTitle: String, confirmedCount: Int, count: Int,
                            seal: String) -> String {
        "\(projectTitle) · \(running) · \(confirmedCount) → \(count) criteria · seal \(seal)"
    }

    /// The phone's head over the list: what it is, and how many rows it holds — the start card's
    /// section heads say their counts the same way (`StartProject.doneWhenHead`).
    public static func whatChangedHead(_ count: Int) -> String {
        "\(whatChanged) · \(count)"
    }

    /// The criteria that read as they were confirmed, by number — and the confirmed ones that are
    /// gone, counted, because no text of theirs is left to show.
    public static func unchanged(_ ordinals: [Int], removed: Int) -> String {
        let same = ordinals.isEmpty
            ? "" : "\(ordinals.map(String.init).joined(separator: ", ")) unchanged"
        let gone = removed == 0 ? "" : "\(removed) removed"
        return [same, gone].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    public static func showAll(_ count: Int) -> String {
        "Show all \(count)"
    }

    public static func confirmLabel(_ count: Int) -> String {
        "Confirm \(count) \(count == 1 ? "criterion" : "criteria")"
    }

    /// What a re-confirmation's receipt adds after the seal: what the new version changed, counted.
    public static func summary(added: Int, stricter: Int, revised: Int, removed: Int) -> String {
        [
            added > 0 ? "\(added) new" : "",
            stricter > 0 ? "\(stricter) stricter" : "",
            revised > 0 ? "\(revised) changed" : "",
            removed > 0 ? "\(removed) removed" : "",
        ].filter { !$0.isEmpty }.joined(separator: ", ")
    }

    /// How many of each change a press confirms: what its receipt says after the seal.
    public static func counts(_ changes: CriteriaChangesSinceConfirmed) -> String {
        summary(added: changes.added.count, stricter: changes.stricter.count,
                revised: changes.revised.count, removed: changes.removed.count)
    }

    /// Whether a conversation is asked this: a started, OPEN project with criteria and work, whose
    /// set moved since the confirmation on record — and the server said how. Web's
    /// `criteriaChangeHeld`, over the same facts the console reads off the same two documents.
    public static func held(_ standing: StandardSetConfirmationStanding?, projectStatus: String?,
                            criteriaCount: Int, taskCount: Int, started: Bool?) -> Bool {
        guard let standing, standing.state == .stale, standing.changesSinceConfirmed != nil
        else { return false }
        return projectStatus == "OPEN" && criteriaCount > 0 && taskCount > 0 && started == true
    }

    /// One row of the list: the mark, which criterion and what happened to it, the words it has
    /// now, and — for a stricter check — the check it replaced.
    public struct Row: Equatable, Sendable, Identifiable {
        public enum Mark: String, Equatable, Sendable {
            case new = "+"
            case stricter = "↑"
            case revised = "~"
        }

        public let id: String
        public let mark: Mark
        public let kind: String
        public let text: String
        public let was: String?

        public init(id: String, mark: Mark, kind: String, text: String, was: String? = nil) {
            self.id = id
            self.mark = mark
            self.kind = kind
            self.text = text
            self.was = was
        }
    }

    /// The rows, new first, then stricter, then changed — each group in the criteria's own order,
    /// numbered by the SERVER's ordinals: `5`, `2` tells a reader which criteria moved.
    public static func rows(_ changes: CriteriaChangesSinceConfirmed) -> [Row] {
        changes.added.sorted { $0.ordinal < $1.ordinal }.map {
            Row(id: "new:\($0.key)", mark: .new, kind: kind($0.ordinal, newKind), text: $0.text)
        }
        + changes.stricter.sorted { $0.ordinal < $1.ordinal }.map {
            Row(id: "stricter:\($0.key)", mark: .stricter, kind: kind($0.ordinal, stricterKind),
                text: $0.verificationMethod, was: was($0.confirmedVerificationMethod))
        }
        + changes.revised.sorted { $0.ordinal < $1.ordinal }.map {
            Row(id: "revised:\($0.key)", mark: .revised, kind: kind($0.ordinal, revisedKind),
                text: $0.text)
        }
    }

    /// The line under the list, for this set of changes.
    public static func unchangedLine(_ changes: CriteriaChangesSinceConfirmed) -> String {
        unchanged(changes.unchanged.sorted(), removed: changes.removed.count)
    }

    /// The meta line of the card drawn from this standing.
    public static func meta(_ standing: StandardSetConfirmationStanding,
                            projectTitle: String) -> String {
        meta(projectTitle: projectTitle,
             confirmedCount: standing.confirmation?.criteriaMaterial.count ?? 0,
             count: standing.currentVersion.material.count,
             seal: CriteriaDecisions.shortSeal(standing.currentVersion.digest))
    }

    /// Whether the card is still asking — what the needs-you bar counts: the standing is STALE and
    /// the server says how. A standing that could not be read leaves it open, for
    /// `AcceptanceConfirmations.isOpen`'s reason; one confirmed at another end closes it, and the
    /// card stays on screen, dimmed, over that confirmation's explanation.
    public static func isOpen(_ standing: StandardSetConfirmationStanding?) -> Bool {
        guard let standing else { return true }
        return standing.state == .stale && standing.changesSinceConfirmed != nil
    }

    /// The version a press confirms, or nil when there is none to confirm from here.
    public static func answerable(_ standing: StandardSetConfirmationStanding?) -> Bool {
        guard let standing else { return false }
        return isOpen(standing)
    }
}
