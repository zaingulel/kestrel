import QtQuick
import QtQuick.Controls

FocusScope {
    id: root
    required property color background
    required property color ink
    required property color accentInk
    required property color troubleInk
    property string currentState: "unavailable"
    property string statusSentence: "Status unavailable. Microphone use unknown."
    property bool conversationAvailable: false
    property Component glyphComponent: null
    property Component tooltipComponent: null
    property color flatBackground: Qt.rgba(background.r, background.g, background.b, 1)
    readonly property color bubbleTint: Qt.tint(flatBackground, Qt.rgba(ink.r, ink.g, ink.b, 0.10))
    readonly property color bubbleWash: Qt.tint(flatBackground, Qt.rgba(accentInk.r, accentInk.g, accentInk.b, 0.20))
    readonly property color edgeRule: Qt.tint(flatBackground, Qt.rgba(ink.r, ink.g, ink.b, 0.20))
    readonly property string microphoneAppearance: currentState === "not-running" ? "off"
        : ["inactive", "idle", "listening", "thinking", "speaking", "trouble"].indexOf(currentState) !== -1 ? "on" : "unknown"
    property bool motionEnabled: false
    property var turns: []
    property string conversationMessage: "Conversation unavailable. Reopen the panel."
    property string placementAdvisory: ""
    property var displayedTurns: []
    property string conversationSession: ""
    property bool announcementsEnabled: false
    property string announcementSession: ""
    property var seenTerminalStates: []
    property bool baselineRequired: true
    property real textScale: 1
    readonly property real effectiveTextScale: isFinite(textScale) && textScale > 0 ? textScale : 1
    readonly property int captionPixelSize: Math.max(1, Math.round(12 * effectiveTextScale))
    readonly property int bodyPixelSize: Math.max(1, Math.round(14 * effectiveTextScale))
    readonly property int titlePixelSize: Math.max(1, Math.round(16 * effectiveTextScale))
    readonly property int captionLineHeight: Math.max(1, Math.round(16 * effectiveTextScale))
    readonly property int titleLineHeight: Math.max(1, Math.round(20 * effectiveTextScale))
    readonly property int bodyLineHeight: Math.max(1, Math.round(21 * effectiveTextScale))
    signal closeRequested()
    implicitWidth: 448
    implicitHeight: 640

    function focusClose() { closeButton.forceActiveFocus() }
    function announceTurn(text) { root.Accessible.announce(text, Accessible.Polite) }

    function updateTurns() {
        const follow = transcript.followBottom
        const previousY = transcript.contentY
        transcript.restoring = true
        displayedTurns = turns
        // A baseline, a hidden panel or an unavailable session records terminal states silently.
        const silent = baselineRequired || !announcementsEnabled || conversationSession !== announcementSession
        const seen = seenTerminalStates
        seenTerminalStates = turns.map(function(turn) {
            return ["complete", "interrupted", "failed"].indexOf(turn.state) !== -1 ? turn.state : ""
        })
        announcementSession = conversationSession
        baselineRequired = conversationSession === ""
        for (let i = 0; !silent && i < turns.length; i++) {
            const turn = turns[i]
            if (seenTerminalStates[i] && !seen[i]) {
                announceTurn((turn.speaker === "you" ? "You: " : "Kestrel: ")
                    + turn.text + (turn.state === "interrupted" ? " Reply interrupted."
                        : turn.state === "failed" ? " Reply could not be completed." : ""))
            }
        }
        Qt.callLater(function() {
            // The panel may unload before this deferred restoration runs.
            if (!transcript) return
            const end = Math.max(0, transcript.contentHeight - transcript.height)
            transcript.contentY = follow ? end : Math.min(previousY, end)
            transcript.restoring = false
        })
    }
    // Deferred so one accepted snapshot's session and turns are observed together.
    onTurnsChanged: Qt.callLater(updateTurns)
    // Latched now: a batched unavailable-then-same-session pair coalesces into one deferred update.
    onConversationSessionChanged: {
        if (conversationSession === "") baselineRequired = true
        Qt.callLater(updateTurns)
    }
    onAnnouncementsEnabledChanged: {
        baselineRequired = true
        Qt.callLater(updateTurns)
    }
    Keys.onEscapePressed: closeRequested()

    Rectangle { anchors.fill: parent; color: root.background }
    Column {
        id: header
        x: 16
        y: 14
        width: parent.width - 32
        spacing: 9
        Item {
            id: headerRow
            objectName: "conversationHeader"
            width: parent.width
            height: Math.max(30, titleColumn.height, closeButton.height)
            Accessible.description: "Move: Super + left drag"
            HoverHandler { id: headerHover }
            Loader {
                objectName: "headerMoveTooltip"
                sourceComponent: root.tooltipComponent
                onLoaded: {
                    item.parent = headerRow
                    item.text = Qt.binding(function() { return headerRow.Accessible.description })
                    item.visible = Qt.binding(function() { return headerHover.hovered && !microphoneHover.hovered && !closeButton.hovered })
                }
            }
            Loader {
                objectName: "microphoneTooltip"
                sourceComponent: root.tooltipComponent
                onLoaded: {
                    item.parent = microphoneStatus
                    item.text = Qt.binding(function() { return root.statusSentence })
                    item.visible = Qt.binding(function() { return microphoneHover.hovered })
                }
            }
            Marks {
                objectName: "headerMark"
                anchors.left: parent.left
                anchors.verticalCenter: parent.verticalCenter
                width: 25
                height: 30
                kind: root.currentState
                ink: root.ink
                troubleInk: root.troubleInk
                motionEnabled: false
            }
            Column {
                id: titleColumn
                x: 34
                width: parent.width - x - 9 - closeButton.width
                anchors.verticalCenter: parent.verticalCenter
                Text {
                    id: titleText
                    objectName: "conversationTitle"
                    width: parent.width
                    text: "Kestrel"
                    textFormat: Text.PlainText
                    wrapMode: Text.Wrap
                    color: root.ink
                    font.family: "monospace"
                    font.pixelSize: root.titlePixelSize
                    font.bold: true
                    lineHeight: root.titleLineHeight
                    lineHeightMode: Text.FixedHeight
                }
                Row {
                    id: microphoneStatus
                    objectName: "microphoneStatus"
                    width: parent.width
                    spacing: 5
                    Accessible.role: Accessible.StaticText
                    Accessible.name: root.statusSentence
                    Accessible.description: root.statusSentence
                    Accessible.focusable: false
                    HoverHandler { id: microphoneHover }
                    Item {
                        id: microphoneSlot
                        width: Math.max(24, root.bodyLineHeight + root.captionPixelSize / 2)
                        height: width
                        Loader {
                            objectName: "microphoneGlyph"
                            anchors.fill: parent
                            sourceComponent: root.glyphComponent
                            onLoaded: {
                                item.anchors.fill = item.parent
                                item.text = Qt.binding(function() { return root.microphoneAppearance === "off" ? "󰍭" : "󰍬" })
                                item.fontSize = Qt.binding(function() { return root.bodyPixelSize })
                                item.color = Qt.binding(function() { return root.ink })
                                item.Accessible.ignored = true
                            }
                        }
                        Rectangle {
                            objectName: "microphoneQuestion"
                            anchors.right: parent.right
                            anchors.top: parent.top
                            width: root.captionLineHeight
                            height: width
                            radius: width / 2
                            color: root.flatBackground
                            visible: root.microphoneAppearance === "unknown"
                            Accessible.ignored: true
                            Text {
                                anchors.centerIn: parent
                                text: "?"
                                textFormat: Text.PlainText
                                color: root.ink
                                font.family: "monospace"
                                font.pixelSize: root.captionPixelSize
                            }
                        }
                    }
                    Text {
                        objectName: "conversationStatus"
                        width: parent.width - microphoneSlot.width - parent.spacing
                        anchors.verticalCenter: parent.verticalCenter
                        text: ({"not-running": "Not running", "inactive": "Inactive", "starting": "Starting",
                            "unavailable": "Unavailable", "idle": "Idle", "listening": "Listening", "thinking": "Thinking",
                            "speaking": "Speaking", "trouble": "Attention"})[root.currentState] || "Unavailable"
                        textFormat: Text.PlainText
                        wrapMode: Text.Wrap
                        color: root.ink
                        font.family: "monospace"
                        font.pixelSize: root.captionPixelSize
                        lineHeight: root.captionLineHeight
                        lineHeightMode: Text.FixedHeight
                        Accessible.ignored: true
                    }
                }
            }
            Button {
                id: closeButton
                objectName: "closeConversation"
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                // 4 leaves room for the 2-pixel focus stroke on both sides of the glyph.
                width: Math.max(33, Math.ceil(Math.max(closeGlyph.implicitWidth, closeGlyph.implicitHeight)) + 4)
                height: width
                padding: 0
                hoverEnabled: true
                Accessible.role: Accessible.Button
                Accessible.name: "Close panel"
                KeyNavigation.tab: transcript
                KeyNavigation.backtab: transcript
                contentItem: Text {
                    id: closeGlyph
                    text: "×"
                    textFormat: Text.PlainText
                    horizontalAlignment: Text.AlignHCenter
                    verticalAlignment: Text.AlignVCenter
                    font.family: "monospace"
                    font.pixelSize: root.titlePixelSize
                    color: root.ink
                    Accessible.ignored: true
                }
                background: Rectangle {
                    color: "transparent"
                    radius: 8
                    Rectangle {
                        anchors.fill: parent
                        anchors.margins: -4
                        radius: 12
                        color: "transparent"
                        border.width: 2
                        border.color: root.accentInk
                        visible: closeButton.activeFocus
                        Accessible.ignored: true
                    }
                }
                onClicked: root.closeRequested()
                Keys.onReturnPressed: root.closeRequested()
                Keys.onEnterPressed: root.closeRequested()
            }
        }
        Text {
            width: parent.width
            visible: text.length > 0
            text: root.placementAdvisory
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            color: root.ink
            font.family: "monospace"
            font.pixelSize: root.bodyPixelSize
            lineHeight: root.bodyLineHeight
            lineHeightMode: Text.FixedHeight
        }
    }
    Flickable {
        id: transcript
        objectName: "transcript"
        x: 16
        y: header.y + header.height + 12
        width: parent.width - 32
        height: Math.max(0, parent.height - y - 16)
        contentWidth: width
        contentHeight: turnColumn.height
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        activeFocusOnTab: true
        property bool followBottom: true
        property bool restoring: false
        onContentYChanged: if (!restoring) followBottom = atYEnd
        onContentHeightChanged: {
            if (followBottom) {
                const previousRestoring = restoring
                restoring = true
                contentY = Math.max(0, contentHeight - height)
                restoring = previousRestoring
            }
        }
        Accessible.role: Accessible.Document
        Accessible.name: "Conversation"
        Accessible.readOnly: true
        Accessible.focusable: true
        KeyNavigation.tab: closeButton
        KeyNavigation.backtab: closeButton

        function scrollBy(amount) {
            contentY = Math.max(0, Math.min(Math.max(0, contentHeight - height), contentY + amount))
        }
        Accessible.onScrollUpAction: scrollBy(-root.bodyLineHeight)
        Accessible.onScrollDownAction: scrollBy(root.bodyLineHeight)
        Accessible.onPreviousPageAction: scrollBy(-height)
        Accessible.onNextPageAction: scrollBy(height)
        Keys.onPressed: function(event) {
            if (event.key === Qt.Key_Up) scrollBy(-root.bodyLineHeight)
            else if (event.key === Qt.Key_Down) scrollBy(root.bodyLineHeight)
            else if (event.key === Qt.Key_PageUp) scrollBy(-height)
            else if (event.key === Qt.Key_PageDown) scrollBy(height)
            else if (event.key === Qt.Key_Home) contentY = 0
            else if (event.key === Qt.Key_End) contentY = Math.max(0, contentHeight - height)
            else return
            event.accepted = true
        }
        Rectangle {
            x: 0
            y: transcript.contentY
            width: transcript.width
            height: transcript.height
            color: "transparent"
            border.width: transcript.activeFocus ? 2 : 0
            border.color: root.accentInk
            z: 1
            Accessible.ignored: true
        }
        Column {
            id: turnColumn
            width: transcript.width
            spacing: 16
            Text {
                width: parent.width
                visible: text.length > 0
                text: root.conversationMessage
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: root.ink
                font.family: "monospace"
                font.pixelSize: root.bodyPixelSize
                lineHeight: root.bodyLineHeight
                lineHeightMode: Text.FixedHeight
            }
            Repeater {
                model: root.displayedTurns
                delegate: Column {
                    id: turnItem
                    required property var modelData
                    required property int index
                    x: modelData.speaker === "you" ? 32 : 0
                    width: turnColumn.width - x
                    spacing: 5
                    readonly property string notice: modelData.state === "interrupted" ? "Reply interrupted."
                        : modelData.state === "failed" ? "Reply could not be completed." : ""
                    Accessible.role: Accessible.StaticText
                    Accessible.name: (modelData.speaker === "you" ? "You: " : "Kestrel: ")
                        + modelData.text + (notice ? " " + notice : "")
                    Row {
                        spacing: 5
                        Accessible.ignored: true
                        Text {
                            text: turnItem.modelData.speaker === "you" ? "You" : "Kestrel"
                            textFormat: Text.PlainText
                            color: turnItem.modelData.speaker === "you" ? root.ink : root.accentInk
                            font.family: "monospace"
                            font.pixelSize: root.bodyPixelSize
                            font.bold: true
                        }
                        Text {
                            text: turnItem.modelData.state === "thinking" ? "Thinking"
                                : turnItem.modelData.state === "speaking" ? "Speaking" : ""
                            textFormat: Text.PlainText
                            color: root.ink
                            font.family: "monospace"
                            font.pixelSize: root.captionPixelSize
                        }
                    }
                    Text {
                        objectName: "turnText" + turnItem.index
                        width: parent.width
                        text: turnItem.modelData.text
                        textFormat: Text.PlainText
                        wrapMode: Text.Wrap
                        color: root.ink
                        font.family: "monospace"
                        font.pixelSize: root.bodyPixelSize
                        lineHeight: root.bodyLineHeight
                        lineHeightMode: Text.FixedHeight
                        Accessible.ignored: true
                    }
                    Row {
                        visible: turnItem.notice.length > 0
                        width: parent.width
                        spacing: 5
                        Accessible.ignored: true
                        Text {
                            id: warningIcon
                            text: "⚠"
                            textFormat: Text.PlainText
                            color: root.accentInk
                            font.family: "monospace"
                            font.pixelSize: root.bodyPixelSize
                        }
                        Text {
                            objectName: "turnNotice" + turnItem.index
                            width: parent.width - warningIcon.width - parent.spacing
                            text: turnItem.notice
                            textFormat: Text.PlainText
                            wrapMode: Text.Wrap
                            color: root.ink
                            font.family: "monospace"
                            font.pixelSize: root.bodyPixelSize
                            lineHeight: root.bodyLineHeight
                            lineHeightMode: Text.FixedHeight
                        }
                    }
                }
            }
        }
    }
}
