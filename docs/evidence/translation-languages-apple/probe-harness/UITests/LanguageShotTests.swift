import XCTest

// TEMPORARY evidence probe (never merged), task 34xweTmJeaYjcJmKAkO4P (Translation languages, macOS/iOS):
// Settings › Translation with a non-English agent language (Japanese) on the iPhone and the Mac, both
// pickers over the one shared list, and the composer tag naming the agent language. stub.py serves an
// account that writes Chinese (Simplified) and has agents work in Japanese, and merges a PATCH of
// /users/me/preferences as the server does. Every claim is a note (`shown` / `MISSING`) and an
// assertion; the pictures are kept either way.
final class LanguageShotTests: ProbeCase {
    private let japaneseFooter = "Agents read and write in Japanese; you write and read in your language."
    private let koreanFooter = "Agents read and write in Korean; you write and read in your language."

    private func claim(_ what: String, _ holds: Bool, file: StaticString = #filePath, line: UInt = #line) {
        note("\(holds ? "shown" : "MISSING"): \(what)")
        XCTAssertTrue(holds, what, file: file, line: line)
    }

    private func openSettings(_ name: String) -> XCUIApplication {
        let app = launch(until: "Translate conversations", extra: ["-probe.settings"], name)
        settle(1)
        #if os(iOS)
        bring(app, element(app, containing: "Agents work in"), between: 120, and: 560, name)
        #else
        bring(app, element(app, containing: japaneseFooter), between: 80, and: 520, name)
        #endif
        settle(1.2)
        return app
    }

    func test1SettingsNamesTheAgentLanguage() {
        let app = openSettings("settings")
        shot(app, "01-settings-translation-japanese")
        write(app.debugDescription, "tree-01-settings-translation-japanese.txt")
        claim("Agents work in is shown", element(app, containing: "Agents work in").exists)
        claim("…set to Japanese", element(app, containing: "Japanese").exists)
        claim("Your language reads Chinese (Simplified)", element(app, containing: "Chinese (Simplified)").exists)
        claim("the footer names Japanese", element(app, containing: japaneseFooter).exists)
        claim("…and not a fixed English", !element(app, containing: "Agents read and write in English").exists)

        #if os(iOS)
        // Agents work in is a pushed list, like Your language: the whole shared list, Japanese ticked.
        press(element(app, containing: "Agents work in"))
        settle(1.5)
        shot(app, "02-agents-work-in-list")
        write(app.debugDescription, "tree-02-agents-work-in-list.txt")
        for lang in ["English", "Chinese (Simplified)", "Japanese", "Korean", "Russian"] {
            claim("the agent list offers \(lang)", element(app, containing: lang).exists)
        }
        claim("its hint is shown", element(app, containing: "What the agent receives and answers in.").exists)
        bring(app, element(app, containing: "Bengali"), between: 120, and: 760, "agent-list-end")
        shot(app, "03-agents-work-in-list-end")
        for lang in ["Hungarian", "Romanian", "Malay", "Bengali"] {
            claim("the agent list reaches \(lang)", element(app, containing: lang).exists)
        }
        // Picking one writes the account's agent language.
        bring(app, element(app, containing: "Korean"), between: 120, and: 760, "korean")
        press(element(app, containing: "Korean"))
        settle(2)
        claim("picking Korean PATCHes translationAgentLanguage ko",
              requestsLog().contains("\"translationAgentLanguage\":\"ko\""))
        app.navigationBars.buttons.element(boundBy: 0).tap()
        settle(1.5)
        bring(app, element(app, containing: "Agents work in"), between: 120, and: 560, "after-pick")
        shot(app, "04-settings-after-picking-korean")
        write(app.debugDescription, "tree-04-settings-after-picking-korean.txt")
        claim("the footer now names Korean", element(app, containing: koreanFooter).exists)
        // Your language offers the same list, English included.
        press(element(app, containing: "Your language"))
        settle(1.5)
        shot(app, "05-your-language-list")
        claim("Your language offers English", element(app, containing: "English").exists)
        bring(app, element(app, containing: "Bengali"), between: 120, and: 760, "owner-list-end")
        claim("Your language reaches Bengali", element(app, containing: "Bengali").exists)
        #else
        // Agents work in is a picker like Your language, over the whole shared list.
        let picker = app.popUpButtons["settings.translation.agentLanguage"].exists
            ? app.popUpButtons["settings.translation.agentLanguage"]
            : app.descendants(matching: .any)["settings.translation.agentLanguage"]
        claim("Agents work in is a picker", picker.exists)
        claim("…its value Japanese", (picker.value as? String)?.contains("Japanese") == true
              || element(app, containing: "Japanese").exists)
        let own = app.popUpButtons["settings.translation.language"]
        note("Your language picker exists=\(own.exists) value=\(String(describing: own.exists ? own.value : nil))")
        if picker.exists {
            picker.click()
            settle(1.2)
            screen("02-agents-work-in-menu")
            write(app.debugDescription, "tree-02-agents-work-in-menu.txt")
            for lang in ["English", "Chinese (Simplified)", "Japanese", "Korean", "Russian", "Malay", "Bengali"] {
                claim("the agent menu offers \(lang)", app.menuItems[lang].exists)
            }
            note("agent menu items: \(app.menuItems.count)")
            let korean = app.menuItems["Korean"]
            if korean.exists { korean.click() } else { app.typeKey(.escape, modifierFlags: []) }
            settle(2)
            claim("picking Korean PATCHes translationAgentLanguage ko",
                  requestsLog().contains("\"translationAgentLanguage\":\"ko\""))
            bring(app, element(app, containing: koreanFooter), between: 80, and: 520, "after-pick")
            shot(app, "03-settings-after-picking-korean")
            write(app.debugDescription, "tree-03-settings-after-picking-korean.txt")
            claim("the switch's line now names Korean", element(app, containing: koreanFooter).exists)
        }
        if own.exists {
            own.click()
            settle(1.2)
            screen("04-your-language-menu")
            claim("Your language offers English", app.menuItems["English"].exists)
            claim("Your language offers Bengali", app.menuItems["Bengali"].exists)
            app.typeKey(.escape, modifierFlags: [])
        }
        #endif
    }

    func test2ComposerTagNamesTheAgentLanguage() {
        let app = launch(until: "Chinese → Japanese", extra: ["-probe.session", "T1"], "composer")
        settle(1.5)
        shot(app, "06-composer-tag-chinese-japanese")
        write(app.debugDescription, "tree-06-composer-tag.txt")
        claim("the composer tag reads Chinese → Japanese", element(app, containing: "Chinese → Japanese").exists)
        claim("…not Chinese → English", !element(app, containing: "Chinese → English").exists)
    }
}
