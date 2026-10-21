import QtQuick
import QtQuick.Controls
import QtQuick.Window
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

    Component { id: conversationComponent; Desktop.Conversation {} }
    Component {
        id: glyphDouble
        Item {
            property string text: ""
            property real fontSize: 0
            property color color: "transparent"
        }
    }

    property int destroyedTooltips: 0
    property int tooltipPixelSize: 12
    Component { id: tooltipWindow; Window { visible: true; height: 640 } }
    Component {
        id: tooltipDouble
        ToolTip {
            id: tooltip
            delay: 400
            padding: 0
            contentItem: Text {
                text: tooltip.text
                textFormat: Text.PlainText
                wrapMode: Text.NoWrap
                font.family: "monospace"
                font.pixelSize: test.tooltipPixelSize
                leftPadding: 10
                rightPadding: 10
                topPadding: 6
                bottomPadding: 6
            }
            Component.onDestruction: test.destroyedTooltips++
        }
    }

    function composerContent(service, component) {
        const content = createTemporaryObject(component || conversationComponent, test, {
            width: 448, height: 640, background: "#1a1b26", ink: "#a9b1d6",
            accentInk: "#7aa2f7", troubleInk: "#D35F5F", service: service,
            glyphComponent: glyphDouble, tooltipComponent: tooltipDouble,
            conversationMessage: "", announcementsEnabled: true
        })
        verify(content !== null)
        return content
    }

    function test_composer_keys_focus_and_multiline() {
        const service = createTemporaryObject(serviceComponent, test)
        const content = composerContent(service)
        const editor = findChild(content, "composer")
        const voice = findChild(content, "toggleVoice")
        const send = findChild(content, "sendMessage")
        const close = findChild(content, "closeConversation")
        const transcript = findChild(content, "transcript")
        verify(editor !== null && voice !== null && send !== null)
        const requests = []
        service.submitRequested.connect(function(id, payload) { requests.push(JSON.parse(payload)) })
        content.focusComposer()
        verify(editor.activeFocus)
        compare(editor.Accessible.name, "Message Kestrel")
        compare(editor.Accessible.multiLine, true)
        compare(send.Accessible.name, "Send message")
        compare(editor.textFormat, TextEdit.PlainText)
        compare(editor.font.italic, false)
        compare(send.enabled, false)
        keyClick(Qt.Key_Return)
        compare(requests.length, 0)
        keyClick(Qt.Key_Tab)
        verify(voice.activeFocus, "the voice button follows the composer")
        keyClick(Qt.Key_Tab)
        verify(close.activeFocus, "disabled Send is skipped")
        keyClick(Qt.Key_Tab)
        verify(transcript.activeFocus)
        keyClick(Qt.Key_Tab)
        verify(editor.activeFocus)
        keyClick(Qt.Key_A)
        keyClick(Qt.Key_Return, Qt.ShiftModifier)
        keyClick(Qt.Key_B)
        compare(editor.text, "a\nb")
        verify(send.enabled)
        keyClick(Qt.Key_Tab)
        verify(voice.activeFocus)
        keyClick(Qt.Key_Tab)
        verify(send.activeFocus)
        keyClick(Qt.Key_Tab)
        verify(close.activeFocus)
        keyClick(Qt.Key_Backtab)
        verify(send.activeFocus)
        keyClick(Qt.Key_Backtab)
        verify(voice.activeFocus)
        keyClick(Qt.Key_Backtab)
        verify(editor.activeFocus)
        compare(editor.text, "a\nb", "Tab never inserts a tab")
        keyClick(Qt.Key_Return)
        compare(requests.length, 1)
        compare(requests[0].text, "a\nb")
        compare(send.enabled, false)
        keyClick(Qt.Key_Enter)
        compare(requests.length, 1, "pending cannot send twice")
        closeSpy.target = content
        closeSpy.clear()
        for (const target of [editor, voice, close, transcript]) {
            target.forceActiveFocus()
            keyClick(Qt.Key_Escape)
        }
        compare(closeSpy.count, 4)
        service.finishSubmit(service.submitAttemptId, "busy")
        send.forceActiveFocus()
        verify(send.activeFocus)
        keyClick(Qt.Key_Escape)
        compare(closeSpy.count, 5)
        editor.forceActiveFocus()
        editor.clear()
        keyClick(Qt.Key_Space)
        keyClick(Qt.Key_Return)
        compare(requests.length, 1, "whitespace is not sent")
    }

    function test_composer_native_five_line_scroll_and_scaling() {
        const service = createTemporaryObject(serviceComponent, test)
        const content = composerContent(service)
        const editor = findChild(content, "composer")
        const scroll = findChild(content, "composerScroll")
        const voice = findChild(content, "toggleVoice")
        const send = findChild(content, "sendMessage")
        const transcript = findChild(content, "transcript")
        content.focusComposer()
        for (const scale of [1, 2]) {
            content.textScale = scale
            for (const width of [448, 320]) {
                content.width = width
                editor.text = "one"
                editor.cursorPosition = editor.length
                tryCompare(editor, "lineCount", 1)
                tryCompare(scroll, "height", scale === 1 ? 40 : 55)
                editor.text = "one\ntwo\nthree\nfour\nfive"
                editor.cursorPosition = editor.length
                tryCompare(editor, "lineCount", 5)
                tryCompare(scroll, "height", scale === 1 ? 113 : 203)
                verify(editor.contentHeight <= scroll.height - 18)
                const fiveHeight = scroll.height
                verify(waitForRendering(content))
                keyClick(Qt.Key_Return, Qt.ShiftModifier)
                keyClick(Qt.Key_S)
                keyClick(Qt.Key_I)
                keyClick(Qt.Key_X)
                tryCompare(editor, "lineCount", 6)
                compare(scroll.height, fiveHeight, "sixth line scrolls without growing the field")
                tryVerify(function() { return scroll.contentItem.contentY > 0 })
                function cursorVisible() {
                    const point = editor.mapToItem(scroll, editor.cursorRectangle.x, editor.cursorRectangle.y)
                    return point.y >= 0 && point.y + editor.cursorRectangle.height <= scroll.height
                }
                tryVerify(cursorVisible, 5000, "native cursor scrolls into the viewport")
                editor.text = "W".repeat(320)
                editor.cursorPosition = editor.length
                tryVerify(function() { return editor.lineCount > 5 })
                compare(scroll.height, fiveHeight, "wrapped visual lines also obey the cap")
                tryVerify(cursorVisible)
                compare(scroll.x + scroll.width + 9, voice.x)
                compare(voice.x + voice.width + 9, send.x)
                compare(voice.y + voice.height, scroll.y + scroll.height)
                compare(send.y + send.height, scroll.y + scroll.height)
                verify(send.x + send.width <= content.width - 32)
                verify(transcript.y + transcript.height <= findChild(content, "composerFooter").y)
                verify(scroll.height + scroll.y + 12 <= findChild(content, "composerFooter").height)
                compare(editor.font.pixelSize, scale * 14)
            }
        }
    }

    function test_composer_text_and_placeholder_start_at_padding() {
        const service = createTemporaryObject(serviceComponent, test)
        const content = composerContent(service)
        const editor = findChild(content, "composer")
        const scroll = findChild(content, "composerScroll")
        verify(editor !== null && scroll !== null)
        verify(waitForRendering(content))
        compare(editor.text, "")
        const caret = editor.mapToItem(scroll, editor.cursorRectangle.x, editor.cursorRectangle.y)
        compare(caret.x + ", " + caret.y, "12, 9")
        const placeholder = findChild(content, "composerPlaceholder")
        verify(placeholder !== null)
        const origin = placeholder.mapToItem(scroll, 0, 0)
        compare(origin.x + ", " + origin.y, "12, 9")
    }

    function test_only_matching_acceptance_clears_unchanged_draft() {
        const service = createTemporaryObject(serviceComponent, test)
        const content = composerContent(service)
        const editor = findChild(content, "composer")
        const send = findChild(content, "sendMessage")
        const transcript = findChild(content, "transcript")
        function begin(text) {
            editor.text = text
            content.focusComposer()
            mouseClick(send)
            verify(service.submitPending)
            verify(editor.activeFocus, "disabled focused Send returns synchronously to editing")
            compare(editor.text, text, "starting an attempt cannot erase the draft")
            return service.submitAttemptId
        }
        let id = begin("accepted unchanged")
        service.finishSubmit(id, "accepted")
        compare(editor.text, "", "only confirmed acceptance clears")
        id = begin("pending original")
        keyClick(Qt.Key_X)
        const changed = editor.text
        service.finishSubmit(id, "accepted")
        compare(editor.text, changed, "pending edits survive acceptance")
        id = begin("away and back")
        keyClick(Qt.Key_X)
        keyClick(Qt.Key_Backspace)
        compare(editor.text, "away and back")
        service.finishSubmit(id, "accepted")
        compare(editor.text, "away and back", "text equality is insufficient after an edit")
        const guidance = {
            invalid: "Message not sent. Shorten it or remove unsupported control characters.",
            busy: "Message not accepted. Kestrel is finishing a change. Try Send again.",
            unavailable: "Message not sent. Kestrel is unavailable. Check the service, then try Send.",
            uncertain: "Delivery could not be confirmed. Check the conversation before sending again; an action may already have run."
        }
        for (const status of Object.keys(guidance)) {
            id = begin("retain " + status)
            service.finishSubmit(id, status)
            compare(editor.text, "retain " + status)
            compare(findChild(content, "submissionNotice").text, guidance[status])
        }
        const old = id
        id = begin("current attempt")
        service.submitCompleted(old, "accepted")
        compare(editor.text, "current attempt", "obsolete acknowledgement cannot clear")
        compare(findChild(content, "submissionNotice").text, "Sending…")
        transcript.forceActiveFocus()
        service.finishSubmit(id, "accepted")
        compare(editor.text, "")
        verify(transcript.activeFocus, "completion does not steal transcript focus")
        id = begin("close focus")
        findChild(content, "closeConversation").forceActiveFocus()
        service.finishSubmit(id, "accepted")
        verify(findChild(content, "closeConversation").activeFocus)
        editor.text = "invalid" + String.fromCharCode(0)
        compare(send.enabled, false)
        editor.text = "x".repeat(4097)
        compare(send.enabled, false)
        editor.text = "valid"
        send.forceActiveFocus()
        service.submit("external attempt")
        verify(editor.activeFocus, "a pending transition cannot strand focus on disabled Send")
        service.finishSubmit(service.submitAttemptId, "busy")
    }

    function test_composer_hide_notice_and_reload_lifetime() {
        const service = createTemporaryObject(serviceComponent, test)
        const content = composerContent(service, announcementComponent)
        const editor = findChild(content, "composer")
        const send = findChild(content, "sendMessage")
        const notice = findChild(content, "submissionNotice")
        const announcements = []
        const requests = []
        content.announcementRequested.connect(function(text) { announcements.push(text) })
        service.submitRequested.connect(function(id) { requests.push(id) })
        content.conversationAvailable = true
        content.currentState = "thinking"
        editor.text = "draft"
        compare(notice.text, "", "microphone state alone is not an accepted reply")
        content.turns = [{speaker: "kestrel", text: "", state: "thinking"}]
        content.currentState = "inactive"
        compare(notice.text, "Sending stops the current reply.")
        compare(announcements.join("|"), "Sending stops the current reply.")
        announcements.length = 0
        content.focusComposer()
        mouseClick(send)
        compare(notice.text, "Sending…")
        compare(announcements.join("|"), "Sending…")
        compare(requests.length, 1)
        editor.text = "changed while pending\nsecond\nthird\nfourth\nfifth\nsixth"
        verify(waitForRendering(content))
        keyClick(Qt.Key_End, Qt.ControlModifier)
        editor.select(editor.length - 6, editor.length - 1)
        const selection = editor.selectedText
        const scroll = findChild(content, "composerScroll").contentItem
        const scrollY = scroll.contentY
        verify(scrollY > 0, "hide must preserve an actually scrolled editor")
        const pendingDraft = editor.text
        content.visible = false
        content.announcementsEnabled = false
        service.finishSubmit(requests[0], "uncertain")
        compare(editor.text, pendingDraft)
        compare(editor.selectedText, selection)
        compare(scroll.contentY, scrollY)
        compare(announcements.join("|"), "Sending…", "hidden completion is silent")
        const uncertain = "Delivery could not be confirmed. Check the conversation before sending again; an action may already have run."
        compare(notice.text, uncertain)
        content.visible = true
        content.announcementsEnabled = true
        content.focusComposer()
        compare(editor.cursorPosition, editor.length)
        compare(requests.length, 1, "reopen must never resubmit")
        compare(announcements.join("|"), "Sending…", "reopen must not announce backlog")
        content.turns = [{speaker: "kestrel", text: "", state: "speaking"}]
        compare(notice.text, uncertain, "outcome owns the caption until an edit or send")
        keyClick(Qt.Key_X)
        compare(notice.text, "Sending stops the current reply.")
        announcements.length = 0
        mouseClick(send)
        service.finishSubmit(requests[1], "busy")
        compare(announcements.length, 2, "one pending and one result, without transient hint")
        compare(announcements[0], "Sending…")
        compare(announcements[1], "Message not accepted. Kestrel is finishing a change. Try Send again.")
        service.submitCompleted(requests[1], "busy")
        compare(announcements.length, 2, "a repeated completion is silent")
        unloadLoader.active = true
        verify(unloadLoader.item !== null)
        unloadLoader.item.service = service
        const doomed = findChild(unloadLoader.item, "composer")
        doomed.text = "unsaved draft"
        unloadLoader.item.focusComposer()
        mouseClick(findChild(unloadLoader.item, "sendMessage"))
        compare(requests.length, 3)
        verify(service.submitPending)
        unloadLoader.active = false
        compare(unloadLoader.item, null)
        unloadLoader.active = true
        verify(unloadLoader.item !== null)
        unloadLoader.item.service = service
        compare(findChild(unloadLoader.item, "composer").text, "")
        compare(requests.length, 3, "destruction and recreation never resend")
        service.finishSubmit(requests[2], "accepted")
        compare(findChild(unloadLoader.item, "composer").text, "")
        unloadLoader.active = false
    }

    function test_typed_and_spoken_provenance() {
        const content = createTemporaryObject(conversationComponent, test, {
            width: 320, height: 640, background: "#1a1b26", ink: "#a9b1d6",
            accentInk: "#7aa2f7", troubleInk: "#D35F5F", conversationMessage: "",
            glyphComponent: glyphDouble, tooltipComponent: tooltipDouble,
            conversationAvailable: true, currentState: "idle", textScale: 2
        })
        verify(content !== null)
        content.turns = [{speaker: "you", text: "A", state: "complete", source: "typed"}]
        tryVerify(function() { return findChild(content, "turnBubble0") !== null })
        const transcript = findChild(content, "transcript")
        mouseClick(transcript, 2, 2)
        compare(findChild(content, "turnProvenance0").visible, false,
            "typed messages must not claim microphone provenance")
        compare(findChild(content, "turnRow0").Accessible.description, "Typed message")
        compare(findChild(content, "turnProvenance0").item, null)
        compare(findChild(content, "turnProvenanceTooltip0").item, null)
        compare(findChild(content, "turnBubble0").width, 44,
            "a typed bubble must not reserve the wider doubled caption")
        compare(findChild(content, "turnBubble0").height,
            findChild(content, "turnText0").implicitHeight + 16)
        content.turns = [{speaker: "you", text: "A", state: "complete", source: "spoken"}]
        tryVerify(function() {
            const glyph = findChild(content, "turnProvenance0")
            return glyph !== null && glyph.visible
        })
        const provenance = findChild(content, "turnProvenance0")
        compare(provenance.item.text, "󰍬")
        compare(findChild(content, "turnRow0").Accessible.description, "Spoken message")
        compare(findChild(content, "turnBubble0").width, 56)
        compare(findChild(content, "turnBubble0").height,
            findChild(content, "turnText0").implicitHeight + 16 + 32 + 4)
        compare(findChild(content, "turnProvenanceTooltip0").item.text, "Spoken message")
        const literal = "<b>Typed & literal</b>\nSecond line"
        content.turns = [{speaker: "you", text: literal, state: "complete", source: "typed"},
            {speaker: "kestrel", text: literal, state: "complete"},
            {speaker: "you", text: "Unfinished", state: "thinking", source: "spoken"}]
        tryVerify(function() { return findChild(content, "turnText2") !== null })
        for (let i = 0; i < 3; i++) {
            compare(findChild(content, "turnProvenance" + i).visible, false)
            compare(findChild(content, "turnBubble" + i).height,
                findChild(content, "turnText" + i).implicitHeight + 16)
        }
        compare(findChild(content, "turnProvenanceTooltip0").item, null)
        compare(findChild(content, "turnRow0").Accessible.name, "You: " + literal)
        compare(findChild(content, "turnRow1").Accessible.name, "Kestrel: " + literal)
        compare(findChild(content, "turnRow1").Accessible.description, "")
        compare(findChild(content, "turnText0").text, literal)
        compare(findChild(content, "turnText0").textFormat, Text.PlainText)
    }

    function test_windhover_bubbles_and_scaling() {
        const content = createTemporaryObject(conversationComponent, test, {
            width: 448, height: 640, background: "#1a1b26", ink: "#a9b1d6",
            accentInk: "#7aa2f7", troubleInk: "#D35F5F", conversationMessage: "",
            glyphComponent: glyphDouble, tooltipComponent: tooltipDouble,
            conversationAvailable: true, currentState: "idle", motionEnabled: true, announcementsEnabled: true
        })
        verify(content !== null)
        const literal = '<b>Literal</b>\n' + "unbroken".repeat(80)
        const turns = [{speaker: "you", text: "A", state: "complete", source: "spoken"},
            {speaker: "you", text: literal, state: "complete", source: "spoken"},
            {speaker: "kestrel", text: "B", state: "complete"},
            {speaker: "kestrel", text: literal, state: "complete"}]
        content.turns = turns
        tryVerify(function() { return findChild(content, "turnText3") !== null })
        const transcript = findChild(content, "transcript")
        const first = findChild(content, "turnText0")
        compare(first.width, 20, "the shortest spoken bubble is 44 wide with 12 padding on each side")
        const topRule = findChild(content, "transcriptTopRule")
        const bottomRule = findChild(content, "transcriptBottomRule")
        verify(topRule !== null && bottomRule !== null)
        function channels(color, expected) {
            fuzzyCompare(color.r, expected[0] / 255, 0.005)
            fuzzyCompare(color.g, expected[1] / 255, 0.005)
            fuzzyCompare(color.b, expected[2] / 255, 0.005)
            compare(color.a, 1)
        }
        function geometry(width, scale) {
            content.width = width
            content.textScale = scale
            verify(waitForRendering(content))
            let previous = null
            for (let i = 0; i < 4; i++) {
                const row = findChild(content, "turnRow" + i)
                const bubble = findChild(content, "turnBubble" + i)
                const body = findChild(content, "turnText" + i)
                verify(row !== null && bubble !== null && body !== null)
                compare(row.width, width - 32)
                const point = bubble.mapToItem(transcript.contentItem, 0, 0)
                compare(point.x, i < 2 ? width - 32 - bubble.width : 0)
                verify(bubble.width >= 44 && bubble.width <= width - 88)
                compare(bubble.width, i % 2 === 0 ? (i === 0 && scale === 2 ? 56 : 44) : width - 88)
                compare(body.width, bubble.width - 24)
                compare(body.x, 12)
                compare(body.y, 8)
                compare(body.text, turns[i].text)
                compare(body.textFormat, Text.PlainText)
                compare(body.wrapMode, Text.Wrap)
                compare(body.font.pixelSize, 14 * scale)
                compare(body.lineHeight, 21 * scale)
                verify(body.contentWidth <= body.width)
                if (i % 2 === 1) verify(body.lineCount > 2, "newlines and long words wrap literally")
                compare(bubble.opacity, 1)
                compare(body.opacity, 1)
                if (previous !== null) compare(point.y - previous.bottom, i === 2 ? 14 : 4)
                previous = {bottom: point.y + bubble.height}
                compare(bubble.topLeftRadius, i === 3 ? 4 : 14)
                compare(bubble.topRightRadius, i === 1 ? 4 : 14)
                compare(bubble.bottomLeftRadius, i >= 2 ? 4 : 14)
                compare(bubble.bottomRightRadius, i < 2 ? 4 : 14)
                const provenance = findChild(content, "turnProvenance" + i)
                compare(provenance.visible, i < 2)
                if (i < 2) {
                    compare(provenance.item.text, "󰍬")
                    compare(provenance.item.fontSize, 12 * scale)
                    compare(findChild(content, "turnProvenanceTooltip" + i).item.text, "Spoken message")
                    compare(row.Accessible.description, "Spoken message")
                    compare(bubble.height, body.implicitHeight + 16 + 16 * scale + 4)
                } else compare(bubble.height, body.implicitHeight + 16)
                compare(row.Accessible.name, (i < 2 ? "You: " : "Kestrel: ") + turns[i].text)
                compare(row.Accessible.role, Accessible.StaticText)
            }
            compare(textWith(content, "You"), null)
            compare(textWith(content, "Kestrel").objectName, "conversationTitle")
            compare(topRule.height, 1)
            compare(bottomRule.height, 1)
            transcript.forceActiveFocus()
            keyClick(Qt.Key_End)
            compare(bottomRule.visible, false)
            compare(topRule.visible, true)
            keyClick(Qt.Key_Home)
            compare(topRule.visible, false)
            compare(bottomRule.visible, true)
        }
        geometry(448, 1)
        channels(findChild(content, "turnBubble0").color, [45.2, 54, 79.8])
        channels(findChild(content, "turnBubble2").color, [40.3, 42, 55.6])
        channels(topRule.color, [54.6, 57, 73.2])
        geometry(320, 1)
        geometry(448, 2)
        geometry(320, 2)
        content.background = "#eff1f5"
        content.ink = "#4c4f69"
        content.accentInk = "#1e66f5"
        channels(findChild(content, "turnBubble0").color, [197.2, 213.2, 245])
        channels(findChild(content, "turnBubble2").color, [222.7, 224.8, 231])
        for (const invalid of [NaN, Infinity, -Infinity, 0, -2]) {
            content.textScale = invalid
            compare(first.font.pixelSize, 14)
            compare(first.lineHeight, 21)
        }
        content.width = 448
        content.turns = [turns[0], turns[2]]
        tryVerify(function() { return findChild(content, "turnText2") === null })
        verify(waitForRendering(content))
        compare(transcript.contentHeight, transcript.height)
        const last = findChild(content, "turnBubble1")
        compare(last.mapToItem(transcript, 0, 0).y + last.height, transcript.height)
        compare(topRule.visible, false)
        compare(bottomRule.visible, false)
    }

    function test_live_edge_and_invalid_feed() {
        failOnWarning(/TypeError/)
        const service = createTemporaryObject(serviceComponent, test)
        verify(service !== null)
        const content = createTemporaryObject(conversationComponent, test, {
            width: 448, height: 640, background: "#1a1b26", ink: "#a9b1d6",
            accentInk: "#7aa2f7", troubleInk: "#D35F5F",
            glyphComponent: glyphDouble, tooltipComponent: tooltipDouble,
            announcementsEnabled: true, motionEnabled: true,
            turns: Qt.binding(function() { return service.turns }),
            conversationAvailable: Qt.binding(function() { return service.conversationAvailable }),
            conversationSession: Qt.binding(function() { return service.conversationSession }),
            conversationMessage: Qt.binding(function() { return service.conversationMessage }),
            currentState: Qt.binding(function() { return service.state }),
            statusSentence: Qt.binding(function() { return service.statusSentence })
        })
        verify(content !== null)
        let tail = null
        let marks = null
        let bubble = null
        let word = null
        function accept(turns) {
            verify(service.acceptConversationChunk(JSON.stringify({version: 2, session: "live-session", turns: turns}) + "\n"))
            tryCompare(content, "displayedTurns", service.turns)
            verify(waitForRendering(content))
            tail = findChild(content, "turnTail1")
            marks = findChild(content, "turnLiveMarks1")
            bubble = findChild(content, "turnBubble1")
            word = findChild(content, "turnLiveWord1")
        }
        const earlier = {speaker: "kestrel", text: "Earlier", state: "thinking"}
        verify(service.acceptStatusChunk("T"))
        accept([earlier, {speaker: "kestrel", text: "", state: "thinking"}])
        compare(findChild(content, "turnText1").parent.visible, false,
            "an empty active reply has only its live tail, never a placeholder bubble")
        const transcript = findChild(content, "transcript")
        verify(tail !== null && marks !== null)
        compare(findChild(content, "turnTail0").visible, false, "only the final accepted reply is active")
        compare(tail.visible, true)
        verify(word !== null)
        compare(word.text, "Thinking")
        compare(word.font.pixelSize, 12)
        compare(word.lineHeight, 16)
        compare(word.x, 40)
        compare(tail.width, 40 + Math.ceil(word.implicitWidth) + 10)
        compare(word.y + word.height / 2, tail.height / 2)
        compare(word.Accessible.ignored, true)
        compare(marks.x, 0)
        compare(marks.y, 0)
        compare(tail.height, 26)
        compare(tail.topLeftRadius, 10)
        compare(tail.topRightRadius, 10)
        compare(tail.bottomRightRadius, 10)
        compare(tail.bottomLeftRadius, 4)
        compare(tail.color, content.bubbleTint)
        compare(marks.feed, true)
        compare(marks.kind, "thinking")
        compare(findChild(marks, "rippleDriver").running, true)
        const literal = '<b>Heard prefix</b>\nonly accepted text'
        const thinkingMarks = marks
        accept([earlier, {speaker: "kestrel", text: literal, state: "speaking"}])
        verify(marks === thinkingMarks, "the live marks persist, so thinking glides into speaking")
        compare(bubble.visible, true)
        compare(bubble.bottomLeftRadius, 0)
        compare(tail.y, bubble.y + bubble.height)
        compare(tail.x, bubble.x)
        compare(tail.topLeftRadius, 0)
        compare(tail.topRightRadius, 0)
        compare(findChild(content, "turnText1").text, literal)
        compare(findChild(content, "turnText1").textFormat, Text.PlainText)
        compare(marks.kind, "speaking")
        compare(word.text, "Speaking")
        function loops(running) {
            for (let i = 0; i < 3; i++)
                compare(findChild(findChild(marks, "mark" + i), "speakDriver" + i).running, running)
        }
        loops(true)
        content.motionEnabled = false
        loops(false)
        compare(word.visible, true)
        compare(word.text, "Speaking")
        content.motionEnabled = true
        loops(true)
        content.announcementsEnabled = false
        content.visible = false
        loops(false)
        content.visible = true
        content.announcementsEnabled = true
        loops(true)
        content.textScale = 2
        verify(waitForRendering(content))
        compare(tail.height, 42)
        compare(word.font.pixelSize, 24)
        compare(word.y + word.height / 2, 21)
        compare(findChild(content, "turnRow1").height, 4 + bubble.height + 42)
        content.textScale = 1
        verify(waitForRendering(content))
        accept([earlier, {speaker: "kestrel", text: "Hi", state: "speaking"}])
        compare(tail.topRightRadius, 10)
        compare(tail.topLeftRadius, 0)
        const ghost = findChild(content, "listeningGhost")
        const inflow = findChild(content, "listeningGhostMark")
        verify(ghost !== null && inflow !== null)
        verify(service.acceptStatusChunk("L"))
        verify(waitForRendering(content))
        compare(ghost.visible, true)
        compare(ghost.width, 40)
        compare(ghost.height, 26)
        compare(ghost.mapToItem(transcript.contentItem, 0, 0).x, transcript.width - 40)
        compare(ghost.Accessible.name, "Listening")
        compare(ghost.Accessible.role, Accessible.StaticText)
        compare(inflow.feed, true)
        for (let i = 0; i < 3; i++) {
            const bar = findChild(inflow, "mark" + i)
            compare(bar.x, 10 + 8 * i)
            compare(bar.width, 4)
        }
        compare(findChild(inflow, "listenDriver").running, true)
        const path = findChild(content, "listeningGhostPath")
        compare(path.strokeWidth, 1.5)
        compare(path.strokeColor, content.ink)
        compare(path.fillColor.a, 0)
        fuzzyCompare(path.dashPattern[0], 4 / 1.5, 0.0001)
        fuzzyCompare(path.dashPattern[1], 3 / 1.5, 0.0001)
        const outline = findChild(content, "listeningGhostOutline")
        compare(outline.x, 0.75)
        compare(outline.y, 0.75)
        compare(outline.width, 38.5)
        compare(outline.height, 24.5)
        compare(outline.topLeftRadius, 9.25)
        compare(outline.bottomRightRadius, 3.25)
        compare(findChild(content, "microphoneGlyph").item.text, "󰍬")
        verify(service.acceptStatusChunk("D"))
        compare(ghost.visible, false)
        compare(tail.visible, true, "microphone activity is independent of accepted reply activity")
        compare(findChild(content, "microphoneQuestion").visible, false)
        service.watcherExited()
        compare(tail.visible, true)
        compare(findChild(content, "microphoneGlyph").item.text, "󰍬", "missing status must never claim release")
        compare(findChild(content, "microphoneQuestion").visible, true)
        for (const state of ["interrupted", "failed", "complete"]) {
            accept([earlier, {speaker: "kestrel", text: state === "complete" ? "Finished." : "", state: state}])
            compare(tail.visible, false)
            loops(false)
            const notice = findChild(content, "turnNotice1")
            const failure = findChild(content, "turnFailure1")
            if (state !== "complete") {
                verify(findChild(content, "turnRow1").height > 0)
                compare(notice.visible, true)
                compare(notice.text, state === "interrupted" ? "Reply interrupted." : "Reply could not be completed.")
                compare(notice.font.pixelSize, 12)
                compare(notice.lineHeight, 16)
                compare(notice.parent.y, bubble.y + bubble.height + 4)
                compare(notice.parent.x, 2)
                compare(failure.visible, state === "failed")
                compare(failure.kind, "trouble")
                compare(failure.troubleInk, content.troubleInk)
                compare(failure.motionEnabled, false)
                if (state === "failed") {
                    const square = findChild(failure, "troubleDot")
                    compare(findChild(failure, "mark2").mapToItem(notice, 0, 0).y, 2)
                    compare(square.mapToItem(notice, 0, square.height).y, 14)
                }
                verify(findChild(content, "turnRow1").Accessible.name.indexOf(notice.text) !== -1)
            } else compare(notice.visible, false)
        }
        const engineAdvisory = "I couldn't reach Kestrel's engine. Restart Kestrel and try again."
        accept([earlier, {speaker: "kestrel", text: engineAdvisory, state: "failed"}])
        compare(findChild(content, "turnText1").text, engineAdvisory)
        compare(bubble.visible, true)
        compare(findChild(content, "turnNotice1").parent.y, bubble.y + bubble.height + 4)
        verify(service.acceptStatusChunk("L"))
        accept([])
        compare(ghost.visible, true)
        compare(ghost.mapToItem(transcript.contentItem, 0, ghost.height).y, transcript.height)
        compare(textWith(content, "Say something, or type below."), null)
        content.motionEnabled = false
        compare(findChild(inflow, "listenDriver").running, false)
        for (let i = 0; i < 3; i++) {
            const bar = findChild(inflow, "mark" + i)
            compare(bar.height, 16)
            compare(bar.y, 5)
        }
        content.motionEnabled = true
        content.announcementsEnabled = false
        compare(findChild(inflow, "listenDriver").running, false)
        content.announcementsEnabled = true
        function unavailable(message) {
            tryCompare(content, "displayedTurns", service.turns)
            verify(waitForRendering(content))
            compare(service.conversationAvailable, false)
            compare(content.displayedTurns.length, 0)
            compare(findChild(content, "turnBubble0"), null)
            compare(ghost.visible, false)
            compare(findChild(inflow, "listenDriver").running, false)
            const advisory = textWith(content, message)
            verify(advisory !== null && advisory.visible)
            compare(advisory.horizontalAlignment, Text.AlignHCenter)
            fuzzyCompare(advisory.mapToItem(transcript.contentItem, 0, advisory.height / 2).y, transcript.height / 2, 0.5)
        }
        accept([earlier, {speaker: "kestrel", text: literal, state: "speaking"}])
        findChild(service, "conversationExpiry").triggered()
        unavailable("Conversation unavailable. Reopen the panel.")
        accept([earlier])
        compare(service.acceptConversationChunk("{invalid}\n"), false)
        unavailable("Conversation unavailable. Reopen the panel.")
        accept([earlier])
        verify(service.acceptConversationChunk(JSON.stringify({unavailable:
            "Conversation is too large to display. Restart Kestrel to begin a new conversation."}) + "\n"))
        unavailable("Conversation is too large to display. Restart Kestrel to begin a new conversation.")
    }

    function test_native_tooltip_text_fits_window_data() {
        return [
            {tag: "448-12", panelWidth: 448, pixelSize: 12},
            {tag: "320-12", panelWidth: 320, pixelSize: 12},
            {tag: "448-24", panelWidth: 448, pixelSize: 24},
            {tag: "320-24", panelWidth: 320, pixelSize: 24}
        ]
    }

    function test_native_tooltip_text_fits_window(data) {
        const window = createTemporaryObject(tooltipWindow, test, {width: data.panelWidth})
        verify(window !== null)
        window.requestActivate()
        tryCompare(window, "active", true)
        tooltipPixelSize = data.pixelSize
        const service = createTemporaryObject(serviceComponent, test)
        verify(service !== null)
        verify(service.acceptStatusChunk("D"))
        verify(service.acceptConversationChunk(JSON.stringify({version: 2, session: "fit-session", turns: []}) + "\n"))
        const content = createTemporaryObject(conversationComponent, window.contentItem, {
            width: Qt.binding(function() { return window.width }),
            height: Qt.binding(function() { return window.height }),
            background: "#1a1b26", ink: "#a9b1d6", accentInk: "#7aa2f7", troubleInk: "#D35F5F",
            glyphComponent: glyphDouble, tooltipComponent: tooltipDouble,
            currentState: Qt.binding(function() { return service.state }),
            statusSentence: Qt.binding(function() { return service.statusSentence }),
            turns: Qt.binding(function() { return service.turns }),
            conversationSession: Qt.binding(function() { return service.conversationSession }),
            conversationAvailable: Qt.binding(function() { return service.conversationAvailable })
        })
        verify(content !== null)
        verify(waitForRendering(content))
        const microphone = findChild(content, "microphoneStatus")
        const microphoneTooltip = findChild(content, "microphoneTooltip").item
        const moveTooltip = findChild(content, "headerMoveTooltip").item
        const title = findChild(content, "conversationTitle")
        const close = findChild(content, "closeConversation")
        function readable(popup, literal, multiline) {
            tryCompare(popup, "opened", true)
            compare(popup.text, literal)
            const text = popup.contentItem
            compare(text.text, literal)
            compare(text.truncated, false)
            if (multiline) verify(text.lineCount > 1, "long native text must wrap")
            verify(text.paintedWidth <= text.width - text.leftPadding - text.rightPadding + 0.5,
                "painted text must fit inside native horizontal padding")
            verify(text.paintedHeight <= text.height - text.topPadding - text.bottomPadding + 0.5,
                "painted text must fit inside native vertical padding")
            const background = popup.background
            const topLeft = background.mapToItem(window.contentItem, 0, 0)
            const bottomRight = background.mapToItem(window.contentItem, background.width, background.height)
            verify(topLeft.x >= 15.5 && topLeft.y >= 15.5, "native background must clear top and left window edges")
            verify(bottomRight.x <= window.width - 15.5 && bottomRight.y <= window.height - 15.5,
                "native background must clear bottom and right window edges")
            compare(popup.delay, 400)
        }
        const inactive = "Voice off. Microphone in use. Press Super + Shift + K to start."
        verify(service.acceptStatusChunk("D"))
        mouseMove(content, 1, content.height - 1)
        mouseMove(microphone, 10, microphone.height / 2)
        readable(microphoneTooltip, inactive, data.panelWidth === 320 || data.pixelSize === 24)
        content.focusComposer()
        verify(findChild(content, "composer").activeFocus)
        keyClick(Qt.Key_Tab)
        verify(close.activeFocus)
        keyClick(Qt.Key_Tab)
        verify(findChild(content, "transcript").activeFocus, "native tooltips add no focus stop")
        if (data.tag === "448-12") {
            window.width = 320
            tooltipPixelSize = 24
            verify(waitForRendering(content))
            readable(microphoneTooltip, inactive, true)
        }
        mouseMove(content, 1, content.height / 2)
        tryCompare(microphoneTooltip, "visible", false)
        tryCompare(moveTooltip, "visible", false)
        mouseMove(title, title.width / 2, title.height / 2)
        readable(moveTooltip, "Move: Super + left drag", false)
        compare(microphoneTooltip.visible, false)
        mouseMove(close, close.width / 2, close.height / 2)
        tryCompare(moveTooltip, "visible", false)
        verify(service.acceptConversationChunk(JSON.stringify({version: 2, session: "fit-session",
            turns: [{speaker: "you", text: "Finalized owner turn", state: "complete", source: "spoken"}]}) + "\n"))
        tryVerify(function() { return findChild(content, "turnProvenance0") !== null })
        const provenance = findChild(content, "turnProvenance0")
        verify(waitForRendering(provenance))
        mouseMove(provenance, provenance.width / 2, provenance.height / 2)
        readable(findChild(content, "turnProvenanceTooltip0").item, "Spoken message", false)
        window.destroy()
        tooltipPixelSize = 12
    }

    function test_native_glyph_and_tooltip_injection() {
        const service = createTemporaryObject(serviceComponent, test)
        verify(service !== null)
        verify(service.acceptStatusChunk("D"))
        verify(service.acceptConversationChunk(JSON.stringify({version: 2, session: "tooltip-session", turns: []}) + "\n"))
        const destroyedBefore = destroyedTooltips
        const content = createTemporaryObject(conversationComponent, test, {
            width: 448, height: 640, background: "#1a1b26", ink: "#a9b1d6",
            accentInk: "#7aa2f7", troubleInk: "#D35F5F",
            glyphComponent: glyphDouble, tooltipComponent: tooltipDouble,
            currentState: Qt.binding(function() { return service.state }),
            statusSentence: Qt.binding(function() { return service.statusSentence }),
            conversationAvailable: Qt.binding(function() { return service.conversationAvailable })
        })
        verify(content !== null)
        const microphoneTooltip = findChild(content, "microphoneTooltip")
        const moveTooltip = findChild(content, "headerMoveTooltip")
        const voiceTooltip = findChild(content, "voiceTooltip")
        verify(microphoneTooltip !== null && moveTooltip !== null && voiceTooltip !== null,
            "native tooltip injection must own every hover target")
        const microphone = findChild(content, "microphoneStatus")
        const header = findChild(content, "conversationHeader")
        const title = findChild(content, "conversationTitle")
        const close = findChild(content, "closeConversation")
        const glyph = findChild(content, "microphoneGlyph")
        const badge = findChild(content, "microphoneQuestion")
        compare(microphoneTooltip.item.parent, microphone)
        compare(moveTooltip.item.parent, header)
        compare(voiceTooltip.item.parent, findChild(content, "toggleVoice"))
        compare(header.Accessible.description, "Move: Super + left drag")
        mouseMove(content, 1, 639)
        tryCompare(microphoneTooltip.item, "visible", false)
        tryCompare(moveTooltip.item, "visible", false)
        mouseMove(microphone, 10, microphone.height / 2)
        tryCompare(microphoneTooltip.item, "opened", true)
        compare(microphoneTooltip.item.text, "Voice off. Microphone in use. Press Super + Shift + K to start.")
        compare(moveTooltip.item.visible, false, "microphone hover excludes the move tooltip")
        verify(service.acceptStatusChunk("A"))
        tryCompare(microphoneTooltip.item, "text", "Starting. Microphone may be in use.")
        compare(glyph.item.text, "󰍬")
        compare(badge.visible, true)
        verify(service.acceptStatusChunk("N"))
        tryCompare(glyph.item, "text", "󰍭")
        compare(microphoneTooltip.item.text, "Not running. Microphone released by Kestrel.")
        mouseMove(title, title.width / 2, title.height / 2)
        tryCompare(moveTooltip.item, "opened", true)
        compare(moveTooltip.item.text, "Move: Super + left drag")
        compare(microphoneTooltip.item.visible, false)
        mouseMove(close, close.width / 2, close.height / 2)
        tryCompare(moveTooltip.item, "visible", false)
        compare(microphoneTooltip.item.visible, false)
        content.focusComposer()
        verify(findChild(content, "composer").activeFocus)
        keyClick(Qt.Key_Tab)
        verify(close.activeFocus)
        keyClick(Qt.Key_Tab)
        verify(findChild(content, "transcript").activeFocus, "passive targets introduce no keyboard stop")
        content.ink = "#4c4f69"
        content.textScale = 2
        verify(waitForRendering(content))
        compare(glyph.item.color, "#4c4f69")
        compare(glyph.item.fontSize, 28)
        compare(glyph.item.width, glyph.width)
        compare(glyph.item.height, glyph.height)
        compare(glyph.width, 54)
        compare(badge.width, 32)
        compare(title.lineHeight, 40)
        verify(service.acceptStatusChunk("D"))
        content.width = 320
        verify(waitForRendering(content))
        const label = findChild(content, "conversationStatus")
        for (const item of [title, label, close]) {
            const left = item.mapToItem(content, 0, 0).x
            verify(left >= 16 && left + item.width <= 304)
        }
        verify(label.contentWidth <= label.width)
        compare(title.mapToItem(header, 0, 0).x, 0)
        content.tooltipComponent = null
        compare(microphoneTooltip.item, null)
        compare(moveTooltip.item, null)
        compare(voiceTooltip.item, null)
        tryCompare(test, "destroyedTooltips", destroyedBefore + 3)
        content.tooltipComponent = tooltipDouble
        verify(microphoneTooltip.item !== null && moveTooltip.item !== null && voiceTooltip.item !== null)
        content.destroy()
        tryCompare(test, "destroyedTooltips", destroyedBefore + 6)
    }

    function voiceContent(service) {
        const content = composerContent(service)
        content.currentState = Qt.binding(function() { return service.state })
        content.statusSentence = Qt.binding(function() { return service.statusSentence })
        return content
    }

    function verifyColor(actual, expected, message) {
        verify(Qt.colorEqual(actual, expected), message + ": " + actual + " is not " + expected)
    }

    function test_voice_button_follows_verified_status() {
        const service = createTemporaryObject(serviceComponent, test)
        verify(service !== null)
        const content = voiceContent(service)
        const voice = findChild(content, "toggleVoice")
        const badge = findChild(content, "voiceQuestion")
        const composerFill = findChild(content, "composerScroll").background.color
        const outline = "\u{F036E}"
        const solid = "\u{F036C}"
        const resting = "Start voice conversation"
        const active = "End voice conversation"
        const unconfirmed = "Start or end voice conversation"
        verify(voice !== null && badge !== null)
        function expectForm(row, name, filled, badged) {
            compare(voice.Accessible.name, name, row)
            compare(voice.Accessible.description, service.statusSentence, row)
            compare(voice.checkable, false, row)
            verifyColor(voice.background.color, filled ? "#7aa2f7" : composerFill, row + " fill")
            compare(voice.background.border.width, 0, row)
            compare(voice.contentItem.item.text, filled ? solid : outline, row)
            verifyColor(voice.contentItem.item.color, filled ? "#1a1b26" : "#a9b1d6", row + " glyph")
            compare(voice.contentItem.item.Accessible.ignored, true, row)
            compare(badge.visible, badged, row)
            compare(badge.Accessible.ignored, true, row)
        }
        for (const row of [
            ["D", resting, false, false], ["N", resting, false, false],
            ["I", active, true, false], ["L", active, true, false], ["T", active, true, false], ["S", active, true, false],
            ["A", unconfirmed, false, true], ["U", unconfirmed, false, true],
            ["B", unconfirmed, false, true], ["E", unconfirmed, false, true]
        ]) {
            verify(service.acceptStatusChunk(row[0]))
            verify(waitForRendering(content))
            expectForm(row[0], row[1], row[2], row[3])
        }
        verify(service.acceptStatusChunk("I"))
        findChild(service, "statusExpiry").triggered()
        expectForm("expiry", unconfirmed, false, true)
        verify(service.acceptStatusChunk("I"))
        service.watcherExited()
        expectForm("watcherExited", unconfirmed, false, true)
        verify(service.acceptStatusChunk("I"))
        compare(service.acceptStatusChunk("I\n"), false)
        expectForm("invalid chunk", unconfirmed, false, true)
        verify(service.acceptStatusChunk("I"))
        expectForm("recovered", active, true, false)

        service.toggle()
        compare(service.state, "idle", "a press never changes verified status")
        expectForm("pressed from idle", unconfirmed, false, true)
        service.toggleExited()
        expectForm("exited", unconfirmed, false, true)
        verify(service.acceptStatusChunk("D"))
        expectForm("confirmed off", resting, false, false)

        content.ink = "#4c4f69"
        content.textScale = 2
        verify(waitForRendering(content))
        verifyColor(voice.contentItem.item.color, "#4c4f69", "ink follows the host")
        compare(voice.contentItem.item.fontSize, 28)
        content.ink = "#a9b1d6"
        content.textScale = 1

        content.currentState = "unrecognized"
        expectForm("unrecognized", unconfirmed, false, true)

        content.service = null
        compare(voice.enabled, false)
        verifyColor(voice.background.color, "transparent", "disabled fill")
        compare(voice.background.border.width, 1.5)
        verifyColor(voice.background.border.color, findChild(content, "sendMessage").background.border.color, "disabled rule")
        verifyColor(voice.contentItem.item.color, "#99a9b1d6", "disabled glyph is ink at 0.6")
        compare(voice.contentItem.item.text, outline)
        compare(badge.visible, false)
        compare(voice.Accessible.name, unconfirmed)
    }

    function test_voice_button_presses_once_target_and_tooltip() {
        const service = createTemporaryObject(serviceComponent, test)
        verify(service !== null)
        verify(service.acceptStatusChunk("D"))
        const content = voiceContent(service)
        const voice = findChild(content, "toggleVoice")
        const scroll = findChild(content, "composerScroll")
        const send = findChild(content, "sendMessage")
        const tooltip = findChild(content, "voiceTooltip")
        verify(voice !== null && tooltip !== null)
        let presses = 0
        service.toggleRequested.connect(function() { presses++ })
        verify(waitForRendering(content))
        compare(voice.width, 40)
        compare(voice.height, 40)
        verify(voice.width >= 24 && voice.height >= 24, "WCAG 2.5.8 minimum target")
        compare(scroll.x + scroll.width + 9, voice.x)
        compare(voice.x + voice.width + 9, send.x)
        compare(voice.y + voice.height, send.y + send.height)
        compare(voice.background.radius, 10)

        mouseMove(content, 1, 639)
        tryCompare(tooltip.item, "visible", false)
        mouseMove(voice, voice.width / 2, voice.height / 2)
        tryCompare(tooltip.item, "opened", true)
        compare(tooltip.item.parent, voice)
        compare(tooltip.item.text, "Start voice conversation")
        compare(presses, 0, "hover requests nothing")
        voice.forceActiveFocus()
        verify(voice.activeFocus)
        compare(presses, 0, "focus requests nothing")

        mouseClick(voice)
        compare(presses, 1, "one click is one request")
        mouseClick(voice)
        keyClick(Qt.Key_Space)
        keyClick(Qt.Key_Return)
        keyClick(Qt.Key_Enter)
        compare(presses, 1, "no press while the command runs")
        service.toggleExited()
        keyClick(Qt.Key_Return)
        compare(presses, 2, "Return presses once")
        service.toggleExited()
        keyClick(Qt.Key_Enter)
        compare(presses, 3, "Enter presses once")
        service.toggleExited()
        keyClick(Qt.Key_Space)
        compare(presses, 4, "Space presses once")
        verify(voice.activeFocus)
    }

    function test_microphone_icons_follow_verified_status() {
        const service = createTemporaryObject(serviceComponent, test)
        verify(service !== null)
        verify(service.acceptConversationChunk(JSON.stringify({version: 2, session: "header-session", turns: []}) + "\n"))
        verify(service.acceptStatusChunk("D"))
        const content = createTemporaryObject(conversationComponent, test, {
            width: 448, height: 640, background: "#1a1b26", ink: "#a9b1d6",
            accentInk: "#7aa2f7", troubleInk: "#D35F5F", motionEnabled: true,
            currentState: Qt.binding(function() { return service.state }),
            statusSentence: Qt.binding(function() { return service.statusSentence }),
            troubleAdvisory: Qt.binding(function() { return service.troubleAdvisory })
        })
        verify(content !== null)
        verify(waitForRendering(content))
        compare(textWith(content, "Voice off. Microphone in use. Press Super + Shift + K to start."), null,
            "the passive header must not display the full microphone sentence")
        content.conversationAvailable = Qt.binding(function() { return service.conversationAvailable })
        content.glyphComponent = glyphDouble
        const microphone = findChild(content, "microphoneStatus")
        const glyph = findChild(content, "microphoneGlyph")
        const badge = findChild(content, "microphoneQuestion")
        const label = findChild(content, "conversationStatus")
        verify(microphone !== null && glyph !== null && badge !== null && label !== null)
        compare(findChild(findChild(content, "conversationHeader"), "mark0"), null, "the header shows no state mark")
        const trouble = "Kestrel needs attention. Microphone in use. "
        const expected = [
            ["N", "Not running", "󰍭", false, "Not running. Microphone released by Kestrel.", "ink", ""],
            ["D", "Voice\u00a0off\u00a0· Mic\u00a0in\u00a0use", "󰍬", false, "Voice off. Microphone in use. Press Super + Shift + K to start.", "ink", ""],
            ["A", "Starting", "󰍬", true, "Starting. Microphone may be in use.", "ink", ""],
            ["U", "Unavailable", "󰍬", true, "Status unavailable. Microphone use unknown.", "ink", ""],
            ["I", "Waiting", "󰍬", false, "Waiting. Microphone in use.", "ink", ""],
            ["L", "Listening", "󰍬", false, "Listening. Microphone in use.", "ink", ""],
            ["T", "Thinking", "󰍬", false, "Thinking. Microphone in use.", "ink", ""],
            ["S", "Speaking", "󰍬", false, "Speaking. Microphone in use.", "ink", ""],
            ["B", "Attention", "󰍬", false, trouble + "Cause unknown. Check the service log, then restart Kestrel.", "trouble",
                "Cause unknown. Check the service log, then restart Kestrel."],
            ["M", "Attention", "󰍬", false, trouble + "Microphone capture failed. Restart Kestrel.", "trouble",
                "Microphone capture failed. Restart Kestrel."],
            ["P", "Attention", "󰍬", false, trouble + "Audio playback failed. Restart Kestrel.", "trouble",
                "Audio playback failed. Restart Kestrel."],
            ["R", "Attention", "󰍬", false, trouble + "Speech recognition failed. Restart Kestrel.", "trouble",
                "Speech recognition failed. Restart Kestrel."],
            ["V", "Attention", "󰍬", false, trouble + "Voice generation failed. Restart Kestrel.", "trouble",
                "Voice generation failed. Restart Kestrel."],
            ["E", "Attention", "󰍬", false, trouble + "Kestrel's engine is unavailable. Restart Kestrel.", "trouble",
                "Kestrel's engine is unavailable. Restart Kestrel."],
            ["O", "Attention", "󰍬", false, trouble + "Local notes are unavailable or unsafe. Check note ownership, permissions, encoding and size, then restart Kestrel.", "trouble",
                "Local notes are unavailable or unsafe. Check note ownership, permissions, encoding and size, then restart Kestrel."],
            ["H", "Attention", "󰍬", false, trouble + "A typed message could not reach the conversation. Restart Kestrel.", "trouble",
                "A typed message could not reach the conversation. Restart Kestrel."]
        ]
        const band = findChild(content, "troubleAdvisory")
        verify(band !== null)
        for (const row of expected) {
            verify(service.acceptStatusChunk(row[0]))
            verify(waitForRendering(content))
            compare(label.text, row[1], row[0])
            compare(label.color, row[5] === "trouble" ? content.troubleInk : content.ink, row[0])
            compare(glyph.item.text, row[2])
            compare(badge.visible, row[3])
            compare(microphone.Accessible.name, row[4])
            compare(microphone.Accessible.description, row[4])
            compare(microphone.Accessible.role, Accessible.StaticText)
            compare(microphone.Accessible.focusable, false)
            compare(microphone.activeFocusOnTab, false)
            compare(glyph.item.Accessible.ignored, true)
            compare(textWith(content, row[4]), null)
            compare(textWith(content, "Move: Super + left drag"), null)
            compare(band.text, row[6], row[0])
            compare(band.visible, row[6] !== "", row[0])
        }
        function unknown() {
            compare(band.visible, false)
            compare(label.text, "Unavailable")
            compare(label.color, content.ink)
            compare(glyph.item.text, "󰍬", "unknown use must never cross out the microphone")
            compare(badge.visible, true)
            compare(microphone.Accessible.name, "Status unavailable. Microphone use unknown.")
        }
        verify(service.acceptStatusChunk("I"))
        findChild(service, "statusExpiry").triggered()
        unknown()
        verify(service.acceptStatusChunk("I"))
        service.watcherExited()
        unknown()
        verify(service.acceptStatusChunk("I"))
        compare(service.acceptStatusChunk("I\n"), false)
        unknown()
        content.currentState = "unrecognized"
        unknown()
        content.turns = [{speaker: "kestrel", text: "", state: "speaking"}]
        unknown()
        compare(content.conversationAvailable, true)
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
        const history = [{speaker: "you", text: "Existing owner turn.", state: "complete", source: "spoken"},
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
        content.turns = history.concat([{speaker: "you", text: "New live turn.", state: "complete", source: "spoken"}])
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
        const wired = [{speaker: "you", text: "Existing turn.", state: "complete", source: "spoken"}]
        verify(service.acceptConversationChunk(JSON.stringify({version: 2, session: "same-session", turns: wired}) + "\n"))
        settle()
        compare(JSON.stringify(requests), "[]", "accepted history must be a silent baseline")
        const returned = wired.concat([{speaker: "kestrel", text: "Completed during disconnection.", state: "complete"}])
        verify(service.acceptConversationChunk(JSON.stringify({unavailable: "Conversation unavailable. Reopen the panel."})
            + "\n" + JSON.stringify({version: 2, session: "same-session", turns: returned}) + "\n"))
        settle()
        compare(JSON.stringify(requests), "[]", "same-session reconnect history must stay silent when records share a chunk")
        verify(service.acceptConversationChunk(JSON.stringify({version: 2, session: "same-session",
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
        verify(service.acceptConversationChunk(JSON.stringify({version: 2, session: "panel-session", turns: []}) + "\n"))
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
        const inactivePrompt = textWith(content, "Press Super + Shift + K to talk, or type below.")
        const inactiveStatus = findChild(content, "microphoneStatus")
        verify(inactivePrompt !== null && inactivePrompt.visible)
        verify(inactiveStatus !== null && inactiveStatus.visible)
        verify(inactivePrompt.mapToItem(content, 0, 0).y >= transcript.y)
        verify(inactivePrompt.contentWidth <= inactivePrompt.width)
        compare(inactiveStatus.Accessible.name, "Voice off. Microphone in use. Press Super + Shift + K to start.")
        fuzzyCompare(inactivePrompt.mapToItem(transcript.contentItem, 0, inactivePrompt.height / 2).y, transcript.height / 2, 0.5)
        content.focusComposer()
        verify(findChild(content, "composer").activeFocus)
        keyClick(Qt.Key_Tab)
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
        const activePrompt = textWith(content, "Say something, or type below.")
        verify(activePrompt !== null && activePrompt.visible)
        compare(textWith(content, "Press Super + Shift + K to talk, or type below."), null)
        const literal = '<b>Literal text</b> https://example.invalid ' + "unbroken".repeat(80)
        const turns = [{speaker: "you", text: literal, state: "complete", source: "spoken"}]
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
        compare(body.parent.x + body.parent.width, transcript.width)
        compare(body.parent.width, transcript.width - 56)
        compare(body.parent.parent.Accessible.name, "You: " + literal)
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
        const editor = findChild(content, "composer")
        editor.text = "one\ntwo\nthree\nfour\nfive\nsix"
        verify(waitForRendering(content))
        compare(transcript.contentY, 0, "composer growth preserves earlier reading position")
        editor.forceActiveFocus()
        const draft = editor.text
        keyClick(Qt.Key_PageDown)
        verify(transcript.contentY > 0)
        keyClick(Qt.Key_PageUp)
        compare(transcript.contentY, 0)
        compare(editor.text, draft, "editor Page keys scroll transcript without editing")
        verify(editor.activeFocus)
        transcript.forceActiveFocus()
        keyClick(Qt.Key_End)
        editor.clear()
        verify(waitForRendering(content))
        tryVerify(function() { return transcript.atYEnd }, 5000, "composer shrink follows the live edge")
        editor.text = "one\ntwo\nthree\nfour\nfive\nsix"
        verify(waitForRendering(content))
        verify(transcript.atYEnd, "composer growth follows only from the live edge")
        editor.clear()
        verify(waitForRendering(content))
        verify(transcript.atYEnd, "End: y=" + transcript.contentY + " height=" + transcript.contentHeight + " viewport=" + transcript.height + " focus=" + transcript.activeFocus)
        content.turns = more.concat([{speaker: "kestrel", text: "Final terminal reply.", state: "failed"}])
        verify(waitForRendering(content))
        tryVerify(function() { return findChild(content, "turnText20") !== null && transcript.atYEnd })
        compare(findChild(content, "turnNotice19").text, "Reply interrupted.")
        compare(findChild(content, "turnNotice20").text, "Reply could not be completed.")
        keyClick(Qt.Key_Escape)
        compare(closeSpy.count, 5)
        keyClick(Qt.Key_Tab)
        verify(findChild(content, "composer").activeFocus)
        keyClick(Qt.Key_Tab)
        verify(close.activeFocus)
        keyClick(Qt.Key_Backtab)
        verify(findChild(content, "composer").activeFocus)
        keyClick(Qt.Key_Backtab)
        verify(transcript.activeFocus)

        const title = findChild(content, "conversationTitle")
        const status = findChild(content, "conversationStatus")
        verify(title !== null && status !== null)
        compare(textWith(content, "Move: Super + left drag"), null)
        compare(findChild(content, "conversationHeader").Accessible.description, "Move: Super + left drag")
        function sizes() {
            const notice = findChild(content, "turnNotice20")
            return [findChild(content, "turnText0").font.pixelSize, title.font.pixelSize, status.font.pixelSize,
                status.lineHeight, notice.lineHeight, notice.font.pixelSize].join()
        }
        compare(sizes(), "14,16,12,16,16,12", "host base size 14 keeps the token sizes")
        const longestAdvisory = "Local notes are unavailable or unsafe. Check note ownership, permissions, encoding and size, then restart Kestrel."
        content.placementAdvisory = "Hyprland has configuration errors. Run hyprctl configerrors, fix the errors, then reopen the panel."
        content.troubleAdvisory = longestAdvisory
        content.textScale = 2
        verify(waitForRendering(content))
        compare(sizes(), "28,32,24,32,32,24", "host base size 28 doubles the token sizes")
        const failure = findChild(content, "turnFailure20")
        const square = findChild(failure, "troubleDot")
        compare(findChild(failure, "mark2").mapToItem(findChild(content, "turnNotice20"), 0, 0).y, 10)
        compare(square.mapToItem(findChild(content, "turnNotice20"), 0, square.height).y, 22)
        const advisory = textWith(content, content.placementAdvisory)
        const troubleBand = findChild(content, "troubleAdvisory")
        verify(troubleBand !== null && troubleBand.visible)
        compare(troubleBand.text, longestAdvisory)
        verify(troubleBand.lineCount > 1)
        compare(troubleBand.font.pixelSize, 28)
        compare(troubleBand.lineHeight, 42)
        for (const item of [status, troubleBand, advisory, findChild(content, "turnText0"), findChild(content, "turnNotice20")]) {
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
        const headerRow = findChild(content, "conversationHeader")
        const bandTop = troubleBand.mapToItem(content, 0, 0).y
        compare(bandTop, headerRow.mapToItem(content, 0, 0).y + headerRow.height + 9,
            "the trouble band sits directly below the header row")
        verify(bandTop + troubleBand.height + 9 <= advisory.mapToItem(content, 0, 0).y,
            "the trouble band sits above the placement band")
        // 58 is one scale-2 body line (42) plus the bubble's 16 vertical padding.
        verify(transcript.height >= 58, "transcript height " + transcript.height)
        const region = findChild(content, "headerAdvisories")
        verify(region !== null)
        const footer = findChild(content, "composerFooter")
        verify(footer !== null)
        function verifyAdvisoryGeometry(label) {
            compare(transcript.y, region.mapToItem(content, 0, region.height).y + 12, label + ": transcript follows the advisory region")
            compare(transcript.y + transcript.height, footer.mapToItem(content, 0, 0).y, label + ": transcript ends at the footer")
            verify(region.clip && region.height < region.contentHeight, label + ": region " + region.height + " of " + region.contentHeight)
        }
        verifyAdvisoryGeometry("at rest")
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
        verify(editor.activeFocus)
        keyClick(Qt.Key_Tab)
        verify(close.activeFocus)
        keyClick(Qt.Key_Return)
        compare(closeSpy.count, 6)
        keyClick(Qt.Key_Space)
        compare(closeSpy.count, 7)
        keyClick(Qt.Key_Escape)
        compare(closeSpy.count, 8)
        keyClick(Qt.Key_Backtab)
        verify(editor.activeFocus)
        keyClick(Qt.Key_Backtab)
        verify(transcript.activeFocus)

        const uncertain = "Delivery could not be confirmed. Check the conversation before sending again; an action may already have run."
        editor.text = "one\ntwo\nthree\nfour\nfive"
        content.submissionOutcome = uncertain
        verify(waitForRendering(content))
        compare(findChild(content, "submissionNotice").text, uncertain)
        verify(transcript.height >= 58, "worst-case transcript height " + transcript.height)
        verifyAdvisoryGeometry("worst case")
        const topRule = findChild(content, "advisoryTopRule")
        const bottomRule = findChild(content, "advisoryBottomRule")
        verify(topRule !== null && bottomRule !== null)
        verify(bottomRule.visible && !topRule.visible)
        compare(region.Accessible.name, longestAdvisory + " " + content.placementAdvisory)
        verify(region.Accessible.focusable)
        verify(troubleBand.Accessible.ignored && advisory.Accessible.ignored)
        keyClick(Qt.Key_Backtab)
        verify(region.activeFocus)
        keyClick(Qt.Key_Home)
        compare(region.contentY, 0)
        keyClick(Qt.Key_Down)
        compare(region.contentY, 42)
        keyClick(Qt.Key_Escape)
        compare(closeSpy.count, 9, "the advisory region does not accept Escape")
        keyClick(Qt.Key_End)
        compare(region.contentY, region.contentHeight - region.height)
        const placementBottom = advisory.mapToItem(region, 0, advisory.height).y
        verify(placementBottom > 0 && placementBottom <= region.height, "placement bottom " + placementBottom + " region " + region.height)
        verify(topRule.visible && !bottomRule.visible)
        keyClick(Qt.Key_Tab)
        verify(transcript.activeFocus)
        keyClick(Qt.Key_Backtab)
        verify(region.activeFocus)
        keyClick(Qt.Key_Backtab)
        verify(close.activeFocus)
        keyClick(Qt.Key_Tab)
        verify(region.activeFocus)
        editor.clear()
        verify(waitForRendering(content))
        verify(region.height > 59, "region grows with the footer: " + region.height)
        verify(region.contentY + region.height <= region.contentHeight, "clamped contentY " + region.contentY)
        content.troubleAdvisory = ""
        verify(waitForRendering(content))
        verify(transcript.activeFocus, "an unclipped region hands focus to the transcript")
        verify(!region.Accessible.focusable)
        for (const invalid of [NaN, Infinity, -Infinity, 0, -2]) {
            content.textScale = invalid
            compare(sizes(), "14,16,12,16,16,12", "invalid text scale " + invalid + " falls back to 1")
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
