import QtQuick
import Quickshell
import Quickshell.Io

Item {
    id: root
    visible: false
    property var owner: null
    property bool active: false
    property bool watcherPending: false
    property bool watcherStopping: false
    property bool conversationPending: false
    property bool conversationStopping: false
    property bool motionPending: false
    property bool motionFailed: false
    property string motionOutput: ""
    property bool senderPending: false
    property bool senderStopping: false
    property int senderAttempt: 0
    property string senderPayload: ""

    function startSubmit(attemptId, payload) {
        if (!active || senderPending) return
        senderPending = true
        senderStopping = false
        senderAttempt = attemptId
        senderPayload = payload
        sender.stdinEnabled = true
        sender.running = true
    }

    function stopSubmit(attemptId) {
        if (!senderPending || attemptId !== senderAttempt || senderStopping) return
        senderStopping = true
        senderPayload = ""
        sender.running = false
        if (!sender.running) {
            finishSubmit(-1, 1)
            return
        }
        senderKill.restart()
    }

    function finishSubmit(exitCode, exitStatus) {
        if (!senderPending) return
        senderKill.stop()
        const attempt = senderAttempt
        senderPending = false
        senderAttempt = 0
        senderPayload = ""
        owner.submitExited(attempt, exitCode, exitStatus)
    }

    Connections {
        target: root.owner
        function onSubmitRequested(attemptId, payload) { root.startSubmit(attemptId, payload) }
        function onSubmitStopRequested(attemptId) { root.stopSubmit(attemptId) }
        function onToggleRequested() { toggler.running = true }
    }

    Process {
        id: sender
        command: ["/usr/bin/python3", Quickshell.env("HOME") + "/.config/omarchy/plugins/local.kestrel/control.py", "--submit"]
        onStarted: {
            root.owner.submitStarted(root.senderAttempt)
            if (!root.senderStopping) sender.write(root.senderPayload)
            sender.stdinEnabled = false
            root.senderPayload = ""
        }
        stdout: SplitParser {
            splitMarker: ""
            onRead: function(data) {
                if (root.senderPending) root.owner.acceptSubmitChunk(root.senderAttempt, data)
            }
        }
        stderr: SplitParser { splitMarker: "" }
        onExited: function(exitCode, exitStatus) { root.finishSubmit(exitCode, exitStatus) }
        // Failed startup has no public error signal, so absent a receipt its outcome stays uncertain.
        onRunningChanged: if (!running && root.senderPending) root.finishSubmit(-1, 1)
    }
    Timer {
        id: senderKill
        interval: 1000
        onTriggered: {
            // A starting QProcess can still have PID zero; never signal its process group.
            if (sender.processId > 0) sender.signal(9)
        }
    }

    // The reply is never read: voice state comes from verified status, refusal from control.py's own notification attempt.
    Process {
        id: toggler
        command: ["/usr/bin/python3", Quickshell.env("HOME") + "/.config/omarchy/plugins/local.kestrel/control.py", "--toggle"]
        stdout: SplitParser { splitMarker: "" }
        stderr: SplitParser { splitMarker: "" }
        onExited: root.owner.toggleExited()
        onRunningChanged: if (!running) root.owner.toggleExited()
    }

    function start() {
        if (!owner || active) return
        active = true
        startWatcher()
        startConversation()
        queryMotion()
    }

    function startWatcher() {
        if (!active || watcherPending) return
        watcherPending = true
        watcherStopping = false
        watcher.running = true
    }

    function stopWatcher() {
        if (watcherStopping) return
        watcherStopping = true
        watcher.running = false
        watcherKill.restart()
    }

    function startConversation() {
        if (!active || conversationPending) return
        conversationPending = true
        conversationStopping = false
        conversation.running = true
    }

    function stopConversation() {
        if (conversationStopping) return
        conversationStopping = true
        conversation.running = false
        conversationKill.restart()
    }

    function queryMotion() {
        if (!active || motionPending) return
        motionPending = true
        motionFailed = false
        motionOutput = ""
        preference.running = true
        motionWatchdog.restart()
    }

    function failMotion() {
        motionFailed = true
        motionOutput = ""
        owner.acceptMotionResult("", false)
        preference.running = false
        preference.signal(9)
    }

    Process {
        id: watcher
        command: ["/usr/bin/python3", Quickshell.env("HOME") + "/.config/omarchy/plugins/local.kestrel/status.py", "--watch"]
        stdout: SplitParser {
            splitMarker: ""
            onRead: function(data) {
                if (!root.watcherStopping && !root.owner.acceptStatusChunk(data)) root.stopWatcher()
            }
        }
        stderr: SplitParser { splitMarker: "" }
        onExited: {
            watcherKill.stop()
            root.watcherPending = false
            root.owner.watcherExited()
        }
    }
    Timer {
        interval: 1000
        repeat: true
        running: root.active
        onTriggered: root.startWatcher()
    }
    Timer {
        id: watcherKill
        interval: 1000
        onTriggered: watcher.signal(9)
    }

    Process {
        id: conversation
        command: ["/usr/bin/python3", Quickshell.env("HOME") + "/.config/omarchy/plugins/local.kestrel/conversation.py", "--watch"]
        stdout: SplitParser {
            splitMarker: ""
            onRead: function(data) {
                if (!root.conversationStopping && !root.owner.acceptConversationChunk(data)) root.stopConversation()
            }
        }
        stderr: SplitParser { splitMarker: "" }
        onExited: {
            conversationKill.stop()
            root.conversationPending = false
            root.owner.conversationExited()
        }
    }
    Timer {
        interval: 1000
        repeat: true
        running: root.active
        onTriggered: root.startConversation()
    }
    Timer {
        id: conversationKill
        interval: 1000
        onTriggered: conversation.signal(9)
    }

    Process {
        id: preference
        command: ["/usr/bin/hyprctl", "-j", "getoption", "animations:enabled"]
        stdout: SplitParser {
            splitMarker: ""
            onRead: function(data) {
                if (root.motionFailed) return
                if (data.length > 4096 - root.motionOutput.length) {
                    root.failMotion()
                    return
                }
                root.motionOutput += data
            }
        }
        stderr: SplitParser { splitMarker: "" }
        onExited: function(exitCode, exitStatus) {
            motionWatchdog.stop()
            root.owner.acceptMotionResult(root.motionOutput,
                !root.motionFailed && exitCode === 0 && exitStatus === 0)
            root.motionOutput = ""
            root.motionPending = false
        }
    }
    Timer {
        interval: 5000
        repeat: true
        running: root.active
        onTriggered: root.queryMotion()
    }
    Timer {
        id: motionWatchdog
        interval: 1000
        onTriggered: root.failMotion()
    }

    // Nondetached Process children are killed and reaped by Quickshell on destruction.
    Component.onDestruction: {
        active = false
        watcher.running = false
        conversation.running = false
        preference.running = false
        senderPayload = ""
        sender.running = false
        toggler.running = false
    }
}
