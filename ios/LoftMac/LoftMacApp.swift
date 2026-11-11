import LoftKit
import SwiftUI

/// Loft for Mac (spec #382): the same paired client as the iPhone app, in Mac windows with a sidebar of sections.
@main
struct LoftMacApp: App {
    @State private var store: LoftStore
    @State private var nav = MacNav()

    init() {
        Prefs.registerDefaults()
        _store = State(initialValue: LoftStore(api: Self.makeAPI()))
    }

    private static func makeAPI() -> LoftAPI? {
        #if DEBUG
        let args = ProcessInfo.processInfo.arguments
        if args.contains("-ui-onboarding") {
            UserDefaults.standard.removeObject(forKey: Prefs.serverURL)
            return nil
        }
        if args.contains("-ui-testing") {
            SnapshotStore.standard.clear()
            return FixtureAPI.fromLaunchArguments()
        }
        #endif
        return UserDefaults.standard.string(forKey: Prefs.serverURL).flatMap(LiveLoftAPI.normalize).map(LiveLoftAPI.init(baseURL:))
    }

    var body: some Scene {
        WindowGroup("Loft") {
            MacRootView()
                .environment(store)
                .environment(nav)
                .frame(minWidth: 1100, minHeight: 640)
                .onAppear { store.activate() }
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in store.saveNow() }
        }
        // Room for the sidebar, the agents, the chat and the agent's settings side by side.
        .defaultSize(width: 1280, height: 800)
        .commands { LoftCommands(nav: nav) }

        Settings {
            AddressForm(isOnboarding: false)
                .environment(store)
                .frame(width: 520)
                .padding()
        }
    }
}

/// The window's sections, in sidebar order; ⌘1 to ⌘5 open them.
enum MacSection: Int, CaseIterable, Identifiable {
    case overview = 1, agents, issues, needsYou, settings

    var id: Int { rawValue }

    var title: String {
        switch self {
        case .overview: "Overview"
        case .agents: "Agents"
        case .issues: "Issues"
        case .needsYou: "Needs you"
        case .settings: "Settings"
        }
    }

    var symbol: String {
        switch self {
        case .overview: "square.grid.2x2"
        case .agents: "person.3"
        case .issues: "checklist"
        case .needsYou: "bell.badge"
        case .settings: "gearshape"
        }
    }
}

/// Where the window is: the section, the agent whose chat is open, and the New message picker.
@MainActor
@Observable
final class MacNav {
    var section: MacSection = .agents
    var agentId: String?
    var picksRecipient = false

    func openChat(_ agentId: String) {
        section = .agents
        self.agentId = agentId
    }
}

struct LoftCommands: Commands {
    let nav: MacNav

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Message…") { nav.picksRecipient = true }
                .keyboardShortcut("n")
        }
        CommandMenu("Go") {
            ForEach(MacSection.allCases) { s in
                Button(s.title) { nav.section = s }
                    .keyboardShortcut(KeyEquivalent(Character(String(s.rawValue))))
            }
        }
    }
}

/// First the address, then pairing, then the window's sections. Loft unreachable with nothing loaded yet says so.
struct MacRootView: View {
    @Environment(LoftStore.self) private var store

    var body: some View {
        if store.connection == .notConfigured {
            AddressForm(isOnboarding: true)
                .frame(maxWidth: 520)
                .padding(32)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if needsPairing {
            PairScreen()
        } else if store.lastSync == nil, case .reconnecting(_, let error) = store.connection {
            UnreachableScreen(error: error)
        } else {
            MainWindow()
        }
    }

    /// Every Mac pairs before anything else (reads work unpaired, but nothing could be changed). UI tests on
    /// fixture data skip it unless they test it (`-fixture-pairing`).
    private var needsPairing: Bool {
        if store.showsPairing { return true }
        if store.isPaired || store.isDemo { return false }
        if store.api is FixtureAPI { return TestMode.fixturePairing }
        return true
    }
}

/// Loft didn't answer at the saved address and nothing is cached: why, and what to try.
struct UnreachableScreen: View {
    @Environment(LoftStore.self) private var store
    let error: APIError

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "bolt.horizontal.circle").font(.system(size: 44)).foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text("Can't reach Loft").font(.title2.bold()).accessibilityIdentifier("unreachableTitle")
            Text("Nothing answered at \(store.api?.baseURL.absoluteString ?? "the saved address"). Check that Loft is running on that Mac, or change the address.")
                .multilineTextAlignment(.center).foregroundStyle(.secondary)
            Text(error.title).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            HStack {
                Button("Try again") { store.reconnect() }.keyboardShortcut(.defaultAction)
                Button("Change address…") { store.forgetServer() }
            }
        }
        .frame(maxWidth: 460)
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct MainWindow: View {
    @Environment(LoftStore.self) private var store
    @Environment(MacNav.self) private var nav

    var body: some View {
        @Bindable var nav = nav
        NavigationSplitView {
            List(selection: Binding(get: { nav.section }, set: { if let s = $0 { nav.section = s } })) {
                ForEach(MacSection.allCases) { s in
                    Label(s.title, systemImage: s.symbol).tag(s).accessibilityIdentifier("section-\(s.title)")
                }
            }
            .navigationSplitViewColumnWidth(min: 160, ideal: 180)
            .safeAreaInset(edge: .bottom) {
                Label(store.connection.label, systemImage: store.connection.isUsable ? "circle.fill" : "circle.dotted")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .accessibilityIdentifier("connectionLabel")
            }
        } detail: {
            switch nav.section {
            case .agents: AgentsSection()
            case .settings:
                ScrollView { AddressForm(isOnboarding: false).frame(maxWidth: 560).padding(24) }
                    .navigationTitle("Settings")
            default:
                ContentUnavailableView(nav.section.title, systemImage: nav.section.symbol,
                                       description: Text("Coming to Loft for Mac soon. Use the web app for it meanwhile."))
                    .navigationTitle(nav.section.title)
            }
        }
        .sheet(isPresented: $nav.picksRecipient) { RecipientPicker() }
    }
}

/// ⌘N: pick an agent and its chat opens.
struct RecipientPicker: View {
    @Environment(LoftStore.self) private var store
    @Environment(MacNav.self) private var nav
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""

    private var agents: [Agent] {
        store.sortedAgents.filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("New message").font(.headline)
            TextField("Search agents", text: $search)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("recipientSearch")
                .onSubmit { if let a = agents.first { pick(a) } }
            List(agents) { a in
                Button { pick(a) } label: { AgentRow(agent: a).contentShape(Rectangle()) }
                    .buttonStyle(.plain)
            }
            .frame(height: 280)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
            }
        }
        .padding()
        .frame(width: 360)
    }

    private func pick(_ a: Agent) {
        nav.openChat(a.id)
        dismiss()
    }
}
