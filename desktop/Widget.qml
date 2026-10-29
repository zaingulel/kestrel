import QtQuick
import qs.Commons
import qs.Ui

BarWidget {
    id: root
    moduleName: "local.kestrel"
    readonly property var service: bar?.shell?.serviceFor("local.kestrel") ?? null
    readonly property string currentState: service ? service.state : "unavailable"
    readonly property bool tooltipHovered: visible && (hover.containsMouse || placementAdvisory !== "")
    readonly property string statusSentence: service ? service.statusSentence : "Status unavailable. Microphone use unknown."
    readonly property string brainNotice: service ? service.brainNotice : ""
    readonly property string placementAdvisory: service ? service.placementAdvisory : ""
    readonly property bool panelOpen: bar?.shell?.isPluginOpen("local.kestrel") ?? false
    readonly property string tooltipText: ({
        "not-running": "Kestrel is not running. It is not holding the microphone.",
        "inactive": "Voice off. Microphone in use. Press Super + Shift + K to start.",
        "starting": "Starting. Microphone may be in use.",
        "unavailable": "Status unavailable. Microphone use unknown.",
        "idle": "Kestrel: waiting for you to speak. Microphone in use.",
        "listening": "Kestrel: listening to you. Microphone in use.",
        "thinking": "Kestrel: thinking about your message. Microphone in use.",
        "speaking": "Kestrel: speaking. Microphone in use.",
        "trouble": statusSentence
    })[currentState] + (brainNotice ? " " + brainNotice : "") + (placementAdvisory ? " " + placementAdvisory : "")
    implicitWidth: 25
    implicitHeight: 30
    Accessible.role: Accessible.Button
    Accessible.name: (panelOpen ? "Close panel. " : "Open panel. ") + statusSentence
        + (placementAdvisory ? " " + placementAdvisory : "")
    Accessible.onPressAction: togglePanel()

    function togglePanel() { if (bar?.shell) bar.shell.toggle("local.kestrel", "{}") }


    Marks {
        anchors.fill: parent
        kind: root.service ? root.service.markKind : "unavailable"
        motionEnabled: root.service ? root.service.motionEnabled : false
        ink: root.bar?.transparent ? root.bar.barForeground : Color.flatColor(Color.pick("bar.text", Color.foreground), Color.foreground)
        troubleInk: Color.flatColor(Color.pick("bar.active", Color.urgent), Color.urgent)
        seeThrough: root.bar?.transparent ?? false
        flatBackground: {
            const flat = Color.flatColor(Color.pick("bar.background", Color.background), Color.background)
            return Qt.rgba(flat.r, flat.g, flat.b, 1)
        }
    }
    MouseArea {
        id: hover
        anchors.fill: parent
        acceptedButtons: Qt.LeftButton
        onClicked: root.togglePanel()
        hoverEnabled: true
        onEntered: if (root.bar) root.bar.showTooltip(root, root.tooltipText)
        onExited: if (root.bar && !root.placementAdvisory) root.bar.hideTooltip(root)
    }
    onTooltipTextChanged: if ((hover.containsMouse || placementAdvisory) && bar) bar.showTooltip(root, tooltipText)
    onPlacementAdvisoryChanged: {
        if (!bar) return
        if (placementAdvisory || hover.containsMouse) bar.showTooltip(root, tooltipText)
        else bar.hideTooltip(root)
    }
    onVisibleChanged: if (!visible && bar) bar.hideTooltip(root)
    Component.onDestruction: if (bar) bar.hideTooltip(root)
}
