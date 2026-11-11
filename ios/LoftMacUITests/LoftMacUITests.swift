import XCTest

/// Loft for Mac on fixture data (`-ui-testing`): pairing, the agents list and sending with @ and #.
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

    /// Settings › Apple Intelligence on the fixture model status: unavailable says why and disables the switches;
    /// available enables them.
    func testAppleIntelligenceSettingsFollowTheModelStatus() {
        launch(["-ui-testing", "-fixture-ai-status", "off"])
        XCTAssertTrue(app.outlines["agentsList"].waitForExistence(timeout: 10))
        app.typeKey("5", modifierFlags: .command)
        let status = app.staticTexts["onDeviceModelStatus"]
        XCTAssertTrue(status.waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any)["onDeviceModelStatus"].exists)
        XCTAssertFalse(app.checkBoxes["aiRouteToggle"].isEnabled)
        shot("Apple Intelligence off")
        app.terminate()
        launch(["-ui-testing", "-fixture-ai-status", "available"])
        XCTAssertTrue(app.outlines["agentsList"].waitForExistence(timeout: 10))
        app.typeKey("5", modifierFlags: .command)
        XCTAssertTrue(app.checkBoxes["aiRouteToggle"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.checkBoxes["aiRouteToggle"].isEnabled)
        XCTAssertTrue(app.checkBoxes["aiChatRepliesToggle"].isEnabled)
        shot("Apple Intelligence available")
    }

    /// Clicking the chat's mic opens Talk with that agent in To:; Cancel returns to the chat.
    func testMicOpensTalkWithTheAgent() {
        launch(["-ui-testing", "-no-speech"])
        let list = app.outlines["agentsList"]
        XCTAssertTrue(list.waitForExistence(timeout: 10))
        list.cells.containing(.any, identifier: "agentRow-Orchestrator").firstMatch.click()
        let mic = app.descendants(matching: .any)["micButton"]
        XCTAssertTrue(mic.waitForExistence(timeout: 10))
        mic.click()
        XCTAssertTrue(app.buttons["talkCancel"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["talkTo-Orchestrator"].exists, "the agent is in To:")
        shot("Talk")
        app.buttons["talkCancel"].click()
        XCTAssertTrue(app.textFields["composerField"].waitForExistence(timeout: 5))
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
}
