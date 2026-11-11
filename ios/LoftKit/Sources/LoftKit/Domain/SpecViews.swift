import Foundation

/// `GET /api/deliveries/summary`: a spec's Delivery, with the spec it belongs to (backend `delivery::summary_route`).
public struct DeliverySummary: Codable, Hashable {
    public var state: String
    public var agentName: String?
    public var repo: String
    public var spec: Int
    public var specId: String?
    public var local: Bool
    /// The spec PR's number, once there is one.
    public var pr: Int? = nil
    public var current: Current?
    public var tickets: [Ticket]
    /// Ready tickets nobody has yet, while the Lead hands them out.
    public var waitingForLead: [Int]? = nil
    public var waitingOnYou: [Int]? = nil

    public struct Current: Codable, Hashable { public var number: Int; public var title: String }
    public struct Ticket: Codable, Hashable {
        public var number: Int
        public var title: String
        public var state: String
        /// The ticket's own Loft issue, for a plan kept in Loft.
        public var id: String? = nil
        /// The agent on it while it's started, in review, closing or needs you; nil otherwise.
        public var agentName: String? = nil
        /// Review role (qa, security…) to `pass` or still waiting.
        public var verdicts: [String: String]? = nil
    }
}

/// Where a spec stands; the same rules as the web's `specViews.ts`.
public enum SpecStage: String, CaseIterable, Identifiable {
    case planned, delivery, ready, shipped, dropped

    public var id: String { rawValue }
    public var label: String {
        switch self {
        case .planned: "Planned"
        case .delivery: "In Delivery"
        case .ready: "Ready to merge"
        case .shipped: "Shipped"
        case .dropped: "Dropped"
        }
    }
}

public enum SpecViews {
    public static func isSpec(_ t: HBTask) -> Bool { (t.labels ?? []).contains { $0.lowercased() == "spec" } }

    /// Deliveries by the spec they belong to: a plan kept in Loft by its issue, a GitHub spec by repo and number.
    public static func index(_ all: [DeliverySummary]) -> [String: DeliverySummary] {
        Dictionary(all.compactMap { d in (d.local ? d.specId.map { "id:\($0)" } : "\(d.repo)#\(d.spec)").map { ($0, d) } },
                   uniquingKeysWith: { first, _ in first })
    }

    /// The Delivery of a spec's issue, from `index(_:)`.
    public static func delivery(of spec: HBTask, in index: [String: DeliverySummary]) -> DeliverySummary? {
        index["id:\(spec.id)"] ?? spec.github.flatMap { index["\($0.repo)#\($0.number)"] }
    }

    /// A Delivery's state in a few words, the same in a spec's row and its detail.
    public static func deliveryLabel(_ state: String) -> String {
        switch state {
        case "planned": "Not started"
        case "running": "Running"
        case "needs_human": "Needs you"
        case "ready", "settled": "Ready to merge"
        case "merged": "Merged"
        default: state.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    /// Who is on which ticket, one line per running ticket: "Backend Agent on #43 Backend endpoints".
    public static func onIt(_ d: DeliverySummary) -> [String] {
        d.tickets.compactMap { t in t.agentName.map { "\($0) on #\(t.number) \(t.title)" } }
    }

    /// "Waiting for the Lead to assign #44, #47", or nil when no ready ticket waits.
    public static func waitingLine(_ numbers: [Int]?) -> String? {
        guard let numbers, !numbers.isEmpty else { return nil }
        return "Waiting for the Lead to assign " + numbers.map { "#\($0)" }.joined(separator: ", ")
    }

    /// "Waiting on you: #44", or nil when no ticket waits for the user.
    public static func waitingOnYouLine(_ numbers: [Int]?) -> String? {
        guard let numbers, !numbers.isEmpty else { return nil }
        return "Waiting on you: " + numbers.map { "#\($0)" }.joined(separator: ", ")
    }

    /// Merged, or closed as completed, is Shipped; closed as not planned is Dropped; no Delivery or not started is Planned;
    /// ready or settled is Ready to merge; the rest is In Delivery.
    public static func stage(of spec: HBTask, _ d: DeliverySummary?) -> SpecStage {
        if d?.state == "merged" { return .shipped }
        if spec.state.isClosed { return spec.state == .cancelled ? .dropped : .shipped }
        guard let d, d.state != "planned" else { return .planned }
        return d.state == "ready" || d.state == "settled" ? .ready : .delivery
    }

    /// `owner/repo#12`, or Loft and the project of a plan kept in Loft.
    public static func ref(_ spec: HBTask) -> String {
        if let g = spec.github { return "\(g.repo)#\(g.number)" }
        return "Loft" + (spec.project.isEmpty ? "" : " · \(spec.project)")
    }

    /// Tickets done of all: the Delivery's, else GitHub's sub-issue count, else the spec's sub-issues in Loft; nil when none.
    public static func progress(of spec: HBTask, _ d: DeliverySummary?, tasks: [HBTask]) -> (done: Int, total: Int)? {
        if let d, !d.tickets.isEmpty { return (d.tickets.filter { $0.state == "closed" }.count, d.tickets.count) }
        if let g = spec.github, let total = g.subTotal, total > 0 { return (g.subDone ?? 0, total) }
        let kids = tasks.filter { $0.parentId == spec.id && $0.state != .cancelled }
        return kids.isEmpty ? nil : (kids.filter { $0.state == .done }.count, kids.count)
    }

    /// A ticket as the spec's detail lists it, with its own issue (to open it) when Loft has one.
    public struct TicketLine: Identifiable, Hashable {
        public let id: String
        public var number: Int?
        public var title: String
        public var state: String
        public var taskId: String?
        public var verdicts: [String: String]
        public var current: Bool
    }

    /// A spec's tickets: its Delivery's when it has them, else its sub-issues in Loft (the web's `ticketsOf`).
    public static func tickets(of spec: HBTask, _ d: DeliverySummary?, tasks: [HBTask]) -> [TicketLine] {
        if let d, !d.tickets.isEmpty {
            return d.tickets.map { t in
                let own = t.id.flatMap { id in tasks.first { $0.id == id } }
                    ?? tasks.first { x in spec.github.map { x.github?.repo == $0.repo && x.github?.number == t.number } ?? false }
                return TicketLine(id: "\(t.number)", number: own?.github?.number ?? t.number, title: t.title, state: t.state,
                                  taskId: own?.id, verdicts: t.verdicts ?? [:], current: t.agentName != nil)
            }
        }
        return tasks.filter { $0.parentId == spec.id && $0.state != .cancelled }.map { x in
            let state = x.state == .done ? "closed" : x.state == .inProgress ? "started" : [.blocked, .failed, .waitingApproval].contains(x.state) ? "needs_human" : "open"
            return TicketLine(id: x.id, number: x.github?.number, title: x.title, state: state, taskId: x.id, verdicts: [:], current: false)
        }
    }

    /// A ticket's state in a few words (the web's `ticketLabel`).
    public static func ticketLabel(_ state: String) -> String {
        switch state {
        case "closed": "done"
        case "started": "building"
        case "review": "in review"
        case "closing": "closing"
        case "needs_human": "Waiting on you"
        case "elsewhere": "elsewhere"
        default: "open"
        }
    }

    /// Merge: a plan kept in Loft whose reviews passed; a spec on GitHub merges there.
    public static func canMerge(_ spec: HBTask, _ d: DeliverySummary?) -> Bool {
        d?.local == true && d?.state == "ready" && !spec.state.isClosed
    }

    /// Whether an issue is in a group: the group's agents' projects, and the issues assigned to one of them.
    public static func inGroup(_ t: HBTask, _ group: String, agents: [Agent]) -> Bool {
        agents.contains { $0.team == group && ((!t.project.isEmpty && $0.allProjects.contains(t.project)) || $0.id == t.agentId) }
    }
}

/// The Issues board as the web shows it (`SpecBoard.tsx`): the Issues column, the spec stage columns, or both.
public enum BoardType: String, CaseIterable, Identifiable {
    case all, issues, specs

    public var id: String { rawValue }
    public var label: String {
        switch self {
        case .all: "All"
        case .issues: "Issues"
        case .specs: "Specs"
        }
    }
}

extension SpecViews {
    /// A spec's ticket: it has a parent, names its spec in the template's `## Parent` section, or is in a Delivery's
    /// tickets (the web's `isSpecTicket`).
    public static func isSpecTicket(_ t: HBTask, _ deliveries: [DeliverySummary]) -> Bool {
        t.parentId != nil
            || t.description.range(of: #"(?m)^## Parent\s+#\d+"#, options: .regularExpression) != nil
            || deliveries.contains { d in
                d.tickets.contains { x in x.id.map { $0 == t.id } ?? (t.github.map { d.repo == $0.repo && x.number == $0.number } ?? false) }
            }
    }

    /// The board's Issues column: the issues that are no spec and no spec's ticket, closed ones only when asked for,
    /// open ones first, then the most recently updated (the web's `boardIssues`).
    public static func boardIssues(_ tasks: [HBTask], _ deliveries: [DeliverySummary], showClosed: Bool) -> [HBTask] {
        tasks.filter { !isSpec($0) && !isSpecTicket($0, deliveries) && (showClosed || !$0.state.isClosed) }
            .sorted { a, b in a.state.isClosed != b.state.isClosed ? !a.state.isClosed : a.updatedAt > b.updatedAt }
    }

    /// The specs in one stage column, the most recently updated first.
    public static func specs(_ tasks: [HBTask], in stage: SpecStage, _ index: [String: DeliverySummary]) -> [HBTask] {
        tasks.filter { isSpec($0) && self.stage(of: $0, delivery(of: $0, in: index)) == stage }
            .sorted { $0.updatedAt > $1.updatedAt }
    }
}
