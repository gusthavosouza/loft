import AppKit
import LoftKit
import SwiftUI

/// The Loft item in the Mac menu bar (spec #382): the Needs you count, who is working, and a quick message box.
/// It works with the main window closed: a click opens the window on the agent.
struct MenuBarLabel: View {
    @Environment(LoftStore.self) private var store

    var body: some View {
        let count = MenuBarSummary(store).needsCount
        HStack(spacing: 3) {
            Image(systemName: count > 0 ? "bell.badge" : "circle.hexagongrid")
            if count > 0 { Text("\(count)") }
        }
    }
}

struct MenuBarContent: View {
    @Environment(LoftStore.self) private var store
    @Environment(MacNav.self) private var nav
    @Environment(\.openWindow) private var openWindow
    @State private var recipient: String?
    @State private var text = ""

    var body: some View {
        let s = MenuBarSummary(store)
        VStack(alignment: .leading, spacing: 10) {
            Section("Working now") {
                if s.working.isEmpty {
                    Text("Nobody is working").foregroundStyle(.secondary)
                }
                ForEach(s.working) { a in
                    Button { open(agent: a.id) } label: { Label(a.name, systemImage: "bolt.fill").frame(maxWidth: .infinity, alignment: .leading) }
                        .accessibilityIdentifier("menuAgent-\(a.name)")
                }
            }
            Divider()
            Section(s.needsCount == 0 ? "Needs you" : "Needs you (\(s.needsCount))") {
                if s.items.isEmpty {
                    Text("Nothing is waiting").foregroundStyle(.secondary)
                }
                ForEach(s.items) { item in
                    Button { item.agentId.map { open(agent: $0) } ?? open(section: .needsYou) } label: {
                        Text(item.title).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .accessibilityIdentifier("menuNeeds-\(item.id)")
                }
                if s.needsCount > s.items.count {
                    Button("All \(s.needsCount)…") { open(section: .needsYou) }
                }
            }
            Divider()
            Picker("To", selection: Binding(get: { recipient ?? store.orchestrator?.id ?? store.sortedAgents.first?.id }, set: { recipient = $0 })) {
                ForEach(store.sortedAgents) { Text($0.name).tag(Optional($0.id)) }
            }
            .accessibilityIdentifier("menuRecipient")
            HStack {
                TextField("Message", text: $text).onSubmit(send).accessibilityIdentifier("menuMessage")
                Button("Send", action: send).disabled(target == nil || text.trimmingCharacters(in: .whitespaces).isEmpty)
                    .accessibilityIdentifier("menuSend")
            }
            Divider()
            Button("Open Loft") { open(section: nil) }
            Button("Quit Loft") { NSApp.terminate(nil) }.keyboardShortcut("q")
        }
        .buttonStyle(.plain)
        .padding(12)
        .frame(width: 320)
    }

    private var target: String? { recipient ?? store.orchestrator?.id ?? store.sortedAgents.first?.id }

    private func send() {
        guard let id = target, !text.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        let t = text
        text = ""
        Task { await store.send(t, to: id) }
    }

    private func open(agent id: String) {
        nav.openChat(id)
        show()
    }

    private func open(section: MacSection?) {
        if let section { nav.section = section }
        show()
    }

    private func show() {
        openWindow(id: "main")
        NSApp.activate(ignoringOtherApps: true)
    }
}
