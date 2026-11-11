import XCTest

/// Loft for Mac on fixture data (`-ui-testing`): pairing, the agents list, sending with @ and #, Overview, Needs you
/// and Settings with Clean.
final class LoftMacUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
    }

    override func tearDown() {
        app.terminate()
    }

    private func launch(_ args: [String]) {
        app.launchArguments = args
        app.launch()
        app.activate()
    }

    private func shot(_ name: String) {
        let a = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }

    /// First launch: the address screen says so when nothing answers there, and keeps the address unsaved.
    func testWrongAddressSaysLoftIsNotReachable() {
        launch(["-ui-onboarding"])
        let field = app.textFields["serverAddressField"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        XCTAssertEqual(field.value as? String, "http://localhost:7420")
        field.click()
        field.typeKey("a", modifierFlags: .command)
        field.typeText("http://127.0.0.1:9\r")
        XCTAssertTrue(app.staticTexts["connectError"].waitForExistence(timeout: 20))
        shot("Can't reach Loft")
        XCTAssertTrue(field.exists, "Still on the address screen")
    }

    /// An unpaired Mac shows the code, and once Loft allows it the agents open.
    func testPairsThenOpensAgents() {
        launch(["-ui-testing", "-fixture-unpaired", "-fixture-pairing"])
        let code = app.staticTexts["pairingCode"]
        XCTAssertTrue(code.waitForExistence(timeout: 10))
        shot("Pair this Mac")
        XCTAssertTrue(app.outlines["agentsList"].waitForExistence(timeout: 15), "Pairing finished and the agents show")
    }

    /// Leads first, then groups; an agent's settings save.
    func testAgentsLeadsFirstAndSettingsSave() {
        launch(["-ui-testing", "-fixture-lead"])
        let list = app.outlines["agentsList"]
        XCTAssertTrue(list.waitForExistence(timeout: 10))
        let leads = list.staticTexts["Leads"], loft = list.staticTexts["Loft"]
        XCTAssertTrue(leads.waitForExistence(timeout: 10))
        XCTAssertTrue(loft.exists)
        XCTAssertLessThan(leads.frame.minY, loft.frame.minY, "Leads come before the groups")

        list.cells.containing(.any, identifier: "agentRow-Backend Agent").firstMatch.click()
        app.buttons["agentSettingsButton"].click()
        let name = app.textFields["settingsName"]
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        name.click()
        name.typeKey("a", modifierFlags: .command)
        name.typeText("API Agent")
        app.buttons["settingsSave"].click()
        XCTAssertTrue(list.descendants(matching: .any)["agentRow-API Agent"].waitForExistence(timeout: 5))
        shot("Agents and settings")
    }

    /// @ and # pick from lists as on the web, and the message is sent with both tags.
    func testSendWithMentionAndTag() {
        launch(["-ui-testing"])
        let list = app.outlines["agentsList"]
        XCTAssertTrue(list.waitForExistence(timeout: 10))
        list.cells.containing(.any, identifier: "agentRow-Orchestrator").firstMatch.click()
        // Another agent's handover is incoming, not one of the user's own messages.
        let handover = app.descendants(matching: .any).matching(identifier: "agentMessage")
            .matching(NSPredicate(format: "label BEGINSWITH %@", "From Backend Agent")).firstMatch
        XCTAssertTrue(handover.waitForExistence(timeout: 10))

        let field = app.textFields["composerField"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.click()
        field.typeText("@Bac")
        let mention = app.buttons["mention-Backend Agent"]
        XCTAssertTrue(mention.waitForExistence(timeout: 5))
        shot("@ picker")
        mention.click()
        XCTAssertEqual(field.value as? String, "@Backend Agent ")

        field.typeText("please check #")
        XCTAssertTrue(app.otherElements["suggestions"].waitForExistence(timeout: 5) || app.scrollViews["suggestions"].exists)
        shot("# picker")
        // Return picks the first suggestion while the list shows.
        field.typeText("\r")
        let withTag = field.value as? String ?? ""
        XCTAssertTrue(withTag.hasPrefix("@Backend Agent please check #"), withTag)
        XCTAssertNotEqual(withTag, "@Backend Agent please check #")

        field.typeText("\r")
        let sent = app.descendants(matching: .any).matching(identifier: "userMessage").matching(NSPredicate(format: "label CONTAINS %@", "@Backend Agent please check #")).firstMatch
        XCTAssertTrue(sent.waitForExistence(timeout: 10))
        XCTAssertEqual(field.value as? String, "")
        shot("Sent with @ and #")
    }

    /// ⌘N opens New message, and picking an agent opens its chat.
    func testNewMessageShortcut() {
        launch(["-ui-testing"])
        XCTAssertTrue(app.outlines["agentsList"].waitForExistence(timeout: 10))
        app.typeKey("5", modifierFlags: .command)
        XCTAssertTrue(app.textFields["serverAddressField"].waitForExistence(timeout: 5), "⌘5 opens Settings")
        app.typeKey("n", modifierFlags: .command)
        let search = app.textFields["recipientSearch"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.typeText("QA\r")
        XCTAssertTrue(app.textFields["composerField"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.textFields["composerField"].placeholderValue, "Message QA Agent")
    }

    /// ⌘1: the web's home summary, and a card per agent.
    func testOverviewShowsSummary() {
        launch(["-ui-testing"])
        XCTAssertTrue(app.outlines["agentsList"].waitForExistence(timeout: 10))
        app.typeKey("1", modifierFlags: .command)
        let stats = app.descendants(matching: .any)["overviewStats"]
        XCTAssertTrue(stats.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["REPOSITORIES"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any)["agentCard-Backend Agent"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Loft for Mac"].waitForExistence(timeout: 5), "Open pull requests list the fixture's PR")
        shot("Overview")
    }

    /// ⌘4: a question's Reply opens a sheet; Send answers it and the item goes.
    func testNeedsYouReply() {
        launch(["-ui-testing"])
        XCTAssertTrue(app.outlines["agentsList"].waitForExistence(timeout: 10))
        app.typeKey("4", modifierFlags: .command)
        let row = app.descendants(matching: .any)["needsYou-question:1"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        shot("Needs you")
        row.buttons["needsYouAnswer"].click()
        let field = app.textViews["needsYouAnswerField"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.click()
        field.typeText("B2, please")
        shot("Needs you reply")
        app.buttons["needsYouAnswerSend"].click()
        XCTAssertTrue(app.descendants(matching: .any)["needsYouNotice"].waitForExistence(timeout: 5))
        let gone = NSPredicate(format: "exists == false")
        expectation(for: gone, evaluatedWith: row)
        waitForExpectations(timeout: 10)
    }

    /// Settings › Disk › Check space: tick one item, Delete selected, and the log says what was freed.
    func testCleanRun() {
        launch(["-ui-testing"])
        XCTAssertTrue(app.outlines["agentsList"].waitForExistence(timeout: 10))
        app.typeKey("5", modifierFlags: .command)
        let check = app.buttons["checkSpace"]
        XCTAssertTrue(check.waitForExistence(timeout: 10))
        XCTAssertTrue(check.isEnabled)
        check.click()
        XCTAssertTrue(app.descendants(matching: .any)["left-a2"].waitForExistence(timeout: 10), "Loft Reviewer's leftover processes show")
        let tick = app.checkBoxes["tick-test-run.log"]
        XCTAssertTrue(tick.waitForExistence(timeout: 10))
        XCTAssertFalse(app.checkBoxes["tick-loft"].firstMatch.isEnabled, "A main clone that isn't checked can't be ticked")
        tick.click()
        XCTAssertEqual(app.staticTexts["cleanSummary"].value as? String ?? app.staticTexts["cleanSummary"].label, "1 selected · 12 MB")
        shot("Clean")
        app.buttons["cleanConfirm"].click()
        let summary = app.staticTexts["cleanLogSummary"]
        XCTAssertTrue(summary.waitForExistence(timeout: 10))
        let text = summary.value as? String ?? summary.label
        XCTAssertTrue(text.hasPrefix("Freed 12 MB · 1 removed"), text)
        shot("Clean log")
        app.buttons["cleanDone"].click()
        XCTAssertTrue(app.descendants(matching: .any)["lastClean"].waitForExistence(timeout: 10), "Disk shows the run")
    }

    /// Settings: a change shows Save, saving keeps it, and paired devices list.
    func testSettingsSave() {
        launch(["-ui-testing"])
        XCTAssertTrue(app.outlines["agentsList"].waitForExistence(timeout: 10))
        app.typeKey("5", modifierFlags: .command)
        let toggle = app.descendants(matching: .any)["messagingRulesToggle"].firstMatch
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        XCTAssertEqual(toggle.value as? Int, 1)
        toggle.click()
        let save = app.buttons["settingsSaveAll"]
        XCTAssertTrue(save.waitForExistence(timeout: 5))
        save.click()
        let gone = NSPredicate(format: "exists == false")
        expectation(for: gone, evaluatedWith: save)
        waitForExpectations(timeout: 10)
        app.typeKey("1", modifierFlags: .command)
        app.typeKey("5", modifierFlags: .command)
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        XCTAssertEqual(toggle.value as? Int, 0, "Saved off, and loaded again off")
        XCTAssertTrue(app.descendants(matching: .any)["paired-iPhone"].waitForExistence(timeout: 10))
        shot("Settings")
    }
}
