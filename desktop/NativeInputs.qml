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
    property bool motionPending: false
    property bool motionFailed: false
    property string motionOutput: ""

    function start() {
        if (!owner || active) return
        active = true
        startWatcher()
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
        preference.running = false
    }
}
