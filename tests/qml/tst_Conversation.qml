import QtQuick
import QtTest
import "../../desktop" as Desktop

TestCase {
    id: test
    name: "Conversation"
    visible: true
    width: 448
    height: 640
    when: windowShown

    SignalSpy { id: closeSpy; signalName: "closeRequested" }
    Component { id: serviceComponent; Desktop.Service {} }
    Loader {
        id: unloadLoader
        active: false
        sourceComponent: Component {
            Desktop.Conversation {
                width: 448; height: 640
                background: "#121212"; ink: "#bebebe"; accentInk: "#e68e0d"; troubleInk: "#D35F5F"
            }
        }
    }
    Component {
        id: announcementComponent
        Desktop.Conversation {
            signal announcementRequested(string text)
            function announceTurn(text) { announcementRequested(text) }
        }
    }

    function test_announcements_follow_visible_session_updates() {
        const requests = []
        function makeContent() {
            const content = createTemporaryObject(announcementComponent, test, {
                width: 448, height: 640, background: "#121212", ink: "#bebebe",
                accentInk: "#e68e0d", troubleInk: "#D35F5F"
            })
            verify(content !== null)
            compare(typeof content.announceTurn, "function")
            content.announcementRequested.connect(function(text) { requests.push(text) })
            return content
        }
        function settle() {
            let settled = false
            Qt.callLater(function() { settled = true })
            tryVerify(function() { return settled })
        }
        function session(content, value) {
            if (content.conversationSession !== undefined) content.conversationSession = value
        }
        function shown(content, value) {
            content.visible = value
            if (content.announcementsEnabled !== undefined) content.announcementsEnabled = value
        }
        let content = makeContent()
        shown(content, true)
        const history = [{speaker: "you", text: "Existing owner turn.", state: "complete"},
            {speaker: "kestrel", text: "Existing reply.", state: "complete"}]
        session(content, "session-a")
        content.turns = history
        settle()
        compare(JSON.stringify(requests), "[]", "initial history must be a silent baseline")
        content.turns = history.concat([{speaker: "kestrel", text: "", state: "thinking"}])
        settle()
        content.turns = history.concat([{speaker: "kestrel", text: "Live", state: "speaking"}])
        settle()
        compare(JSON.stringify(requests), "[]", "streaming updates must be silent")
        const live = history.concat([{speaker: "kestrel", text: "Live reply.", state: "complete"}])
        content.turns = live
        settle()
        content.turns = JSON.parse(JSON.stringify(live))
        settle()
        compare(JSON.stringify(requests), '["Kestrel: Live reply."]')
        requests.length = 0
        shown(content, false)
        settle()
        const hidden = live.concat([{speaker: "kestrel", text: "Hidden reply.", state: "complete"}])
        content.turns = hidden
        settle()
        compare(JSON.stringify(requests), "[]", "hidden updates must be silent")
        shown(content, true)
        settle()
        content.turns = JSON.parse(JSON.stringify(hidden))
        settle()
        compare(JSON.stringify(requests), "[]", "reopening must not replay history")
        const interrupted = hidden.concat([{speaker: "kestrel", text: "Heard prefix.", state: "interrupted"}])
        content.turns = interrupted
        settle()
        const failed = interrupted.concat([{speaker: "kestrel", text: "", state: "failed"}])
        content.turns = failed
        settle()
        compare(JSON.stringify(requests), '["Kestrel: Heard prefix. Reply interrupted.","Kestrel:  Reply could not be completed."]')
        requests.length = 0
        session(content, "")
        content.turns = []
        settle()
        compare(content.displayedTurns.length, 0)
        compare(JSON.stringify(requests), "[]", "unavailable must be silent")
        session(content, "session-a")
        content.turns = failed
        settle()
        compare(JSON.stringify(requests), "[]", "same-session reconnect must not replay history")
        content.turns = failed.concat([{speaker: "kestrel", text: "After reconnect.", state: "complete"}])
        settle()
        compare(JSON.stringify(requests), '["Kestrel: After reconnect."]')
        requests.length = 0
        session(content, "session-b")
        content.turns = history
        settle()
        compare(JSON.stringify(requests), "[]", "new session history must be silent")
        content.turns = history.concat([{speaker: "you", text: "New live turn.", state: "complete"}])
        settle()
        compare(JSON.stringify(requests), '["You: New live turn."]')
        requests.length = 0
        content.destroy()
        settle()
        content = makeContent()
        shown(content, true)
        session(content, "session-b")
        content.turns = history
        settle()
        compare(JSON.stringify(requests), "[]", "recreated component must not replay history")
        content.turns = history.concat([{speaker: "kestrel", text: "After recreation.", state: "complete"}])
        settle()
        compare(JSON.stringify(requests), '["Kestrel: After recreation."]')
        requests.length = 0
        const service = createTemporaryObject(serviceComponent, test)
        verify(service !== null)
        content = makeContent()
        content.turns = Qt.binding(function() { return service.turns })
        content.conversationSession = Qt.binding(function() { return service.conversationSession })
        shown(content, true)
        const wired = [{speaker: "you", text: "Existing turn.", state: "complete"}]
        verify(service.acceptConversationChunk(JSON.stringify({version: 1, session: "same-session", turns: wired}) + "\n"))
        settle()
        compare(JSON.stringify(requests), "[]", "accepted history must be a silent baseline")
        const returned = wired.concat([{speaker: "kestrel", text: "Completed during disconnection.", state: "complete"}])
        verify(service.acceptConversationChunk(JSON.stringify({unavailable: "Conversation unavailable. Reopen the panel."})
            + "\n" + JSON.stringify({version: 1, session: "same-session", turns: returned}) + "\n"))
        settle()
        compare(JSON.stringify(requests), "[]", "same-session reconnect history must stay silent when records share a chunk")
        verify(service.acceptConversationChunk(JSON.stringify({version: 1, session: "same-session",
            turns: returned.concat([{speaker: "kestrel", text: "After batched reconnect.", state: "complete"}])}) + "\n"))
        settle()
        compare(JSON.stringify(requests), '["Kestrel: After batched reconnect."]')
    }

    function test_unload_with_pending_scroll_is_quiet() {
        failOnWarning(/.*TypeError.*contentHeight.*/)
        unloadLoader.active = true
        verify(unloadLoader.item !== null)
        unloadLoader.item.updateTurns()
        unloadLoader.active = false
        compare(unloadLoader.item, null)
        let settled = false
        Qt.callLater(function() { settled = true })
        tryVerify(function() { return settled })
    }

    function test_plain_text_keyboard_and_scroll() {
        const service = createTemporaryObject(serviceComponent, this)
        verify(service !== null)
        verify(service.acceptStatusChunk("I"))
        verify(service.acceptConversationChunk(JSON.stringify({version: 1, session: "panel-session", turns: []}) + "\n"))
        const component = Qt.createComponent(Qt.resolvedUrl("../../desktop/Conversation.qml"))
        compare(component.status, Component.Ready, component.errorString())
        const content = createTemporaryObject(component, this, {
            width: 448, height: 640, background: "#121212", ink: "#bebebe",
            accentInk: "#e68e0d", troubleInk: "#D35F5F",
            statusSentence: Qt.binding(function() { return service.statusSentence }),
            currentState: Qt.binding(function() { return service.state }),
            conversationMessage: Qt.binding(function() { return service.conversationMessage })
        })
        verify(content !== null)
        closeSpy.target = content
        closeSpy.clear()
        const close = findChild(content, "closeConversation")
        const transcript = findChild(content, "transcript")
        verify(close !== null && transcript !== null)
        compare(close.width, 33)
        compare(close.height, 33)
        compare(close.Accessible.name, "Close panel")
        compare(close.Accessible.role, Accessible.Button)
        compare(transcript.Accessible.role, Accessible.Document)
        verify(service.acceptStatusChunk("D"))
        verify(waitForRendering(content))
        const inactivePrompt = textWith(content, "Press Super + Shift + K to start a conversation.")
        const inactiveStatus = textWith(content, "Inactive. Microphone in use. Press Super + Shift + K to start.")
        verify(inactivePrompt !== null && inactivePrompt.visible)
        verify(inactiveStatus !== null && inactiveStatus.visible)
        verify(inactivePrompt.mapToItem(content, 0, 0).y >= transcript.y)
        verify(inactivePrompt.contentWidth <= inactivePrompt.width)
        verify(inactiveStatus.contentWidth <= inactiveStatus.width)
        content.focusClose()
        verify(close.activeFocus)
        keyClick(Qt.Key_Tab)
        verify(transcript.activeFocus)
        keyClick(Qt.Key_Backtab)
        verify(close.activeFocus)
        keyClick(Qt.Key_Return)
        compare(closeSpy.count, 1)
        keyClick(Qt.Key_Space)
        compare(closeSpy.count, 2)
        mouseClick(close)
        compare(closeSpy.count, 3)
        keyClick(Qt.Key_Escape)
        compare(closeSpy.count, 4)
        compare(service.state, "inactive", "panel close actions must not change voice activation")
        compare(service.conversationAvailable, true)
        verify(service.acceptStatusChunk("I"))
        verify(waitForRendering(content))
        const activePrompt = textWith(content, "Say something. Kestrel replies after you.")
        verify(activePrompt !== null && activePrompt.visible)
        const literal = '<b>Literal text</b> https://example.invalid ' + "unbroken".repeat(80)
        const turns = [{speaker: "you", text: literal, state: "complete"}]
        for (let i = 0; i < 18; i++) turns.push({speaker: "kestrel", text: "Literal reply " + i + ".", state: "complete"})
        content.turns = turns
        tryVerify(function() { return transcript.contentHeight > transcript.height })
        const body = findChild(content, "turnText0")
        verify(body !== null)
        compare(body.text, literal)
        compare(body.textFormat, Text.PlainText)
        compare(body.wrapMode, Text.Wrap)
        verify(body.lineCount > 1)
        compare(body.font.pixelSize, 14)
        compare(body.lineHeight, 21)
        compare(body.parent.x, 32)
        compare(body.parent.Accessible.name, "You: " + literal)
        tryVerify(function() { return transcript.atYEnd })
        transcript.forceActiveFocus()
        keyClick(Qt.Key_Home)
        compare(transcript.contentY, 0)
        keyClick(Qt.Key_Down)
        compare(transcript.contentY, 21)
        keyClick(Qt.Key_Up)
        compare(transcript.contentY, 0)
        keyClick(Qt.Key_PageDown)
        verify(transcript.contentY > 21)
        keyClick(Qt.Key_PageUp)
        compare(transcript.contentY, 0)
        const more = turns.concat([{speaker: "kestrel", text: "New terminal reply.", state: "interrupted"}])
        content.turns = more
        verify(waitForRendering(content))
        tryVerify(function() { return findChild(content, "turnText19") !== null })
        compare(transcript.contentY, 0, "reading older turns must not jump on new content")
        keyClick(Qt.Key_End)
        verify(transcript.atYEnd, "End: y=" + transcript.contentY + " height=" + transcript.contentHeight + " viewport=" + transcript.height + " focus=" + transcript.activeFocus)
        content.turns = more.concat([{speaker: "kestrel", text: "Final terminal reply.", state: "failed"}])
        verify(waitForRendering(content))
        tryVerify(function() { return findChild(content, "turnText20") !== null && transcript.atYEnd })
        compare(findChild(content, "turnNotice19").text, "Reply interrupted.")
        compare(findChild(content, "turnNotice20").text, "Reply could not be completed.")
        keyClick(Qt.Key_Escape)
        compare(closeSpy.count, 5)
        keyClick(Qt.Key_Tab)
        verify(close.activeFocus)
        keyClick(Qt.Key_Backtab)
        verify(transcript.activeFocus)

        const title = findChild(content, "conversationTitle")
        const hint = textWith(content, "Move: Super + left drag")
        const status = textWith(content, "Idle. Microphone in use.")
        verify(title !== null && hint !== null && status !== null)
        function sizes() {
            const notice = findChild(content, "turnNotice20")
            return [findChild(content, "turnText0").font.pixelSize, title.font.pixelSize, hint.font.pixelSize,
                status.lineHeight, notice.lineHeight, notice.parent.children[0].font.pixelSize].join()
        }
        compare(sizes(), "14,16,12,21,21,14", "host base size 14 keeps the token sizes")
        content.placementAdvisory = "Hyprland has configuration errors. Run hyprctl configerrors, fix the errors, then reopen the panel."
        content.textScale = 2
        verify(waitForRendering(content))
        compare(sizes(), "28,32,24,42,42,28", "host base size 28 doubles the token sizes")
        const advisory = textWith(content, content.placementAdvisory)
        for (const item of [status, hint, advisory, findChild(content, "turnText0"), findChild(content, "turnNotice20")]) {
            const left = item.mapToItem(content, 0, 0).x
            verify(left >= 16 && left + item.width <= 432 && item.contentWidth <= item.width,
                item.text + " must stay inside the panel: x=" + left + " width=" + item.width + " content=" + item.contentWidth)
        }
        const closeLeft = close.mapToItem(content, 0, 0).x
        verify(title.mapToItem(content, 0, 0).x + title.width <= closeLeft && closeLeft + close.width <= 432)
        verify(close.width >= 33, "close width " + close.width)
        compare(close.height, close.width)
        verify(close.contentItem.implicitWidth <= close.width - 4 && close.contentItem.implicitHeight <= close.height - 4)
        const notice = findChild(content, "turnNotice20")
        const warning = notice.parent.children[0]
        verify(warning.x + warning.width <= notice.x && notice.x + notice.width <= notice.parent.width)
        const headerBottom = advisory.mapToItem(content, 0, 0).y + advisory.height
        verify(transcript.y >= headerBottom && transcript.height > 0 && transcript.y + transcript.height <= 624,
            "transcript y=" + transcript.y + " height=" + transcript.height + " header bottom=" + headerBottom)
        verify(transcript.activeFocus)
        keyClick(Qt.Key_Home)
        compare(transcript.contentY, 0)
        keyClick(Qt.Key_Down)
        compare(transcript.contentY, 42)
        keyClick(Qt.Key_Up)
        compare(transcript.contentY, 0)
        keyClick(Qt.Key_PageDown)
        const longBody = findChild(content, "turnText0")
        const bodyTop = longBody.mapToItem(transcript, 0, 0).y
        verify(bodyTop < transcript.height && bodyTop + longBody.height > 0,
            "long body top " + bodyTop + " viewport " + transcript.height)
        keyClick(Qt.Key_PageUp)
        compare(transcript.contentY, 0)
        keyClick(Qt.Key_End)
        verify(transcript.atYEnd)
        const noticeBottom = notice.mapToItem(transcript, 0, 0).y + notice.height
        verify(noticeBottom > 0 && noticeBottom <= transcript.height, "final notice bottom " + noticeBottom)
        keyClick(Qt.Key_Tab)
        verify(close.activeFocus)
        keyClick(Qt.Key_Return)
        compare(closeSpy.count, 6)
        keyClick(Qt.Key_Space)
        compare(closeSpy.count, 7)
        keyClick(Qt.Key_Escape)
        compare(closeSpy.count, 8)
        keyClick(Qt.Key_Backtab)
        verify(transcript.activeFocus)
        for (const invalid of [NaN, Infinity, -Infinity, 0, -2]) {
            content.textScale = invalid
            compare(sizes(), "14,16,12,21,21,14", "invalid text scale " + invalid + " falls back to 1")
        }
        closeSpy.target = null
        component.destroy()
    }

    function textWith(item, value) {
        if (item.text === value) return item
        for (let i = 0; i < item.children.length; i++) {
            const found = textWith(item.children[i], value)
            if (found !== null) return found
        }
        return null
    }
}
