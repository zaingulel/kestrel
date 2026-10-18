import QtQuick
import qs.Commons
import qs.Ui

BarWidget {
    id: root
    moduleName: "local.kestrel"
    readonly property var service: bar?.shell?.serviceFor("local.kestrel") ?? null
    readonly property string currentState: service ? service.state : "unavailable"
    readonly property bool tooltipHovered: visible && hover.containsMouse
    readonly property string statusSentence: ({
        "not-running": "Not running. Microphone released by Kestrel.",
        "starting": "Starting. Microphone may be in use.",
        "unavailable": "Status unavailable. Microphone use unknown.",
        "idle": "Idle. Microphone in use.",
        "listening": "Listening. Microphone in use.",
        "thinking": "Thinking. Microphone in use.",
        "speaking": "Speaking. Microphone in use.",
        "trouble": "Brain trouble. Microphone in use."
    })[currentState]
    readonly property string tooltipText: ({
        "not-running": "Kestrel is not running. It is not holding the microphone.",
        "starting": "Starting. Microphone may be in use.",
        "unavailable": "Status unavailable. Microphone use unknown.",
        "idle": "Kestrel: idle. Microphone in use. Waiting for you to speak.",
        "listening": "Kestrel: listening to you. Microphone in use.",
        "thinking": "Kestrel: thinking about your message. Microphone in use.",
        "speaking": "Kestrel: speaking. Microphone in use.",
        "trouble": "Kestrel: brain trouble. A reply could not be completed. Microphone in use."
    })[currentState]
    implicitWidth: 25
    implicitHeight: 30
    Accessible.role: Accessible.StaticText
    Accessible.name: statusSentence

    Marks {
        anchors.fill: parent
        kind: root.currentState
        motionEnabled: root.service ? root.service.motionEnabled : false
        ink: Color.flatColor(Color.pick("bar.text", Color.foreground), Color.foreground)
        troubleInk: Color.flatColor(Color.pick("bar.active", Color.urgent), Color.urgent)
    }
    MouseArea {
        id: hover
        anchors.fill: parent
        acceptedButtons: Qt.NoButton
        hoverEnabled: true
        onEntered: if (root.bar) root.bar.showTooltip(root, root.tooltipText)
        onExited: if (root.bar) root.bar.hideTooltip(root)
    }
    onTooltipTextChanged: if (hover.containsMouse && bar) bar.showTooltip(root, tooltipText)
    onVisibleChanged: if (!visible && bar) bar.hideTooltip(root)
    Component.onDestruction: if (bar) bar.hideTooltip(root)
}
