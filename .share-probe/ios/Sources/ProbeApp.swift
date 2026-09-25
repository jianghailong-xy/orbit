import SwiftUI

// TEMPORARY evidence probe (see ../../README.md).

@main
struct MenuProbeApp: App {
    var body: some Scene {
        WindowGroup { ProjectPageProbe() }
    }
}

// Stand-ins for what ProjectsView's menu reads. The menu itself is the app's own code.

enum ProjectStatus { case open, done, cancelled }

struct ProjectDocument {
    let id: String
    let title: String
    let status: ProjectStatus
    let taskCount: Int
}

final class ProjectDetailModel {
    var busy = false
}

final class ProbeAppModel {
    /// As `AppModel.projectWebURL` builds it: `<baseURL>/projects/<id>`.
    func projectWebURL(_ projectID: String) -> URL? {
        URL(string: "https://orbitd.io")?.appendingPathComponent("projects").appendingPathComponent(projectID)
    }
}
