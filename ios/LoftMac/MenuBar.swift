import AppKit
import LoftKit
import SwiftUI

/// The Loft item in the Mac menu bar (spec #382): the Needs you count, who is working, and a quick message box.
/// It works with the main window closed: a click opens the window on the agent.
/// Loft's palette, as the web and the iPhone app have it (ios/Loft/DesignSystem/Theme.swift), not macOS blue. Copied
/// until Theme moves into LoftKit (#398), then this goes.
private enum MenuTheme {
    private static func dynamic(light: NSColor, dark: NSColor) -> Color {
        Color(nsColor: NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light })
    }
    /// Lime on dark, the deeper green on light.
    static let accent = dynamic(light: NSColor(red: 0x4F / 255, green: 0x6A / 255, blue: 0x26 / 255, alpha: 1),
                                dark: NSColor(red: 0xC8 / 255, green: 0xF2 / 255, blue: 0x6D / 255, alpha: 1))
    static let onAccent = dynamic(light: .white, dark: NSColor(red: 0.03, green: 0.04, blue: 0.04, alpha: 1))
    static let working = Color(red: 0.30, green: 0.82, blue: 0.52)
    static let attention = Color(red: 1.00, green: 0.72, blue: 0.25)
    static let failure = Color(red: 1.00, green: 0.42, blue: 0.40)
}

struct MenuBarLabel: View {
    @Environment(LoftStore.self) private var store
    @Environment(\.openWindow) private var openWindow
    var alerts: MacAlerts?

    var body: some View {
        let count = MenuBarSummary(store).needsCount
        HStack(spacing: 3) {
            Image(systemName: count > 0 ? "bell.badge" : "circle.hexagongrid")
            if count > 0 { Text("\(count)") }
        }
        .onAppear { alerts?.showWindow = { openWindow(id: "main") } }
    }
}

struct MenuBarContent: View {
    @Environment(LoftStore.self) private var store
    @Environment(MacNav.self) private var nav
    @Environment(\.openWindow) private var openWindow
    @State private var recipient: String?
    @State private var text = ""
    /// How the last quick message went: a short "Sent to …", or why it failed (the text is kept then).
    @State private var result: (text: String, failed: Bool)?

    var body: some View {
        let s = MenuBarSummary(store)
        VStack(alignment: .leading, spacing: 8) {
            header("Working now")
            if s.working.isEmpty {
                Text("Nobody is working").foregroundStyle(.secondary)
            }
            ForEach(s.working) { a in
                Button { open(agent: a.id) } label: { Label { Text(a.name) } icon: { Image(systemName: "bolt.fill").foregroundStyle(MenuTheme.working) }.frame(maxWidth: .infinity, alignment: .leading) }
                    .accessibilityIdentifier("menuAgent-\(a.name)")
            }
            Divider()
            header(s.needsCount == 0 ? "Needs you" : "Needs you (\(s.needsCount))")
            if s.items.isEmpty {
                Text("Nothing is waiting").foregroundStyle(.secondary)
            }
            ForEach(s.items) { item in
                Button { item.agentId.map { open(agent: $0) } ?? open(section: .needsYou) } label: {
                    Label { Text(item.title).lineLimit(1) } icon: { Image(systemName: "circle.fill").font(.system(size: 6)).foregroundStyle(MenuTheme.attention) }
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .accessibilityIdentifier("menuNeeds-\(item.id)")
            }
            if s.needsCount > s.items.count {
                Button("All \(s.needsCount)…") { open(section: .needsYou) }.foregroundStyle(MenuTheme.accent)
            }
            Divider()
            header("Quick message")
            Picker("To", selection: Binding(get: { target }, set: { recipient = $0 })) {
                ForEach(store.sortedAgents) { Text($0.name).tag(Optional($0.id)) }
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("menuRecipient")
            HStack {
                TextField("Message \(targetName)", text: $text).textFieldStyle(.roundedBorder).onSubmit(send)
                    .accessibilityIdentifier("menuMessage")
                Button("Send", action: send).buttonStyle(.plain).fontWeight(.semibold)
                    .foregroundStyle(MenuTheme.onAccent).padding(.horizontal, 12).padding(.vertical, 4)
                    .background(MenuTheme.accent.opacity(canSend ? 1 : 0.35), in: RoundedRectangle(cornerRadius: 6))
                    .disabled(!canSend)
                    .accessibilityIdentifier("menuSend")
            }
            if let result {
                Text(result.text).font(.caption).foregroundStyle(result.failed ? MenuTheme.failure : MenuTheme.working)
                    .accessibilityIdentifier("menuResult")
            }
            Divider()
            Button("Open Loft") { open(section: nil) }.foregroundStyle(MenuTheme.accent)
            Button("Quit Loft") { NSApp.terminate(nil) }.keyboardShortcut("q")
        }
        .buttonStyle(.plain)
        .padding(12)
        .frame(width: 320)
    }

    private func header(_ title: String) -> some View {
        Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary).textCase(.uppercase)
    }

    private var canSend: Bool { target != nil && !text.trimmingCharacters(in: .whitespaces).isEmpty }
    private var target: String? { recipient ?? store.quickRecipient }
    private var targetName: String { store.agent(target)?.name ?? "" }

    private func send() {
        guard let id = target, !text.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        let sent = text, name = targetName
        text = ""
        result = nil
        Task {
            if let why = await store.quickSend(sent, to: id) {
                // Kept, unless something new was typed meanwhile.
                if text.isEmpty { text = sent }
                result = (why, true)
            } else {
                result = ("Sent to \(name)", false)
                try? await Task.sleep(for: .seconds(3))
                if result?.failed == false { result = nil }
            }
        }
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

#if DEBUG
/// `-render-menubar <folder>`: draws the popover and the bar label to PNGs once Loft's data is in, then quits. For
/// screenshots where nobody can click the real menu bar item.
@MainActor
func renderMenuBar(store: LoftStore, nav: MacNav, to folder: String) async {
    for _ in 0..<100 where store.needsYou == nil { try? await Task.sleep(for: .milliseconds(100)) }
    try? await Task.sleep(for: .seconds(1))
    func png<V: View>(_ view: V, _ name: String) {
        let host = NSHostingView(rootView: view.environment(store).environment(nav).padding(8).background(Color(nsColor: .windowBackgroundColor)))
        host.frame = NSRect(origin: .zero, size: host.fittingSize)
        host.layoutSubtreeIfNeeded()
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return }
        host.cacheDisplay(in: host.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name).png"))
    }
    png(MenuBarContent(), "popover")
    png(MenuBarLabel(), "label")
    NSApp.terminate(nil)
}
#endif
