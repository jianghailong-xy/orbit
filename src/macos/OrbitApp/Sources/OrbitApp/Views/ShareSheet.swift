import SwiftUI
import OrbitKit

/// A public, read-only link to one session's transcript — the native port of web's `ShareModal`
/// (the "Share…" item in `AgentView`'s session menu). Presented as a sheet from the console: from
/// its nav bar on iOS, from the window toolbar on macOS.
///
/// Owns a fresh `APIClient` (built from the app's baseURL + tokenStore, exactly like `ConsoleModel`)
/// and mirrors the web dialog's states: create → copy / share / revoke. The link resolves to the
/// web app's public `/s/<token>` page, so recipients need no account. `enableShare` is idempotent
/// server-side, so re-creating just returns the existing token.
struct ShareSheet: View {
    let sessionID: String
    let baseURL: URL
    let tokenStore: TokenStore
    @Environment(\.dismiss) private var dismiss

    /// nil = not shared (offer "Create link"); non-nil = shared (show link + revoke). Seeded from
    /// the session detail on open, then updated by enable/disable.
    @State private var token: String?
    @State private var loading = true
    @State private var busy = false
    @State private var confirmingRevoke = false
    @State private var copied = false
    @State private var errorText: String?

    private var api: APIClient { APIClient(baseURL: baseURL, tokenStore: tokenStore) }
    /// `<baseURL>/s/<token>` — the same shape web builds from `window.location.origin`.
    private var shareURL: URL? {
        token.map { baseURL.appendingPathComponent("s").appendingPathComponent($0) }
    }

    var body: some View {
        NavigationStack {
            Form {
                if loading {
                    HStack { Spacer(); ProgressView(); Spacer() }
                } else if let url = shareURL {
                    activeSections(url)
                } else {
                    createSection
                }
                if let errorText {
                    Text(errorText).font(.footnote).foregroundStyle(.red)
                }
            }
            // A Mac form lays its rows out in columns unless told otherwise; grouped reads as the
            // phone's sections do (and is already the phone's default).
            .formStyle(.grouped)
            .navigationTitle("Share")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                #if os(iOS)
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
                #else
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
                #endif
            }
        }
        .task { await load() }
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 360)
        #endif
    }

    private var createSection: some View {
        Section {
            Button {
                Task { await enable() }
            } label: {
                Label("Create share link", systemImage: "link.badge.plus")
            }
            .disabled(busy)
        } footer: {
            Text("Anyone with the link can view this session's transcript, read-only. No sign-in required.")
        }
    }

    @ViewBuilder
    private func activeSections(_ url: URL) -> some View {
        Section {
            Text(url.absoluteString)
                .font(.footnote.monospaced())
                .textSelection(.enabled)
                .foregroundStyle(.secondary)
        } header: {
            Label("Sharing is on", systemImage: "checkmark.circle.fill")
        } footer: {
            Text("Anyone with this link can view the transcript, read-only.")
        }

        Section {
            Button {
                PlatformPasteboard.copyString(url.absoluteString)
                copied = true
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    copied = false
                }
            } label: {
                Label(copied ? "Copied" : "Copy link", systemImage: copied ? "checkmark" : "doc.on.doc")
            }
            ShareLink(item: url) {
                Label("Share link…", systemImage: "square.and.arrow.up")
            }
        }

        Section {
            Button(role: .destructive) {
                confirmingRevoke = true
            } label: {
                Label("Revoke link", systemImage: "link.badge.minus")
            }
            .disabled(busy)
        }
        .confirmationDialog("Revoke this link? Anyone with it will lose access.",
                            isPresented: $confirmingRevoke, titleVisibility: .visible) {
            Button("Revoke link", role: .destructive) { Task { await disable() } }
            Button("Cancel", role: .cancel) {}
        }
    }

    @MainActor
    private func load() async {
        do { token = try await api.sessionDetail(sessionID).shareToken }
        catch { errorText = "Couldn't load the share status." }
        loading = false
    }

    @MainActor
    private func enable() async {
        busy = true; errorText = nil
        do { token = try await api.enableShare(sessionID).shareToken }
        catch { errorText = "Couldn't create the share link." }
        busy = false
    }

    @MainActor
    private func disable() async {
        busy = true; errorText = nil
        do {
            try await api.disableShare(sessionID)
            token = nil; copied = false
        } catch { errorText = "Couldn't revoke the share link." }
        busy = false
    }
}
