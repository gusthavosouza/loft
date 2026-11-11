import Foundation

/// A Delivery as an issue page shows it (`GET /api/issues/{id}/delivery`, backend delivery.rs `delivery_json`).
/// A spec's also lists its tickets: "elsewhere" ones are being built outside it (`skipped` says why).
public struct IssueDelivery: Codable, Hashable {
    public struct Ticket: Codable, Hashable {
        public var number: Int
        public var title: String
        /// open | started | review | needs_human | closed | elsewhere
        public var state: String
        public var skipped: String
        /// The agent on it while it's started, in review, closing or needs you; nil otherwise.
        public var agentName: String? = nil
    }
    public struct Current: Codable, Hashable {
        public var number: Int
        public var title: String
    }
    /// The card's state line as the server words it: `tone` is running, stalled, paused, needs_you, final or done.
    public struct StateLine: Codable, Hashable {
        public var tone: String
        public var text: String
    }

    /// planned | running | final_review | final_fixes | needs_human | stalled | paused | ready | settled | merged
    public var state: String
    /// Why it stalled: run_failed, no_call or restart; nil unless stalled.
    public var stallReason: String? = nil
    /// The server's state line; nil before it started, and from a backend older than `state_line`.
    public var stateLine: StateLine? = nil
    /// Pause applies: it's running (its final review and fixes included), and no ticket waits for the user.
    public var canPause: Bool? = nil
    /// Resume applies: it's stalled or paused, or a ticket or its final review waits for the user.
    public var canResume: Bool? = nil
    /// A ticket, or the final review, waits for the user after too many change rounds.
    public var needsHuman: Bool? = nil
    public var started: Bool
    public var agentId: String?
    public var agentName: String?
    public var pr: Int?
    public var spec: Bool? = nil
    public var current: Current? = nil
    public var tickets: [Ticket]? = nil
    /// Ready tickets nobody has yet, while the Lead hands them out.
    public var waitingForLead: [Int]? = nil
    public var waitingOnYou: [Int]? = nil

    /// How a card's state line reads: the colour it takes.
    public enum Tone: String { case running, stalled, paused, needsYou = "needs_you", final, done }

    /// The line the card shows, or nil before it started: the server's `state_line` as is (a tone this build
    /// doesn't know takes running's colour). A backend older than it sends none, so it's worded here like the web
    /// card's fallback (deliveryState.ts): waiting for the user (a ticket after too many change rounds, or the
    /// final review) wins over running.
    public var line: (tone: Tone, text: String)? {
        guard started else { return nil }
        if let stateLine { return (Tone(rawValue: stateLine.tone) ?? .running, stateLine.text) }
        switch state {
        case "stalled": return (.stalled, "Stalled: \(Self.stallWhy(stallReason)).")
        case "paused": return (.paused, "Paused: Loft sends no wakes until you resume it.")
        case "needs_human": return (.needsYou, "Needs you: too many rounds of changes in the final review.")
        case "final_review": return (.final, "Final review: the Code reviewer is reviewing the whole PR.")
        case "final_fixes": return (.final, "Final review: the Dev is fixing what the Code reviewer found.")
        case "ready", "settled", "merged": return (.done, "Done: every review passed.")
        default: break
        }
        if needsHuman == true { return (.needsYou, "Needs you: a ticket had too many rounds of changes.") }
        return (.running, "Running.")
    }

    private static func stallWhy(_ reason: String?) -> String {
        switch reason {
        case "run_failed": "the run Loft woke for its step failed"
        case "restart": "its run was lost when Loft restarted"
        default: "the run Loft woke for its step ended without its call"
        }
    }

    /// Pause shows while it runs (final review included), Resume when it's stalled or paused or a ticket or the
    /// final review waits for the user: each only when the server says it applies, and only once it started.
    public var showsPause: Bool { started && canPause == true }
    public var showsResume: Bool { started && canResume == true }

    public var ticketsDone: Int { (tickets ?? []).filter { $0.state == "closed" }.count }
    public var skippedTickets: [Ticket] { (tickets ?? []).filter { $0.state == "elsewhere" } }
    /// Every ticket with an agent on it: "#43 Backend endpoints is with Backend Agent".
    public var runningLines: [String] { (tickets ?? []).compactMap { t in t.agentName.map { "#\(t.number) \(t.title) is with \($0)" } } }

    /// The progress line once it started: who has which ticket, on which PR and, for a spec, how many are done.
    public func progressLine(issue number: Int) -> String {
        let who = agentName ?? "the team"
        if spec == true {
            // Several tickets can run at once: the card lists each with its agent under this line.
            if !runningLines.isEmpty {
                return "\(pr.map { "On spec PR #\($0). " } ?? "")\(ticketsDone) of \((tickets ?? []).count) tickets done."
            }
            let with = current.map { "#\($0.number) \($0.title) is with \(who)" } ?? "With \(who)"
            return "\(with)\(pr.map { " on spec PR #\($0)" } ?? ""). \(ticketsDone) of \((tickets ?? []).count) tickets done."
        }
        if agentName != nil {
            return "With \(who)\(pr.map { " on PR #\($0)" } ?? ""). Its reviewers look at it next; #\(number) closes when the PR merges."
        }
        return "Started\(pr.map { " on PR #\($0)" } ?? ""); the agent building it is gone. #\(number) closes when the PR merges."
    }
}

/// A Delivery card button, as its endpoint names it (`POST /api/issues/{id}/<action>-delivery`).
public enum IssueDeliveryAction: String { case start, pause, resume }

/// A Delivery card button's answer: the Delivery as the card shows it now, and what the button did.
public struct IssueDeliveryReply: Decodable {
    public var delivery: IssueDelivery
    public var message: String?

    private enum Keys: String, CodingKey { case message }
    public init(from decoder: Decoder) throws {
        delivery = try IssueDelivery(from: decoder)
        message = try decoder.container(keyedBy: Keys.self).decodeIfPresent(String.self, forKey: .message)
    }
}

extension HBTask {
    private var openOnGitHub: Bool { !state.isClosed && github?.state == "open" }

    /// A standalone ticket on GitHub (open, `ready-for-agent`, under no spec): Loft runs it as a Delivery of its
    /// own. A spec's ticket has a parent, or names its spec in the ticket template's `## Parent` section.
    public var isStandaloneTicket: Bool {
        openOnGitHub && (labels ?? []).contains("ready-for-agent") && parentId == nil
            && description.range(of: #"(?m)^## Parent\s+#\d+"#, options: .regularExpression) == nil
    }

    /// An open spec on GitHub (labelled `spec`): Loft delivers its open sub-issues from its page.
    public var isDeliverableSpec: Bool { openOnGitHub && (labels ?? []).contains { $0.lowercased() == "spec" } }

    /// The issue page shows a Delivery card: on a standalone ticket or a spec.
    public var hasDeliveryCard: Bool { isStandaloneTicket || isDeliverableSpec }
}
