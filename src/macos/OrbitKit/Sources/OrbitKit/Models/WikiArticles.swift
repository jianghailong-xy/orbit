import Foundation

// Orbit Wiki's articles — the Swift mirror of `@orbit/shared`'s `wikiArticles.ts`, which transcribes
// `contracts/wiki.contract.json` `articles` (criterion 9). `WikiArticlesContractTests` holds the closed
// sets and the category titles below to that file.
//
// An article is the view a person reads: a topic's text, written by the local model from the topic's
// entries, every sentence footnoted to one of them. As in `Wiki.swift`, a closed set decodes a value it
// has never heard of as `.unknown`, and the fields a page draws are optional, so a server one release
// apart fills fewer rows instead of failing the read.

// MARK: - closed sets

/// The six categories a topic is filed under, in the directory's order (contract `articles.categories`).
public enum WikiArticleCategory: String, Codable, Sendable, CaseIterable {
    case platform, runner, clients, data, engineering, collaboration
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiArticleCategory(rawValue: raw) ?? .unknown
    }

    /// The category's name as every client shows it (the contract's `title`).
    public var title: String {
        switch self {
        case .platform: return "Platform core"
        case .runner: return "Runner & engines"
        case .clients: return "Clients & UI"
        case .data: return "Data & backend"
        case .engineering: return "Engineering workflow"
        case .collaboration: return "Collaboration"
        case .unknown: return "Other"
        }
    }
}

/// `article` is a topic's one article; a split topic has an `overview` (part 0) and `subtopic` parts.
public enum WikiArticleKind: String, Codable, Sendable, CaseIterable {
    case article, overview, subtopic
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiArticleKind(rawValue: raw) ?? .unknown
    }
}

// MARK: - the three reads

/// One part as the directory and the index name it.
public struct WikiArticlePartRef: Codable, Equatable, Sendable {
    public let part: Int
    public let kind: WikiArticleKind?
    public let title: String?
    /// The entries it was written from.
    public let entryCount: Int?
    /// When it was written; the directory carries it for part 0.
    public let generatedAt: String?
}

/// `GET /api/wiki/spaces/:id/articles`: categories → topics → the article and its subtopic parts.
public struct WikiArticleDirectory: Codable, Equatable, Sendable {
    public struct Topic: Codable, Equatable, Sendable {
        public let slug: String
        /// The topic's display name.
        public let title: String?
        public let description: String?
        public let category: WikiArticleCategory?
        /// Part 0, when the topic has articles.
        public let article: WikiArticlePartRef?
        public let parts: [WikiArticlePartRef]?
    }

    public struct Category: Codable, Equatable, Sendable {
        public let key: WikiArticleCategory
        public let title: String?
        public let topics: [Topic]?
    }

    public let spaceId: String?
    public let categories: [Category]?
    /// Topics nothing has filed under a category.
    public let uncategorized: [Topic]?
}

/// One sentence, and the footnote numbers it carries (1-based, into `footnotes`).
public struct WikiArticleSentence: Codable, Equatable, Sendable {
    public let text: String
    public let notes: [Int]
}

/// A run of sentences under one heading; the lead has none.
public struct WikiArticleBlock: Codable, Equatable, Sendable {
    public let heading: String?
    public let sentences: [WikiArticleSentence]
}

/// A footnote: the entry it names, at the revision the article was written from, and that entry as it
/// stands now (nil when it no longer exists).
public struct WikiArticleFootnote: Codable, Equatable, Sendable {
    public struct Entry: Codable, Equatable, Sendable {
        public let id: String
        public let kind: WikiEntryKind?
        public let title: String?
        public let summary: String?
        public let status: WikiEntryStatus?
        public let trust: WikiTrust?
        public let currentRevision: Int?
    }

    public let n: Int
    public let entryId: String
    public let revision: Int?
    public let entry: Entry?
}

/// `GET /api/wiki/spaces/:id/articles/:slug[/:part]`.
public struct WikiArticle: Codable, Equatable, Sendable {
    public struct Topic: Codable, Equatable, Sendable {
        public let slug: String
        public let title: String?
        public let category: WikiArticleCategory?
        public let categoryTitle: String?
    }

    public let spaceId: String?
    public let topic: Topic
    public let part: Int
    public let kind: WikiArticleKind?
    public let title: String?
    public let blocks: [WikiArticleBlock]
    public let footnotes: [WikiArticleFootnote]
    public let entryCount: Int?
    public let chars: Int?
    public let generatedAt: String?
    /// The git ref it was generated at, when the run knew one.
    public let ref: String?
    public let model: String?
    /// The overview a subtopic article belongs to.
    public let overview: WikiArticlePartRef?
    /// The subtopic articles of this topic, whichever part this is.
    public let parts: [WikiArticlePartRef]?
}

/// `GET /api/wiki/spaces/:id/article-index`: every article, A to Z.
public struct WikiArticleIndex: Codable, Equatable, Sendable {
    public struct Item: Codable, Equatable, Sendable {
        public struct Topic: Codable, Equatable, Sendable {
            public let slug: String
            public let title: String?
        }

        public let part: Int
        public let kind: WikiArticleKind?
        public let title: String?
        public let entryCount: Int?
        /// A to Z, or `#` for a title that does not start with a Latin letter.
        public let initial: String?
        public let topic: Topic
    }

    public let spaceId: String?
    public let items: [Item]
}
