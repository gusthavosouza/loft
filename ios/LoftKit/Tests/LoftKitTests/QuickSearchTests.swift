import XCTest
@testable import LoftKit

/// The Mac's quick search: what a query matches and in which order.
final class QuickSearchTests: XCTestCase {
    private let agents = [Agent(id: "dev", name: "Loft mobile dev", status: "idle"), Agent(id: "qa", name: "Loft Mobile QA", status: "idle"),
                          Agent(id: "orch", name: "Orchestrator", status: "idle")]

    private func task(_ id: String, _ title: String, number: Int? = nil, labels: [String] = [], parent: String? = nil,
                      status: String = "ready", updated: Date = Date()) -> HBTask {
        var t = HBTask(id: id, title: title, description: "", kind: "work", status: status, priority: "normal", project: "loft", agentId: nil,
                       parentId: parent, dependsOn: [], dueAt: nil, createdBy: "user", note: "", summary: "", error: "", createdAt: updated,
                       updatedAt: updated)
        t.labels = labels
        t.github = number.map { .init(repo: "o/loft", number: $0, url: "", state: "open") }
        return t
    }

    private func search(_ q: String, tasks: [HBTask] = []) -> [QuickSearch.Result] {
        QuickSearch.results(q, agents: agents, tasks: tasks, deliveries: [])
    }

    func testAnEmptyQueryFindsNothing() {
        XCTAssertEqual(search("  "), [])
    }

    func testKindsAreTold() {
        let tasks = [task("s", "Mac quick search", number: 456, labels: ["spec"]), task("t", "Quick search panel", number: 459, parent: "s"),
                     task("i", "Quick fix for search")]
        let r = search("quick", tasks: tasks)
        XCTAssertEqual(Dictionary(uniqueKeysWithValues: r.map { ($0.target, $0.kind) }), ["s": .spec, "t": .ticket, "i": .issue])
        XCTAssertEqual(r.first { $0.target == "t" }?.number, "loft#459")
        XCTAssertNil(r.first { $0.target == "i" }?.number)
    }

    func testRankingWholeTitleThenStartThenWordThenAnywhereThenInitials() {
        XCTAssertEqual(QuickSearch.score("orchestrator", title: "Orchestrator"), 1)
        XCTAssertEqual(QuickSearch.score("orch", title: "Orchestrator"), 2)
        XCTAssertEqual(QuickSearch.score("qa", title: "Loft Mobile QA"), 3)
        XCTAssertEqual(QuickSearch.score("bile", title: "Loft Mobile QA"), 4)
        XCTAssertEqual(QuickSearch.score("lmq", title: "Loft Mobile QA"), 5)
        XCTAssertNil(QuickSearch.score("zz", title: "Loft Mobile QA"))
        XCTAssertEqual(search("lo").map(\.target), ["dev", "qa"], "Both start with it, by name")
        XCTAssertEqual(search("qa").first?.target, "qa")
    }

    func testLettersInOrderOnlyOnWordInitialsFromThreeLetters() {
        XCTAssertNil(QuickSearch.score("needs", title: "Implement backend endpoints"), "Not letters spread inside words")
        XCTAssertNil(QuickSearch.score("lm", title: "Loft Mobile QA"), "Too short")
        XCTAssertEqual(QuickSearch.score("lmq", title: "Loft Mobile QA"), 5)
        XCTAssertEqual(QuickSearch.score("l mq", title: "Loft Mobile QA"), 5)
    }

    func testANumberFindsItsIssueFirst() {
        let tasks = [task("a", "Ship 459 things"), task("t", "Quick search panel", number: 459)]
        for q in ["459", "#459", "loft#459"] { XCTAssertEqual(search(q, tasks: tasks).first?.target, "t", q) }
    }

    func testEqualMatchesPutOpenFirstThenAgentsSpecsTicketsIssuesThenTheLatest() {
        let old = Date(timeIntervalSince1970: 0)
        let tasks = [task("closed", "Search", status: "done"), task("issue-old", "Search", updated: old), task("issue-new", "Search"),
                     task("spec", "Search", labels: ["spec"], updated: old)]
        XCTAssertEqual(search("search", tasks: tasks).map(\.target), ["spec", "issue-new", "issue-old", "closed"])
    }

    func testPagesAreFoundAndThoseTheMacLacksAreWebOnly() {
        let r = search("simu")
        XCTAssertEqual(r.first?.kind, .page)
        XCTAssertEqual(r.first?.webPath, "/simulator")
        XCTAssertEqual(r.first?.webOnly, true)
        XCTAssertEqual(search("clean").first?.webOnly, true)
        XCTAssertEqual(search("needs").first { $0.kind == .page }?.webOnly, false)
    }

    func testWebPaths() {
        let r = search("search", tasks: [task("t1", "Search")])
        XCTAssertEqual(r.first?.webPath, "/issues/t1")
        XCTAssertEqual(search("orch").first?.webPath, "/agents/orch")
    }
}
