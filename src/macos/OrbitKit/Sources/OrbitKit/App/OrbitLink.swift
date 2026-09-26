import Foundation

// Which links in a conversation point at an object in THIS deployment, and at which object.
//
// Two sources, one answer. A person pastes a page URL of the deployment they are talking to
// (`/sessions/<id>`, `/tasks/<id>`, `/projects/<id>`, `/lists/<key>`), and an agent writes a
// reference — `[名字](orbit-task:<id>)` — which is what delivery's own instructions ask it to write.
// Both are read here, and both come out as an `OrbitLinkTarget`: a kind, and an id canonicalised to
// the one spelling the rest of this client compares with.
//
// Only page URLs are read from prose, and this is the whole of the page table the deployment
// serves. `/api/…`, `/dl/…`, `/install`, `/s/…` and every other path are deliberately not here: a
// person who pastes `/api/runner/tasks/<id>` is usually quoting an error log, and a card would
// replace the evidence with a summary of it.
//
// Deliberately NOT `OrbitApp`'s LinkDetection, which answers a different question (what a tap on a
// link should do, including links this app cannot open at all). This one is pure, has no view
// dependencies, and is testable on Linux — the same reason the rest of this directory is.

/// Which object a link names.
public struct OrbitLinkTarget: Equatable, Hashable, Sendable {
    public let kind: OrbitLinkKind
    /// The canonical spelling: a lowercase UUID, whichever of the two spellings the link used.
    ///
    /// Compared, cached and stored under this and never under what was written: the two spellings of
    /// one id are one object, and comparing spellings instead of ids is the silent miss this client
    /// has already paid for once (an attachment's `orbit-attachment:<id>` matched neither way).
    public let id: String

    public init(kind: OrbitLinkKind, id: String) {
        self.kind = kind
        self.id = id
    }

    /// The key the store caches under — `kind:uuid`.
    public var key: String { LinkPreviews.key(kind: kind, id: id) }
}

/// Where the link was written, kept verbatim so the card can show what it replaced and a long press
/// can hand back what was copied.
public enum OrbitLinkSource: Equatable, Sendable {
    /// The page URL exactly as it appeared.
    case pageURL(String)
    /// The reference exactly as it appeared: `orbit-task:<id>`.
    case reference(String)

    /// The id as the link spelled it — the mono hint under a card, before canonicalisation.
    public var writtenID: String {
        switch self {
        case .pageURL(let url):
            let withoutQuery = url.prefix { $0 != "?" && $0 != "#" }
            return withoutQuery.split(separator: "/").last.map(String.init) ?? ""
        case .reference(let text):
            return text.split(separator: ":", maxSplits: 1).last.map(String.init) ?? ""
        }
    }
}

/// A link that became a card: the object, and the text it replaced.
public struct OrbitLinkRef: Equatable, Sendable {
    public let target: OrbitLinkTarget
    public let source: OrbitLinkSource

    public init(target: OrbitLinkTarget, source: OrbitLinkSource) {
        self.target = target
        self.source = source
    }

    public var kind: OrbitLinkKind { target.kind }
    public var id: String { target.id }
}

// MARK: - reading a link

public enum OrbitLinkParser {
    /// The one host a link has to name for a card: the server this client is signed in to
    /// (`APIClient.baseURL`). Accepts either an authority (`orbitd.io`, `localhost:3000`) or a whole
    /// URL, since the caller holds one or the other depending on where it read it.
    private struct Host {
        let name: String
        let port: Int?

        init(_ raw: String) {
            var text = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            var scheme: String?
            if let marker = text.range(of: "://") {
                scheme = String(text[text.startIndex..<marker.lowerBound])
                text = String(text[marker.upperBound...])
            }
            text = String(text.prefix { $0 != "/" && $0 != "?" && $0 != "#" })
            if let at = text.lastIndex(of: "@") { text = String(text[text.index(after: at)...]) }
            let split = OrbitLinkParser.splitPort(text)
            name = split.host
            // An explicitly spelled default port is no port at all: `https://orbitd.io:443` and
            // `https://orbitd.io` are the same server.
            port = split.port == OrbitLinkParser.defaultPort(scheme) ? nil : split.port
        }
    }

    /// The page a link names, or nil for anything this deployment's cards do not cover.
    ///
    /// The query and the fragment are ignored entirely, which is what makes `/tasks/<id>?list=<key>`
    /// a task card: what a path with parameters names is still the object in its path.
    public static func target(forPageURL url: String, host: String) -> OrbitLinkTarget? {
        guard let parts = splitAbsoluteURL(url) else { return nil }
        let expected = Host(host)
        guard parts.host == expected.name else { return nil }
        // A port is part of which server this is, and the two are compared as written: a link that
        // spells a port out where the reader's own server spells none is another server.
        guard parts.port == expected.port else { return nil }
        let segments = parts.path.split(separator: "/").map(String.init)
        return target(segments: segments)
    }

    /// The path table. Everything else — `/api/…`, `/dl/…`, `/install`, `/s/…`, the deployment's
    /// own pages — is not a link to an object.
    private static func target(segments: [String]) -> OrbitLinkTarget? {
        func target(_ kind: OrbitLinkKind, _ raw: String?) -> OrbitLinkTarget? {
            guard let raw, let id = PublicID.toUUID(raw) else { return nil }
            return OrbitLinkTarget(kind: kind, id: id)
        }
        switch segments.count {
        case 2:
            switch segments[0] {
            case "tasks":    return target(.task, segments[1])
            case "sessions": return target(.session, segments[1])
            case "projects": return target(.project, segments[1])
            // `none` is the app's own scope for "no list", not a list a card could draw.
            case "lists":    return segments[1] == "none" ? nil : target(.list, segments[1])
            default:         return nil
            }
        // The pre-1.0 spellings, still in links people have pasted: both name a session.
        case 4 where segments[2] == "sessions" && (segments[0] == "workspaces" || segments[0] == "agents"):
            return target(.session, segments[3])
        default:
            return nil
        }
    }

    /// The reference form an agent writes: `orbit-(task|session|project|list|wiki):<id>`. A wiki
    /// entry is reached ONLY this way: its page URL names a space as well, so the path table above
    /// leaves `/wiki/…` to stay the URL it is (the shared fixture's last case).
    public static func target(forReference reference: String) -> OrbitLinkTarget? {
        let prefix = "orbit-"
        guard reference.hasPrefix(prefix) else { return nil }
        let rest = reference.dropFirst(prefix.count)
        guard let colon = rest.firstIndex(of: ":") else { return nil }
        let kindName = String(rest[rest.startIndex..<colon])
        let raw = String(rest[rest.index(after: colon)...])
        guard let kind = OrbitLinkKind(rawValue: kindName), let id = PublicID.toUUID(raw) else {
            return nil
        }
        return OrbitLinkTarget(kind: kind, id: id)
    }

    /// The card's link back to the deployment's own page for an object — the destination a project
    /// with no coordinator session falls back to, and the `Open in Safari` / `Copy link` target on
    /// every card.
    ///
    /// A wiki entry's page is its space's and its own together (`/wiki/<space>/e/<id>`), and only
    /// the server's answer names the space: with no `wikiSpaceSlug` there is no page to give, and nil
    /// is the answer — `/wiki/<id>` is not a page this deployment serves.
    public static func pageURL(for target: OrbitLinkTarget, baseURL: URL,
                               wikiSpaceSlug: String? = nil) -> URL? {
        var base = baseURL.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        // The public spelling, which is what the deployment's own routes are written in: either
        // spelling is accepted by the API, but a URL a person copies should be the one the app
        // itself would produce.
        let id = PublicID.toPublic(target.id)
        if target.kind == .wiki {
            guard let slug = wikiSpaceSlug, !slug.isEmpty else { return nil }
            return URL(string: "\(base)/\(target.kind.pathSegment)/\(slug)/e/\(id)")
        }
        return URL(string: "\(base)/\(target.kind.pathSegment)/\(id)")
    }

    // MARK: URL splitting

    /// `scheme://host:port/path` split by hand rather than through `URL`, which on Linux Foundation
    /// is lenient in ways that would let a malformed link through as a valid one.
    static func splitAbsoluteURL(_ url: String) -> (host: String, port: Int?, path: String)? {
        guard let scheme = url.range(of: "://") else { return nil }
        let name = url[url.startIndex..<scheme.lowerBound].lowercased()
        guard name == "http" || name == "https" else { return nil }
        let rest = url[scheme.upperBound...]
        let authorityAndPath = rest.prefix { $0 != "?" && $0 != "#" }
        let authority = authorityAndPath.prefix { $0 != "/" }
        let path = authorityAndPath.dropFirst(authority.count)
        guard !authority.isEmpty else { return nil }
        let split = splitPort(String(authority).lowercased())
        let port = split.port == defaultPort(name) ? nil : split.port
        return (split.host, port, String(path))
    }

    /// The port a scheme serves by default, which is the one spelling a URL of it needs no port
    /// for. Nil for a scheme this client never builds a link with.
    static func defaultPort(_ scheme: String?) -> Int? {
        switch scheme {
        case "http":  return 80
        case "https": return 443
        default:      return nil
        }
    }

    /// A host and the port it names, if any. An IPv6 literal keeps its brackets.
    static func splitPort(_ authority: String) -> (host: String, port: Int?) {
        guard let colon = authority.lastIndex(of: ":") else { return (authority, nil) }
        let digits = authority[authority.index(after: colon)...]
        guard !digits.isEmpty, digits.allSatisfy(\.isNumber), let port = Int(digits) else {
            return (authority, nil)   // an IPv6 literal, or no port at all
        }
        return (String(authority[authority.startIndex..<colon]), port)
    }
}

// MARK: - finding page URLs in prose

/// One bare page URL of this deployment, and the text it occupies.
public struct OrbitLinkMatch: Equatable, Sendable {
    /// The whole span the card replaces — including the angle brackets of `<https://…>`, which is
    /// the form a person gets when they paste a link into a markdown field.
    public let range: Range<String.Index>
    /// The URL itself, without those brackets.
    public let url: String
    public let ref: OrbitLinkRef
}

public enum OrbitLinkScanner {
    /// Every bare page URL of this deployment in `text`, left to right.
    ///
    /// A URL only counts as bare when it stands as its own token: whitespace, the start of the text,
    /// an opening bracket or the `<` of an autolink before it. That is what keeps
    /// `**https://…**` and `[名字](https://…)` untouched — both are markup around a link, not a
    /// pasted URL — and it is the conservative direction: a URL this misses stays the link it is
    /// today, while one it wrongly took would cut a sentence in half.
    public static func pageURLs(in text: String, host: String) -> [OrbitLinkMatch] {
        var matches: [OrbitLinkMatch] = []
        // A URL that is a markdown link's destination is that link's, not a pasted URL: it already
        // has a label in front of it, and a card would eat the label's link and leave `[名字](` and
        // `)` as prose.
        let destinations = linkDestinations(in: text)
        var search = text.startIndex
        while let start = nextScheme(in: text, from: search) {
            search = text.index(after: start)
            if destinations.contains(where: { $0.contains(start) }) { continue }
            // `<https://…>` — the angle brackets are markdown's autolink, and belong to the span
            // the card replaces rather than to the text either side of it.
            let bracketed = start > text.startIndex && text[text.index(before: start)] == "<"
            let consumedStart = bracketed ? text.index(before: start) : start
            let before = consumedStart > text.startIndex ? text[text.index(before: consumedStart)] : nil
            guard isOpeningBoundary(before) else { continue }

            var end = start
            while end < text.endIndex, !isURLTerminator(text[end]) { end = text.index(after: end) }
            end = trimmingTrailingPunctuation(text, start: start, end: end)
            guard end > start else { continue }
            let consumedEnd = (bracketed && end < text.endIndex && text[end] == ">")
                ? text.index(after: end) : end

            let url = String(text[start..<end])
            guard let target = OrbitLinkParser.target(forPageURL: url, host: host) else { continue }
            matches.append(OrbitLinkMatch(range: consumedStart..<consumedEnd, url: url,
                                          ref: OrbitLinkRef(target: target, source: .pageURL(url))))
        }
        return matches
    }

    /// The spans of every markdown link destination in the text: what is between the `(` of `](`
    /// and the `)` that closes it, balanced parens included (a URL may carry its own).
    private static func linkDestinations(in text: String) -> [Range<String.Index>] {
        var spans: [Range<String.Index>] = []
        var search = text.startIndex
        while let marker = text.range(of: "](", range: search..<text.endIndex) {
            var depth = 1
            var end = marker.upperBound
            while end < text.endIndex {
                if text[end] == "(" { depth += 1 }
                if text[end] == ")" {
                    depth -= 1
                    if depth == 0 { break }
                }
                end = text.index(after: end)
            }
            spans.append(marker.upperBound..<end)
            search = end < text.endIndex ? text.index(after: end) : text.endIndex
        }
        return spans
    }

    /// The next `http://` / `https://` at a token boundary of its own, so the `https://` inside
    /// `xhttps://…` is not one.
    private static func nextScheme(in text: String, from index: String.Index) -> String.Index? {
        var search = index
        while search < text.endIndex, let found = text.range(of: "://", range: search..<text.endIndex) {
            var schemeStart = found.lowerBound
            // The walk back stops at where the caller is looking: a scheme that begins before it was
            // already answered for, and re-answering it here is a loop that never advances.
            while schemeStart > index {
                let prev = text.index(before: schemeStart)
                guard text[prev].isLetter else { break }
                schemeStart = prev
            }
            let scheme = text[schemeStart..<found.lowerBound].lowercased()
            if scheme == "http" || scheme == "https" { return schemeStart }
            search = found.upperBound
        }
        return nil
    }

    private static func isOpeningBoundary(_ ch: Character?) -> Bool {
        guard let ch else { return true }
        if ch.isWhitespace { return true }
        return "(<[「『【〔（\"'“”".contains(ch)
    }

    private static func isURLTerminator(_ ch: Character) -> Bool {
        ch.isWhitespace || ch == "<" || ch == ">"
    }

    /// A sentence's own punctuation after a URL is not part of it: `https://…/abc.` ends in a full
    /// stop the reader typed. A closing bracket stays when the URL opened one (`…(x)`), and only the
    /// unmatched ones are handed back to the text.
    private static func trimmingTrailingPunctuation(_ text: String, start: String.Index,
                                                    end: String.Index) -> String.Index {
        var end = end
        let always: Set<Character> = [".", ",", ";", ":", "!", "?", "。", "，", "、", "；", "：", "！", "？"]
        let closers: [Character: Character] = [")": "(", "]": "[", "}": "{", "）": "（", "」": "「",
                                               "』": "『", "】": "【", "〕": "〔", "》": "《"]
        while end > start {
            let ch = text[text.index(before: end)]
            if always.contains(ch) {
                end = text.index(before: end)
                continue
            }
            if let opener = closers[ch] {
                let body = text[start..<end]
                if body.filter({ $0 == ch }).count > body.filter({ $0 == opener }).count {
                    end = text.index(before: end)
                    continue
                }
            }
            break
        }
        return end
    }
}
