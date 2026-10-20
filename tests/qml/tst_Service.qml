import QtQuick
import QtTest
import "../../desktop" as Desktop

TestCase {
    name: "Service"

    Component { id: serviceComponent; Desktop.Service {} }

    function test_submit_receipt_is_bounded_and_attempt_scoped() {
        const service = createTemporaryObject(serviceComponent, this)
        verify(service !== null)
        compare(service.submitPending, false)
        const sent = []
        const completed = []
        const stopped = []
        service.submitRequested.connect(function(id, payload) { sent.push([id, payload]) })
        service.submitCompleted.connect(function(id, status) { completed.push([id, status]) })
        service.submitStopRequested.connect(function(id) { stopped.push(id) })
        const first = service.submit("typed\nmessage 🦅")
        verify(first > 0)
        compare(service.submitPending, true)
        compare(sent.length, 1)
        compare(sent[0][0], first)
        compare(JSON.parse(sent[0][1]).version, 1)
        compare(JSON.parse(sent[0][1]).text, "typed\nmessage 🦅")
        verify(sent[0][1].endsWith("\n"))
        compare(service.submit("must not send"), 0)
        compare(sent.length, 1)
        compare(service.acceptSubmitChunk(first + 1, '{"status":"accepted"}\n'), false)
        service.submitExited(first + 1, 0, 0)
        compare(service.submitPending, true)
        compare(completed.length, 0)
        service.submitStarted(first)
        verify(service.acceptSubmitChunk(first, '{"status":"acc'))
        verify(service.acceptSubmitChunk(first, 'epted"}\n'))
        compare(completed.length, 0, "receipt is not acceptance until a matching normal exit")
        service.submitExited(first, 0, 0)
        compare(service.submitPending, false)
        compare(completed.length, 1)
        compare(completed[0][0], first)
        compare(completed[0][1], "accepted")
        service.submitExited(first, 0, 0)
        compare(completed.length, 1)

        const cases = [
            ['{"status":"accepted"}\n', 1, 0, "uncertain"],
            ['{"status":"accepted"}\n', 0, 1, "uncertain"],
            ['{"status":"invalid"}\n', 1, 0, "invalid"],
            ['{"status":"busy"}\n', 1, 0, "busy"],
            ['{"status":"unavailable"}\n', 1, 0, "unavailable"],
            ['{"status":"uncertain"}\n', 1, 0, "uncertain"],
            ['{"status":"busy"}\n', 0, 0, "uncertain"],
            ['{"status":"accepted"}\n', 2, 0, "uncertain"],
            ['{"status":"accepted"}', 0, 0, "uncertain"],
            ['{"status":"accepted"}\n{"status":"accepted"}\n', 0, 0, "uncertain"],
            ['{"status":"unknown"}\n', 0, 0, "uncertain"],
            ['{"status":"busy","status":"accepted"}\n', 0, 0, "uncertain"],
            ['{"status":"accepted","extra":true}\n', 0, 0, "uncertain"],
            ["x".repeat(65), 0, 0, "uncertain"],
            ['{"status":"accepted"}\n' + " ".repeat(65), 0, 0, "uncertain"],
            ['{"status":"accepted"}\n', 0, 0, "accepted"]
        ]
        for (const sample of cases) {
            const attempt = service.submit("another message")
            verify(attempt > first)
            service.submitStarted(attempt)
            compare(service.acceptSubmitChunk(first, '{"status":"accepted"}\n'), false)
            service.submitExited(first, 0, 0)
            compare(service.submitPending, true)
            const count = completed.length
            service.acceptSubmitChunk(attempt, sample[0])
            verify(service.submitBufferedLength <= 64)
            service.submitExited(attempt, sample[1], sample[2])
            compare(completed.length, count + 1)
            compare(completed[count][0], attempt)
            compare(completed[count][1], sample[3])
            compare(service.submitPending, false)
            compare(service.submitBufferedLength, 0)
        }
        compare(sent.length, cases.length + 1)
        verify(stopped.length > 0, "bad receipt requests owned child cleanup")
    }

    function test_submit_failure_and_reconnect_never_replay() {
        const service = createTemporaryObject(serviceComponent, this)
        verify(service !== null)
        const sent = []
        const completed = []
        const stopped = []
        service.submitRequested.connect(function(id, payload) { sent.push([id, payload]) })
        service.submitCompleted.connect(function(id, status) { completed.push([id, status]) })
        service.submitStopRequested.connect(function(id) { stopped.push(id) })
        const first = service.submit("no replay")
        const expiry = findChild(service, "submitExpiry")
        verify(expiry !== null)
        compare(expiry.interval, 3000)
        verify(expiry.running)
        service.visible = false
        service.watcherExited()
        service.conversationExited()
        verify(service.acceptStatusChunk("I"))
        verify(service.acceptConversationChunk('{"version":2,"session":"reconnected","turns":[]}\n'))
        compare(service.submitPending, true)
        compare(sent.length, 1)
        compare(stopped.length, 0, "hide and feed reconnect leave the sender alone")
        compare(completed.length, 0)
        service.submitStarted(first)
        expiry.triggered()
        compare(stopped.length, 1)
        compare(stopped[0], first)
        compare(service.submitPending, true, "retain ownership until child exit")
        compare(service.submit("blocked until reaped"), 0)
        compare(service.acceptSubmitChunk(first, '{"status":"accepted"}\n'), false)
        service.submitExited(first, 0, 0)
        compare(service.submitPending, false)
        compare(expiry.running, false)
        compare(completed.length, 1)
        compare(completed[0][1], "uncertain")
        compare(sent.length, 1)

        const beforeStart = service.submit("unknown startup")
        service.submitExited(beforeStart, -1, 1)
        compare(completed.length, 2)
        compare(completed[1][1], "uncertain", "no started signal is not proof that no write happened")
        const afterWrite = service.submit("possible write")
        service.submitStarted(afterWrite)
        service.submitExited(afterWrite, -1, 1)
        compare(completed.length, 3)
        compare(completed[2][1], "uncertain")
        compare(sent.length, 3)
        service.watcherExited()
        service.conversationExited()
        service.acceptStatusChunk("D")
        service.acceptConversationChunk('{"version":2,"session":"later","turns":[]}\n')
        compare(sent.length, 3)
        const deliberate = service.submit("deliberate next send")
        verify(deliberate > afterWrite)
        service.submitStarted(deliberate)
        service.submitExited(afterWrite, 0, 0)
        verify(service.submitPending)
        verify(service.acceptSubmitChunk(deliberate, '{"status":"accepted"}\n'))
        service.submitExited(deliberate, 0, 0)
        compare(completed.length, 4)
        compare(completed[3][0], deliberate)
        compare(completed[3][1], "accepted")
        compare(sent.length, 4)

        for (const invalid of ["", " \t\r\n", null, 1, "x".repeat(4097), "bad\u0000", "bad\u001f", "bad\u007f", "bad\u009f", "\ud800", "\udc00"]) {
            const count = completed.length
            const invalidAttempt = service.submit(invalid)
            verify(invalidAttempt > deliberate)
            tryCompare(service, "submitPending", false)
            compare(completed.length, count + 1)
            compare(completed[count][0], invalidAttempt)
            compare(completed[count][1], "invalid")
            compare(sent.length, 4, "invalid native input cannot launch a child")
        }
        const maximum = service.submit("🦅".repeat(2048))
        compare(sent.length, 5)
        compare(JSON.parse(sent[4][1]).text.length, 4096)
        service.submitStarted(maximum)
        service.acceptSubmitChunk(maximum, '{"status":"busy"}\n')
        service.submitExited(maximum, 1, 0)
        compare(service.submitPending, false)

        let destroyedStops = 0
        const doomed = createTemporaryObject(serviceComponent, this)
        doomed.submitStopRequested.connect(function() { destroyedStops++ })
        doomed.submit("destroyed draft")
        doomed.destroy()
        wait(0)
        compare(destroyedStops, 1)
        const replacement = createTemporaryObject(serviceComponent, this)
        let replacementSends = 0
        replacement.submitRequested.connect(function() { replacementSends++ })
        replacement.acceptStatusChunk("I")
        replacement.acceptConversationChunk('{"version":2,"session":"replacement","turns":[]}\n')
        compare(replacement.submitPending, false)
        compare(replacementSends, 0)
    }

    function test_status_input_death_and_silence() {
        const service = createTemporaryObject(serviceComponent, this)
        verify(service !== null)
        compare(service.shell, null)
        compare(service.state, "unavailable")
        const samples = [
            ["A", "starting"], ["I", "idle"], ["L", "listening"],
            ["T", "thinking"], ["S", "speaking"], ["B", "trouble"],
            ["N", "not-running"], ["U", "unavailable"],
            ["AILTSBNUIL", "listening"]
        ]
        for (const sample of samples) {
            service.acceptStatusChunk(sample[0])
            compare(service.state, sample[1])
            if (sample[0] === "B")
                compare(service.statusSentence, "Kestrel needs attention. Microphone in use.")
        }
        for (const invalid of ["", "X", "I\n", "I\u0000", "é", "I private transcript", "I".repeat(33)]) {
            service.acceptStatusChunk("S")
            compare(service.state, "speaking")
            service.acceptStatusChunk(invalid)
            compare(service.state, "unavailable", "invalid chunk must invalidate the previous state")
        }
        service.acceptStatusChunk("I".repeat(32))
        compare(service.state, "idle")
        service.watcherExited()
        compare(service.state, "unavailable")
        service.acceptStatusChunk("L")
        const expiry = findChild(service, "statusExpiry")
        verify(expiry !== null)
        compare(expiry.interval, 3000)
        verify(expiry.running)
        expiry.triggered()
        compare(service.state, "unavailable")
    }

    function test_inactive_status_and_empty_conversation() {
        const service = createTemporaryObject(serviceComponent, this)
        verify(service !== null)
        const snapshot = JSON.stringify({version: 2, session: "inactive-session", turns: []}) + "\n"
        verify(service.acceptConversationChunk(snapshot))
        compare(service.conversationMessage, "Say something. Kestrel replies after you.")
        verify(service.acceptStatusChunk("D"))
        compare(service.state, "inactive")
        compare(service.statusSentence, "Inactive. Microphone in use. Press Super + Shift + K to start.")
        compare(service.conversationAvailable, true)
        compare(service.turns.length, 0)
        compare(service.conversationMessage, "Press Super + Shift + K to start a conversation.")
        for (const wire of ["A", "I"]) {
            verify(service.acceptStatusChunk(wire))
            compare(service.conversationMessage, "Say something. Kestrel replies after you.")
        }
        verify(service.acceptStatusChunk("ID"))
        compare(service.state, "inactive")
        compare(service.conversationMessage, "Press Super + Shift + K to start a conversation.")
        service.conversationExited()
        compare(service.conversationMessage, "Conversation unavailable. Reopen the panel.")
        verify(service.acceptConversationChunk(snapshot))
        compare(service.conversationMessage, "Press Super + Shift + K to start a conversation.")
        verify(service.acceptConversationChunk(JSON.stringify({version: 2, session: "inactive-session", turns: [
            {speaker: "you", text: "Existing turn.", state: "complete", source: "spoken"}
        ]}) + "\n"))
        compare(service.conversationMessage, "")
        compare(service.turns.length, 1)
        service.watcherExited()
        compare(service.state, "unavailable")
        compare(service.statusSentence, "Status unavailable. Microphone use unknown.")
    }

    function test_conversation_rejects_corrupt_and_stale_input() {
        const service = createTemporaryObject(serviceComponent, this)
        verify(service !== null)
        const unavailable = "Conversation unavailable. Reopen the panel."
        const tooLarge = "Conversation is too large to display. Restart Kestrel to begin a new conversation."
        compare(service.acceptConversationChunk(JSON.stringify({version: 1, session: "old-session", turns: [
            {speaker: "you", text: "Unlabelled old input", state: "complete"}
        ]}) + "\n"), false, "version 1 must not guess spoken provenance")
        compare(service.conversationAvailable, false)
        compare(service.conversationMessage, unavailable)
        const snapshot = {version: 2, session: "literal-session", turns: [
            {speaker: "you", text: "<b>Literal owner text</b>", state: "complete", source: "spoken"},
            {speaker: "you", text: "<i>Literal typed text</i>", state: "complete", source: "typed"},
            {speaker: "kestrel", text: "Delivered prefix.", state: "interrupted"}
        ]}
        function send(record) { return service.acceptConversationChunk(JSON.stringify(record) + "\n") }
        function seed() {
            verify(send(snapshot))
            compare(service.conversationAvailable, true)
            compare(service.conversationSession, "literal-session")
            compare(service.turns.length, 3)
            compare(service.turns[0].text, "<b>Literal owner text</b>")
            compare(service.turns[0].source, "spoken")
            compare(service.turns[1].text, "<i>Literal typed text</i>")
            compare(service.turns[1].source, "typed")
        }
        compare(service.turns.length, 0)
        compare(service.conversationMessage, unavailable)
        compare(service.conversationSession, "")
        const encoded = JSON.stringify(snapshot) + "\n"
        verify(service.acceptConversationChunk(encoded.slice(0, 17)))
        compare(service.turns.length, 0)
        verify(service.acceptConversationChunk(encoded.slice(17)))
        compare(service.turns.length, 3)
        compare(service.conversationSession, "literal-session")
        verify(send({alive: "literal-session"}))
        const expiry = findChild(service, "conversationExpiry")
        verify(expiry !== null)
        compare(expiry.interval, 3000)
        verify(expiry.running)
        const invalid = [
            "null\n", "[]\n", "{\n", '{"alive":"other-session"}\n',
            '{"version":2,"session":"other-session","turns":[]}\n',
            '{"version":2,"session":"literal-session","turns":[],"extra":true}\n',
            '{"version":1,"session":"literal-session","turns":[]}\n',
            '{"version":2,"session":"","turns":[]}\n',
            '{"version":2,"session":"literal-session","turns":null}\n',
            '{"unavailable":"invented state"}\n',
            '{"unavailable":"' + unavailable + '","alive":"literal-session"}\n',
            "x".repeat(1048577)
        ]
        for (const field of ["speaker", "text", "state", "source", "extra"]) {
            const copy = JSON.parse(JSON.stringify(snapshot))
            copy.turns[0][field] = field === "text" ? 3 : "unknown"
            invalid.push(JSON.stringify(copy) + "\n")
        }
        const missing = JSON.parse(JSON.stringify(snapshot))
        delete missing.turns[0].source
        invalid.push(JSON.stringify(missing) + "\n")
        for (const source of [null, true, "kestrel", ""]) {
            const copy = JSON.parse(JSON.stringify(snapshot))
            copy.turns[0].source = source
            invalid.push(JSON.stringify(copy) + "\n")
        }
        for (const source of ["spoken", "typed"]) {
            const copy = JSON.parse(JSON.stringify(snapshot))
            copy.turns[2].source = source
            invalid.push(JSON.stringify(copy) + "\n")
        }
        for (const chunk of invalid) {
            seed()
            compare(service.acceptConversationChunk(chunk), false)
            compare(service.turns.length, 0)
            compare(service.conversationAvailable, false)
            compare(service.conversationSession, "")
            compare(service.conversationMessage, unavailable)
            compare(expiry.running, false)
        }
        seed()
        service.conversationExited()
        compare(service.conversationSession, "")
        compare(service.turns.length, 0)
        compare(service.conversationMessage, unavailable)
        seed()
        expiry.triggered()
        compare(service.conversationSession, "")
        compare(service.turns.length, 0)
        compare(service.conversationAvailable, false)
        seed()
        verify(send({unavailable: tooLarge}))
        verify(send({unavailable: tooLarge}))
        compare(service.turns.length, 0)
        compare(service.conversationMessage, tooLarge)
        compare(service.conversationSession, "")
        compare(expiry.running, false)
        verify(send({version: 2, session: "new-service", turns: []}))
        compare(service.conversationAvailable, true)
        compare(service.turns.length, 0)
        compare(service.conversationMessage, "Say something. Kestrel replies after you.")
        compare(service.conversationSession, "new-service")
        service.acceptStatusChunk("L")
        service.setPlacementFailure(true)
        compare(service.placementAdvisory, "Panel position could not be confirmed. Try closing and reopening it.")
        compare(service.state, "listening")
        service.setPlacementFailure(true, "configuration")
        compare(service.placementAdvisory, "Hyprland has configuration errors. Run hyprctl configerrors, fix the errors, then reopen the panel.")
        compare(service.state, "listening")
        service.setPlacementFailure(true, "private transcript canary")
        service.setPlacementFailure(false, "private transcript canary")
        service.setPlacementFailure("true", "position")
        service.setPlacementFailure(0, "configuration")
        compare(service.placementAdvisory, "Hyprland has configuration errors. Run hyprctl configerrors, fix the errors, then reopen the panel.")
        compare(service.state, "listening")
        service.setPlacementFailure(false)
        compare(service.placementAdvisory, "")
        compare(service.state, "listening")
    }

    function test_motion_requires_successful_fresh_true() {
        const service = createTemporaryObject(serviceComponent, this)
        verify(service !== null)
        compare(service.motionEnabled, false)
        const observed = '{"option": "animations:enabled", "bool": true, "set": true }'
        const invalid = [
            "true", "null", "[]", "{", '{}',
            '{"bool":true}', '{"option":"other","bool":true}',
            '{"option":"animations:enabled"}',
            '{"option":"animations:enabled","bool":"true"}',
            '{"option":"animations:enabled","bool":1}',
            '{"option":"animations:enabled","bool":false}',
            observed + " ".repeat(4097)
        ]
        for (const raw of invalid) {
            service.acceptMotionResult(observed, true)
            compare(service.motionEnabled, true)
            service.acceptMotionResult(raw, true)
            compare(service.motionEnabled, false, "invalid preference must disable motion")
        }
        service.acceptMotionResult(observed, true)
        service.acceptMotionResult(observed, false)
        compare(service.motionEnabled, false)
        service.acceptMotionResult('{"option":"animations:enabled","bool":true,"set":false}', true)
        compare(service.motionEnabled, true, "set is metadata rather than the preference")
        const expiry = findChild(service, "motionExpiry")
        verify(expiry !== null)
        compare(expiry.interval, 10000)
        verify(expiry.running)
        expiry.triggered()
        compare(service.motionEnabled, false)
    }
}
