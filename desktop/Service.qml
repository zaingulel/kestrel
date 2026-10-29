import QtQuick

Item {
    id: root
    visible: false
    property var shell: null
    // The native service contract deliberately exposes readonly state on a nonvisual Item.
    // qmllint disable property-override
    readonly property string state: statusValue.value
    // qmllint enable property-override
    readonly property bool motionEnabled: motionValue.enabled

    readonly property string statusSentence: ({
        "not-running": "Not running. Microphone released by Kestrel.",
        "inactive": "Voice off. Microphone in use. Press Super + Shift + K to start.",
        "starting": "Starting. Microphone may be in use.",
        "unavailable": "Status unavailable. Microphone use unknown.",
        "idle": "Waiting. Microphone in use.",
        "listening": "Listening. Microphone in use.",
        "thinking": "Thinking. Microphone in use.",
        "speaking": "Speaking. Microphone in use.",
        "trouble": "Kestrel needs attention. Microphone in use. " + troubleAdvisory
    })[state] + (brainNotice ? " " + brainNotice : "")
    readonly property string troubleAdvisory: statusValue.advisory
    readonly property string brainNotice: statusValue.notice
    readonly property string markKind: brainNotice ? state + "-slow" : state
    readonly property var turns: conversationValue.turns
    readonly property bool conversationAvailable: conversationValue.available
    readonly property string conversationMessage: !conversationValue.available ? conversationValue.message
        : conversationValue.turns.length ? "" : ({
        "not-running": "Start Kestrel to talk or type.",
        "inactive": "Press Super + Shift + K to talk, or type below.",
        "starting": "Kestrel is starting. Wait to talk or type.",
        "unavailable": "Voice status unknown.",
        "idle": "Say something, or type below.",
        "listening": "Say something, or type below.",
        "thinking": "Say something, or type below.",
        "speaking": "Say something, or type below.",
        "trouble": "Kestrel needs attention. Check the service log."
    })[state]
    readonly property string conversationSession: conversationValue.session
    readonly property string placementAdvisory: placementValue.advisory

    readonly property bool submitPending: submissionValue.pending
    readonly property int submitAttemptId: submissionValue.attempt
    readonly property int submitBufferedLength: submissionValue.output.length
    signal submitRequested(int attemptId, string payload)
    signal submitCompleted(int attemptId, string status)
    signal submitStopRequested(int attemptId)

    QtObject {
        id: submissionValue
        property int sequence: 0
        property int attempt: 0
        property bool pending: false
        property bool started: false
        property bool failed: false
        property string output: ""
    }

    function submit(text) {
        if (submissionValue.pending) return 0
        submissionValue.attempt = ++submissionValue.sequence
        submissionValue.pending = true
        submissionValue.started = false
        submissionValue.failed = false
        submissionValue.output = ""
        const attempt = submissionValue.attempt
        if (!validSubmissionText(text)) {
            Qt.callLater(function() { root.finishSubmit(attempt, "invalid") })
        } else {
            submitExpiry.restart()
            submitRequested(attempt, JSON.stringify({version: 1, text: text}) + "\n")
        }
        return attempt
    }

    function validSubmissionText(text) {
        if (typeof text !== "string" || !text.length || text.length > 4096 || !/\S/.test(text)
                || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)) return false
        for (let index = 0; index < text.length; index++) {
            const unit = text.charCodeAt(index)
            if (unit >= 0xd800 && unit <= 0xdbff) {
                const next = text.charCodeAt(++index)
                if (!(next >= 0xdc00 && next <= 0xdfff)) return false
            } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
        }
        return true
    }

    function submitStarted(attemptId) {
        if (submissionValue.pending && attemptId === submissionValue.attempt)
            submissionValue.started = true
    }

    function acceptSubmitChunk(attemptId, chunk) {
        if (!submissionValue.pending || attemptId !== submissionValue.attempt || submissionValue.failed) return false
        if (typeof chunk !== "string" || chunk.length > 64 - submissionValue.output.length
                || /[^\x00-\x7f]/.test(chunk)) {
            submissionValue.failed = true
            submissionValue.output = ""
            submitStopRequested(attemptId)
            return false
        }
        submissionValue.output += chunk
        return true
    }

    function submitExited(attemptId, exitCode, exitStatus) {
        if (!submissionValue.pending || attemptId !== submissionValue.attempt) return
        const receipt = /^\{"status":"(accepted|invalid|busy|unavailable|uncertain)"\}\n$/.exec(submissionValue.output)
        const status = submissionValue.started && !submissionValue.failed && receipt && exitStatus === 0
            && exitCode === (receipt[1] === "accepted" ? 0 : 1) ? receipt[1] : "uncertain"
        finishSubmit(attemptId, status)
    }

    function finishSubmit(attemptId, status) {
        if (!submissionValue.pending || attemptId !== submissionValue.attempt) return
        submitExpiry.stop()
        submissionValue.pending = false
        submissionValue.output = ""
        submitCompleted(attemptId, status)
    }

    function expireSubmit() {
        submitExpiry.stop()
        if (!submissionValue.pending || submissionValue.failed) return
        submissionValue.failed = true
        submissionValue.output = ""
        submitStopRequested(submissionValue.attempt)
    }

    Timer {
        id: submitExpiry
        objectName: "submitExpiry"
        interval: 3000
        onTriggered: root.expireSubmit()
    }

    Component.onDestruction: {
        if (submissionValue.pending) submitStopRequested(submissionValue.attempt)
    }

    // Only a running command blocks a press. Once it exits, the next press is sent as the shortcut sends it;
    // the form stays unconfirmed until the next verified status.
    readonly property bool toggleRunning: toggleValue.running
    readonly property bool toggleUnconfirmed: toggleValue.running || toggleValue.awaitingStatus
    signal toggleRequested()

    QtObject { id: toggleValue; property bool running: false; property bool awaitingStatus: false }

    function toggle() {
        if (toggleValue.running) return
        toggleValue.running = true
        toggleRequested()
    }

    function toggleExited() {
        if (!toggleValue.running) return
        toggleValue.running = false
        toggleValue.awaitingStatus = true
    }

    QtObject {
        id: conversationValue
        property var turns: []
        property bool available: false
        property string message: "Conversation unavailable. Reopen the panel."
        property string session: ""
        property string pending: ""
    }
    QtObject { id: placementValue; property string advisory: "" }

    function setPlacementFailure(failed, reason) {
        if (typeof failed !== "boolean"
                || (reason !== undefined && reason !== "position" && reason !== "configuration")) return
        if (!failed) {
            placementValue.advisory = ""
            return
        }
        placementValue.advisory = reason === "configuration"
            ? "Hyprland has configuration errors. Run hyprctl configerrors, fix the errors, then reopen the panel."
            : "Panel position could not be confirmed. Try closing and reopening it."
    }

    function conversationExited() {
        conversationExpiry.stop()
        conversationValue.turns = []
        conversationValue.available = false
        conversationValue.message = "Conversation unavailable. Reopen the panel."
        conversationValue.session = ""
        conversationValue.pending = ""
    }

    function acceptConversationChunk(chunk) {
        if (typeof chunk !== "string" || chunk.length > 1048576
                || chunk.length > 1048576 - conversationValue.pending.length) {
            conversationExited()
            return false
        }
        conversationValue.pending += chunk
        let end
        while ((end = conversationValue.pending.indexOf("\n")) !== -1) {
            const line = conversationValue.pending.slice(0, end)
            conversationValue.pending = conversationValue.pending.slice(end + 1)
            let record
            try { record = JSON.parse(line) } catch (error) {
                conversationExited()
                return false
            }
            if (!acceptConversationRecord(record)) {
                conversationExited()
                return false
            }
        }
        return true
    }

    function acceptConversationRecord(record) {
        if (record === null || typeof record !== "object" || Array.isArray(record)) return false
        const keys = Object.keys(record).sort().join(",")
        if (keys === "unavailable" && (record.unavailable === "Conversation unavailable. Reopen the panel."
                || record.unavailable === "Conversation is too large to display. Restart Kestrel to begin a new conversation.")) {
            conversationExpiry.stop()
            conversationValue.turns = []
            conversationValue.available = false
            conversationValue.message = record.unavailable
            conversationValue.session = ""
            return true
        }
        if (keys === "alive") {
            if (!conversationValue.available || record.alive !== conversationValue.session) return false
            conversationExpiry.restart()
            return true
        }
        if (keys !== "session,turns,version" || record.version !== 2
                || typeof record.session !== "string" || !record.session.length || record.session.length > 256
                || (conversationValue.session !== "" && record.session !== conversationValue.session)
                || !Array.isArray(record.turns)) return false
        for (const turn of record.turns) {
            if (turn === null || typeof turn !== "object" || Array.isArray(turn)
                    || Object.keys(turn).sort().join(",") !== (turn.speaker === "you" ? "source,speaker,state,text" : "speaker,state,text")
                    || (turn.speaker !== "you" && turn.speaker !== "kestrel")
                    || (turn.speaker === "you" && turn.source !== "spoken" && turn.source !== "typed")
                    || typeof turn.text !== "string"
                    || ["complete", "thinking", "speaking", "interrupted", "failed"].indexOf(turn.state) === -1) return false
        }
        conversationValue.session = record.session
        conversationValue.turns = record.turns
        conversationValue.available = true
        conversationExpiry.restart()
        return true
    }

    Timer {
        id: conversationExpiry
        objectName: "conversationExpiry"
        interval: 3000
        onTriggered: root.conversationExited()
    }

    QtObject { id: statusValue; property string value: "unavailable"; property string advisory: ""; property string notice: "" }
    QtObject { id: motionValue; property bool enabled: false }

    function acceptStatusChunk(chunk) {
        if (typeof chunk !== "string" || chunk.length < 1 || chunk.length > 32
                || /[^ADILTSBNUMPRVEOHWY]/.test(chunk)) {
            expireStatus()
            return false
        }
        const states = { A: "starting", D: "inactive", I: "idle", L: "listening", T: "thinking",
            S: "speaking", N: "not-running", U: "unavailable", W: "inactive", Y: "idle" }
        const advisories = {
            B: "Cause unknown. Check the service log, then restart Kestrel.",
            M: "Microphone capture failed. Restart Kestrel.",
            P: "Audio playback failed. Restart Kestrel.",
            R: "Speech recognition failed. Restart Kestrel.",
            V: "Voice generation failed. Restart Kestrel.",
            E: "Kestrel's engine is unavailable. Restart Kestrel.",
            O: "Local notes are unavailable or unsafe. Check note ownership, permissions, encoding and size, then restart Kestrel.",
            H: "A typed message could not reach the conversation. Restart Kestrel."
        }
        const letter = chunk.charAt(chunk.length - 1)
        statusValue.value = letter in advisories ? "trouble" : states[letter]
        statusValue.advisory = advisories[letter] || ""
        statusValue.notice = letter === "W" || letter === "Y"
            ? "The brain was slow to start. Replies may take longer." : ""
        toggleValue.awaitingStatus = false
        statusExpiry.restart()
        return true
    }

    function watcherExited() { expireStatus() }

    function expireStatus() {
        statusExpiry.stop()
        statusValue.value = "unavailable"
        statusValue.advisory = ""
        statusValue.notice = ""
        toggleValue.awaitingStatus = false
    }

    function acceptMotionResult(raw, success) {
        expireMotion()
        if (!success || typeof raw !== "string" || raw.length > 4096) return
        let result
        try { result = JSON.parse(raw) } catch (error) { return }
        if (result === null || typeof result !== "object" || Array.isArray(result)
                || result.option !== "animations:enabled" || typeof result.bool !== "boolean") return
        motionValue.enabled = result.bool
        motionExpiry.restart()
    }

    function expireMotion() {
        motionExpiry.stop()
        motionValue.enabled = false
    }

    Timer {
        id: statusExpiry
        objectName: "statusExpiry"
        interval: 3000
        onTriggered: root.expireStatus()
    }
    Timer {
        id: motionExpiry
        objectName: "motionExpiry"
        interval: 10000
        onTriggered: root.expireMotion()
    }
    Loader {
        active: root.shell !== null
        source: "NativeInputs.qml"
        onLoaded: {
            item.owner = root
            // Loader's QObject type cannot describe the dynamically loaded native I/O entry point.
            // qmllint disable missing-property
            item.start()
            // qmllint enable missing-property
        }
    }
}
