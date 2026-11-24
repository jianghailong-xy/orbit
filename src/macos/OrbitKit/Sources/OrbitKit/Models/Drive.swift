import Foundation

// Drive: the account's drive as the owner's routes answer it (docs/drive-technical-design.md §4.1,
// apiserver drive/drive.controller.ts, prefix `drive`). Mirrors the web's src/web/src/lib/drive.ts,
// driveSyncs.ts and driveUploads.ts. Kinds and states are Strings where a newer server may add one, so an
// answer still decodes; the reading rules live in `DriveLogic`.

/// `GET /auth/capabilities` → `documents`. A server from before the switch omits it.
public struct DriveCapability: Decodable, Equatable, Sendable {
    public let enabled: Bool?

    public init(enabled: Bool?) { self.enabled = enabled }

    private enum CodingKeys: String, CodingKey { case enabled }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try? values.decode(Bool.self, forKey: .enabled)
    }
}

/// Who last wrote an entry or a version (§3.6). An agent's session is kept only where the door could check it.
public struct DriveWriter: Codable, Equatable, Hashable, Sendable {
    /// `OWNER` or `AGENT`.
    public let kind: String
    public let sessionId: String?
    public let runnerId: String?
    /// When, on an entry's `lastWriter`; absent on a version's or a group's writer.
    public let at: String?

    public init(kind: String, sessionId: String? = nil, runnerId: String? = nil, at: String? = nil) {
        self.kind = kind
        self.sessionId = sessionId
        self.runnerId = runnerId
        self.at = at
    }

    public var isOwner: Bool { kind == "OWNER" }
}

/// A file or a folder in the drive.
public struct DriveEntry: Codable, Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let parentId: String?
    /// `FILE` or `FOLDER`.
    public let kind: String
    public let name: String
    public let sizeBytes: Int
    public let mtime: String
    public let currentVersionId: String?
    public let seq: Int
    public let createdAt: String
    public let updatedAt: String
    public let lastWriter: DriveWriter
    public let trashedAt: String?
    public let trashGroupId: String?
    /// On a read of one entry: `/a/b/name` under the drive's root.
    public let path: String?
    /// On a search result: the folder it sits in, `/a/b` (`/` for the top level).
    public let folderPath: String?

    public init(id: String, parentId: String?, kind: String, name: String, sizeBytes: Int = 0,
                mtime: String = "", currentVersionId: String? = nil, seq: Int = 0, createdAt: String = "",
                updatedAt: String = "", lastWriter: DriveWriter = DriveWriter(kind: "OWNER"),
                trashedAt: String? = nil, trashGroupId: String? = nil, path: String? = nil,
                folderPath: String? = nil) {
        self.id = id
        self.parentId = parentId
        self.kind = kind
        self.name = name
        self.sizeBytes = sizeBytes
        self.mtime = mtime
        self.currentVersionId = currentVersionId
        self.seq = seq
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.lastWriter = lastWriter
        self.trashedAt = trashedAt
        self.trashGroupId = trashGroupId
        self.path = path
        self.folderPath = folderPath
    }

    public var isFolder: Bool { kind == "FOLDER" }
    public var isFile: Bool { kind == "FILE" }

    private enum CodingKeys: String, CodingKey {
        case id, parentId, kind, name, sizeBytes, mtime, currentVersionId, seq, createdAt, updatedAt, lastWriter,
             trashedAt, trashGroupId, path, folderPath
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        parentId = try c.decodeIfPresent(String.self, forKey: .parentId)
        kind = try c.decode(String.self, forKey: .kind)
        name = try c.decode(String.self, forKey: .name)
        sizeBytes = (try? c.decode(Int.self, forKey: .sizeBytes)) ?? 0
        mtime = (try? c.decode(String.self, forKey: .mtime)) ?? ""
        currentVersionId = try? c.decodeIfPresent(String.self, forKey: .currentVersionId)
        seq = (try? c.decode(Int.self, forKey: .seq)) ?? 0
        createdAt = (try? c.decode(String.self, forKey: .createdAt)) ?? ""
        updatedAt = (try? c.decode(String.self, forKey: .updatedAt)) ?? ""
        lastWriter = (try? c.decode(DriveWriter.self, forKey: .lastWriter)) ?? DriveWriter(kind: "OWNER")
        trashedAt = try? c.decodeIfPresent(String.self, forKey: .trashedAt)
        trashGroupId = try? c.decodeIfPresent(String.self, forKey: .trashGroupId)
        path = try? c.decodeIfPresent(String.self, forKey: .path)
        folderPath = try? c.decodeIfPresent(String.self, forKey: .folderPath)
    }
}

/// `GET /drive/entries`: one page of a folder (the root when no `parentId`).
public struct DriveListing: Codable, Equatable, Sendable {
    public let folder: DriveEntry
    public let entries: [DriveEntry]
    public let nextCursor: String?

    public init(folder: DriveEntry, entries: [DriveEntry], nextCursor: String? = nil) {
        self.folder = folder
        self.entries = entries
        self.nextCursor = nextCursor
    }
}

/// `GET /drive/search`: the first page of live entries whose name contains the words.
public struct DriveSearchResult: Codable, Equatable, Sendable {
    public let entries: [DriveEntry]
    public let nextCursor: String?
}

/// One version of a file, current or replaced.
public struct DriveVersion: Codable, Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let entryId: String
    public let sizeBytes: Int
    public let createdAt: String
    public let current: Bool
    public let writer: DriveWriter
    public let replacedAt: String?
    public let trashGroupId: String?

    public init(id: String, entryId: String, sizeBytes: Int, createdAt: String, current: Bool,
                writer: DriveWriter, replacedAt: String? = nil, trashGroupId: String? = nil) {
        self.id = id
        self.entryId = entryId
        self.sizeBytes = sizeBytes
        self.createdAt = createdAt
        self.current = current
        self.writer = writer
        self.replacedAt = replacedAt
        self.trashGroupId = trashGroupId
    }
}

/// `GET /drive/entries/:id/versions`.
public struct DriveVersions: Codable, Equatable, Sendable {
    public let entry: DriveEntry
    public let versions: [DriveVersion]
}

/// A trash group's replaced version, with the file it belongs to.
public struct DriveTrashVersion: Codable, Equatable, Hashable, Sendable {
    public let id: String
    public let entryId: String
    public let sizeBytes: Int
    public let createdAt: String
    public let writer: DriveWriter
    public let entry: DriveEntry

    public init(id: String, entryId: String, sizeBytes: Int, createdAt: String, writer: DriveWriter,
                entry: DriveEntry) {
        self.id = id
        self.entryId = entryId
        self.sizeBytes = sizeBytes
        self.createdAt = createdAt
        self.writer = writer
        self.entry = entry
    }
}

/// What one delete (or one replace) put in Trash (rule 3): the folder it came from and when.
public struct DriveTrashGroup: Codable, Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    /// `DELETE` or `VERSION`.
    public let kind: String
    public let folderId: String?
    public let folderPath: String
    public let createdAt: String
    public let itemCount: Int
    public let sizeBytes: Int
    public let actor: DriveWriter
    public let items: [DriveEntry]
    public let version: DriveTrashVersion?

    public init(id: String, kind: String, folderId: String? = nil, folderPath: String, createdAt: String,
                itemCount: Int, sizeBytes: Int, actor: DriveWriter, items: [DriveEntry] = [],
                version: DriveTrashVersion? = nil) {
        self.id = id
        self.kind = kind
        self.folderId = folderId
        self.folderPath = folderPath
        self.createdAt = createdAt
        self.itemCount = itemCount
        self.sizeBytes = sizeBytes
        self.actor = actor
        self.items = items
        self.version = version
    }
}

/// `GET /drive/trash`: one page of groups, newest first.
public struct DriveTrashPage: Codable, Equatable, Sendable {
    public let groups: [DriveTrashGroup]
    public let nextCursor: String?
}

/// What a restore brought back.
public struct DriveRestored: Codable, Equatable, Sendable {
    public let entryIds: [String]
}

/// `DELETE /drive/entries/:id`: the group the entry went in, which Undo restores.
public struct DriveTrashed: Codable, Equatable, Sendable {
    public let trashGroupId: String
}

/// What the share check found (§9): the shape and line of a credential, never the credential itself.
public struct DriveShareWarning: Codable, Equatable, Hashable, Sendable {
    public let kind: String
    public let line: Int

    public init(kind: String, line: Int) {
        self.kind = kind
        self.line = line
    }
}

/// `POST /drive/entries/:id/share-check`.
public struct DriveShareCheck: Codable, Equatable, Sendable {
    public let versionId: String?
    public let warnings: [DriveShareWarning]
    public let checkedBytes: Int
    /// Only the start of the file was read: the scan stops at 25 MiB or 20 s.
    public let partial: Bool

    public init(versionId: String? = nil, warnings: [DriveShareWarning], checkedBytes: Int, partial: Bool) {
        self.versionId = versionId
        self.warnings = warnings
        self.checkedBytes = checkedBytes
        self.partial = partial
    }
}

/// A drive file's link, as `GET /share-links?kind=DRIVE_FILE` lists it and `POST /share-links` answers it.
/// `root.pinnedIsCurrent` is false once the file moved on. Its own type: `ShareRootKind` is the closed set
/// Settings → Shared links asks for, and a drive file is not among them.
public struct DriveShareLink: Codable, Equatable, Sendable, Identifiable {
    public struct Root: Codable, Equatable, Sendable {
        public let id: String
        public let title: String?
        public let pinnedIsCurrent: Bool

        public init(id: String, title: String?, pinnedIsCurrent: Bool) {
            self.id = id
            self.title = title
            self.pinnedIsCurrent = pinnedIsCurrent
        }

        private enum CodingKeys: String, CodingKey { case id, title, pinnedIsCurrent }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            title = try? c.decodeIfPresent(String.self, forKey: .title)
            pinnedIsCurrent = (try? c.decode(Bool.self, forKey: .pinnedIsCurrent)) ?? true
        }
    }

    public let id: String
    public let kind: String
    public let token: String
    /// `ACTIVE`, `PAUSED` (the file is in Trash) or `ENDED`.
    public let state: String
    public let root: Root

    public init(id: String, kind: String = "DRIVE_FILE", token: String, state: String = "ACTIVE", root: Root) {
        self.id = id
        self.kind = kind
        self.token = token
        self.state = state
        self.root = root
    }
}

/// `GET /share-links?kind=DRIVE_FILE`; a row of another kind or that fails to decode is skipped.
public struct DriveShareLinkList: Decodable, Equatable, Sendable {
    public let links: [DriveShareLink]

    private enum CodingKeys: String, CodingKey { case links }
    private struct Row: Decodable {
        let link: DriveShareLink?
        init(from decoder: Decoder) throws { link = try? DriveShareLink(from: decoder) }
    }

    public init(links: [DriveShareLink]) { self.links = links }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        links = try c.decode([Row].self, forKey: .links).compactMap(\.link)
    }
}

/// `POST /share-links` with a drive file: the link, and what the scan found on the version it pins.
public struct DriveShareAnswer: Decodable, Equatable, Sendable {
    public let link: DriveShareLink
    public let warnings: [DriveShareWarning]
    public let checkedBytes: Int
    public let partial: Bool
}

/// `GET /drive/usage`: the drive's share of the account and the rest, each content once (§2.5).
public struct DriveUsage: Codable, Equatable, Sendable {
    public let totalBytes: Int
    public let driveBytes: Int
    public let trashBytes: Int
    public let otherBytes: Int
    public let storeUsedBytes: Int?
    public let storeQuotaBytes: Int?
    public let nearQuota: Bool?

    public init(totalBytes: Int, driveBytes: Int, trashBytes: Int, otherBytes: Int, storeUsedBytes: Int? = nil,
                storeQuotaBytes: Int? = nil, nearQuota: Bool? = nil) {
        self.totalBytes = totalBytes
        self.driveBytes = driveBytes
        self.trashBytes = trashBytes
        self.otherBytes = otherBytes
        self.storeUsedBytes = storeUsedBytes
        self.storeQuotaBytes = storeQuotaBytes
        self.nearQuota = nearQuota
    }
}

/// `GET /attachments/usage`: what the account keeps besides the drive, with its largest projects and tasks and what
/// each week added (oldest first).
public struct StorageUsage: Codable, Equatable, Sendable {
    public struct Project: Codable, Equatable, Sendable, Identifiable {
        public let projectId: String
        public let title: String
        public let bytes: Int
        public var id: String { projectId }
        public init(projectId: String, title: String, bytes: Int) {
            self.projectId = projectId
            self.title = title
            self.bytes = bytes
        }
    }

    public struct Task: Codable, Equatable, Sendable, Identifiable {
        public let taskId: String
        public let title: String
        public let bytes: Int
        public var id: String { taskId }
        public init(taskId: String, title: String, bytes: Int) {
            self.taskId = taskId
            self.title = title
            self.bytes = bytes
        }
    }

    public struct Week: Codable, Equatable, Sendable, Identifiable {
        /// That week's Monday, `YYYY-MM-DD`.
        public let weekStart: String
        public let bytes: Int
        public var id: String { weekStart }
        public init(weekStart: String, bytes: Int) {
            self.weekStart = weekStart
            self.bytes = bytes
        }
    }

    public let totalBytes: Int
    public let fileCount: Int
    public let quotaBytes: Int?
    public let projects: [Project]
    public let tasks: [Task]
    public let weeks: [Week]

    public init(totalBytes: Int, fileCount: Int, quotaBytes: Int? = nil, projects: [Project] = [],
                tasks: [Task] = [], weeks: [Week] = []) {
        self.totalBytes = totalBytes
        self.fileCount = fileCount
        self.quotaBytes = quotaBytes
        self.projects = projects
        self.tasks = tasks
        self.weeks = weeks
    }
}

/// An agent's directory sync into Drive (docs/drive-directory-sync-design.md, S4).
public struct DriveSync: Codable, Equatable, Sendable, Identifiable {
    public struct Session: Codable, Equatable, Sendable {
        public let id: String
        public let title: String
        public init(id: String, title: String) {
            self.id = id
            self.title = title
        }
    }

    public struct Failure: Codable, Equatable, Hashable, Sendable {
        public let path: String
        public let error: String
        public init(path: String, error: String) {
            self.path = path
            self.error = error
        }
    }

    public let id: String
    /// `CHECKING`, `UPLOADING`, `DONE`, `FAILED` or `STOPPED`.
    public let status: String
    public let sourceName: String
    public let destPath: String
    public let destEntryId: String?
    public let session: Session?
    public let filesSeen: Int
    public let filesTotal: Int?
    public let filesDone: Int
    public let filesSame: Int
    public let filesDeleted: Int
    public let bytesTotal: Int?
    public let bytesSent: Int
    public let currentPath: String?
    public let failed: [Failure]
    public let failedCount: Int
    public let error: String?
    public let startedAt: String
    public let updatedAt: String
    public let endedAt: String?

    public init(id: String, status: String, sourceName: String, destPath: String, destEntryId: String? = nil,
                session: Session? = nil, filesSeen: Int = 0, filesTotal: Int? = nil, filesDone: Int = 0,
                filesSame: Int = 0, filesDeleted: Int = 0, bytesTotal: Int? = nil, bytesSent: Int = 0,
                currentPath: String? = nil, failed: [Failure] = [], failedCount: Int = 0, error: String? = nil,
                startedAt: String = "", updatedAt: String = "", endedAt: String? = nil) {
        self.id = id
        self.status = status
        self.sourceName = sourceName
        self.destPath = destPath
        self.destEntryId = destEntryId
        self.session = session
        self.filesSeen = filesSeen
        self.filesTotal = filesTotal
        self.filesDone = filesDone
        self.filesSame = filesSame
        self.filesDeleted = filesDeleted
        self.bytesTotal = bytesTotal
        self.bytesSent = bytesSent
        self.currentPath = currentPath
        self.failed = failed
        self.failedCount = failedCount
        self.error = error
        self.startedAt = startedAt
        self.updatedAt = updatedAt
        self.endedAt = endedAt
    }

    public var running: Bool { status == "CHECKING" || status == "UPLOADING" }
}

/// `GET /drive/syncs`.
public struct DriveSyncList: Codable, Equatable, Sendable {
    public let syncs: [DriveSync]
}

/// `POST /drive/uploads`: the staging id, and the size every chunk but the last must have.
public struct DriveUploadOpened: Codable, Equatable, Sendable {
    public let id: String
    public let chunkSize: Int
    /// The top folder a dropped folder's files share; later files of the same drop pass it back.
    public let dropRootId: String?

    public init(id: String, chunkSize: Int, dropRootId: String? = nil) {
        self.id = id
        self.chunkSize = chunkSize
        self.dropRootId = dropRootId
    }
}

/// `GET /drive/uploads/:id`: which chunks have arrived, so an upload goes on from where it stopped.
public struct DriveUploadStatus: Codable, Equatable, Sendable {
    public struct Chunk: Codable, Equatable, Sendable {
        public let idx: Int
        public let sizeBytes: Int
        public init(idx: Int, sizeBytes: Int) {
            self.idx = idx
            self.sizeBytes = sizeBytes
        }
    }

    public let chunkSize: Int
    public let chunks: [Chunk]
    public let completed: Bool
    public let entryId: String?

    public init(chunkSize: Int, chunks: [Chunk], completed: Bool = false, entryId: String? = nil) {
        self.chunkSize = chunkSize
        self.chunks = chunks
        self.completed = completed
        self.entryId = entryId
    }

    private enum CodingKeys: String, CodingKey { case chunkSize, chunks, completed, entryId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        chunkSize = try c.decode(Int.self, forKey: .chunkSize)
        chunks = (try? c.decode([Chunk].self, forKey: .chunks)) ?? []
        completed = (try? c.decode(Bool.self, forKey: .completed)) ?? false
        entryId = try? c.decodeIfPresent(String.self, forKey: .entryId)
    }
}

/// `POST /drive/entries/:id/download-link`: a URL under /api that downloads without a login header.
public struct DriveDownloadLink: Codable, Equatable, Sendable {
    public let path: String
    public let expiresAt: String
}
