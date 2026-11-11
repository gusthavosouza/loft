import Foundation

/// What the Mac menu bar item shows (spec #382): who is working now, the Needs you count and the first few items.
@MainActor
public struct MenuBarSummary {
    public struct Item: Identifiable, Hashable {
        public let id: String
        public let title: String
        public let agentId: String?
    }

    public static let itemLimit = 5

    public let working: [Agent]
    public let needsCount: Int
    public let items: [Item]

    public init(_ store: LoftStore) {
        working = store.sortedAgents.filter { store.state(of: $0) == .working }
        let list = store.needsYou
        needsCount = list?.count ?? 0
        items = (list?.items ?? []).prefix(Self.itemLimit).map {
            Item(id: $0.id, title: $0.title, agentId: $0.openAction?.target?.agentId ?? $0.agent?.id)
        }
    }
}
