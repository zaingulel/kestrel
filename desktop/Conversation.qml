import QtQuick
import QtQuick.Controls
import QtQuick.Shapes

FocusScope {
    id: root
    required property color background
    required property color ink
    required property color accentInk
    required property color troubleInk
    property string currentState: "unavailable"
    property string statusSentence: "Status unavailable. Microphone use unknown."
    property bool conversationAvailable: false
    property var service: null
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
    readonly property bool listeningFeed: conversationAvailable && currentState === "listening"
    readonly property int bodyLineHeight: Math.max(1, Math.round(21 * effectiveTextScale))
    property int editRevision: 0
    property int submittedRevision: 0
    property int pendingAttempt: 0
    property string submissionOutcome: ""
    readonly property bool replyInProgress: conversationAvailable && turns.length > 0
        && turns[turns.length - 1].speaker === "kestrel"
        && ["thinking", "speaking"].indexOf(turns[turns.length - 1].state) !== -1
    readonly property string submissionNotice: pendingAttempt !== 0 ? "Sending…"
        : submissionOutcome || (/\S/.test(composer.text) && replyInProgress
            ? "Sending stops the current reply." : "")
    signal closeRequested()
    implicitWidth: 448
    implicitHeight: 640

    function focusComposer() {
        composer.forceActiveFocus()
        composer.cursorPosition = composer.length
    }
    function sendDraft() {
        if (!service || !service.validSubmissionText(composer.text) || service.submitPending
                || composer.inputMethodComposing) return
        if (sendButton.activeFocus) composer.forceActiveFocus()
        submittedRevision = editRevision
        pendingAttempt = service.submit(composer.text)
        submissionOutcome = ""
    }
    Connections {
        target: root.service
        function onSubmitCompleted(attemptId, status) {
            if (attemptId !== root.pendingAttempt) return
            if (status === "accepted" && root.editRevision === root.submittedRevision
                    && !composer.inputMethodComposing) composer.clear()
            root.submissionOutcome = ({
                accepted: "",
                invalid: "Message not sent. Shorten it or remove unsupported control characters.",
                busy: "Message not accepted. Kestrel is finishing a change. Try Send again.",
                unavailable: "Message not sent. Kestrel is unavailable. Check the service, then try Send.",
                uncertain: "Delivery could not be confirmed. Check the conversation before sending again; an action may already have run."
            })[status]
            root.pendingAttempt = 0
        }
    }
    function announceTurn(text) { root.Accessible.announce(text, Accessible.Polite) }
    onSubmissionNoticeChanged: {
        if (root.visible && root.announcementsEnabled && root.submissionNotice.length) root.announceTurn(root.submissionNotice)
    }

    function fitTooltip(tooltip) {
        tooltip.popupType = Popup.Item
        tooltip.margins = 16
        tooltip.contentItem.wrapMode = Text.Wrap
        tooltip.width = Qt.binding(function() { return Math.min(tooltip.implicitWidth, root.width - 32) })
    }

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
            height: Math.max(titleColumn.height, closeButton.height)
            Accessible.description: "Move: Super + left drag"
            HoverHandler { id: headerHover }
            Loader {
                objectName: "headerMoveTooltip"
                sourceComponent: root.tooltipComponent
                onLoaded: {
                    item.parent = headerRow
                    item.text = Qt.binding(function() { return headerRow.Accessible.description })
                    root.fitTooltip(item)
                    item.visible = Qt.binding(function() { return headerHover.hovered && !microphoneHover.hovered && !closeButton.hovered })
                }
            }
            Loader {
                objectName: "microphoneTooltip"
                sourceComponent: root.tooltipComponent
                onLoaded: {
                    item.parent = microphoneStatus
                    item.text = Qt.binding(function() { return root.statusSentence })
                    root.fitTooltip(item)
                    item.visible = Qt.binding(function() { return microphoneHover.hovered })
                }
            }
            Column {
                id: titleColumn
                width: parent.width - 9 - closeButton.width
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
                        // No-break spaces keep each phrase whole, so the label wraps only after the middle dot.
                        text: ({"not-running": "Not running", "inactive": "Voice\u00a0off\u00a0· Mic\u00a0in\u00a0use", "starting": "Starting",
                            "unavailable": "Unavailable", "idle": "Waiting", "listening": "Listening", "thinking": "Thinking",
                            "speaking": "Speaking", "trouble": "Attention"})[root.currentState] || "Unavailable"
                        textFormat: Text.PlainText
                        wrapMode: Text.Wrap
                        color: root.currentState === "trouble" ? root.troubleInk : root.ink
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
                KeyNavigation.backtab: sendButton.enabled ? sendButton : composer
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
        height: Math.max(0, footer.y - y)
        contentWidth: width
        contentHeight: Math.max(height, turnColumn.height)
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
        KeyNavigation.tab: composer
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
            y: Math.max(0, transcript.height - height)
            Text {
                width: parent.width
                visible: text.length > 0
                text: root.listeningFeed ? "" : root.conversationMessage
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                horizontalAlignment: Text.AlignHCenter
                color: root.ink
                font.family: "monospace"
                font.pixelSize: root.bodyPixelSize
                lineHeight: root.bodyLineHeight
                lineHeightMode: Text.FixedHeight
            }
            Repeater {
                model: root.displayedTurns
                delegate: Item {
                    id: turnItem
                    required property var modelData
                    required property int index
                    objectName: "turnRow" + index
                    width: turnColumn.width
                    height: groupGap + bubble.height + (activeReply ? 26 : 0) + (notice.length ? 4 + noticeRow.height : 0)
                    readonly property bool owner: modelData.speaker === "you"
                    readonly property bool activeReply: root.conversationAvailable && !owner
                        && index === root.displayedTurns.length - 1
                        && (modelData.state === "thinking" || modelData.state === "speaking")
                    readonly property bool spoken: owner && modelData.source === "spoken" && modelData.state === "complete"
                    readonly property int groupGap: index === 0 ? 0
                        : root.displayedTurns[index - 1].speaker === modelData.speaker ? 4 : 14
                    readonly property bool continuesSpeaker: index > 0
                        && root.displayedTurns[index - 1].speaker === modelData.speaker
                    readonly property string notice: modelData.state === "interrupted" ? "Reply interrupted."
                        : modelData.state === "failed" ? "Reply could not be completed." : ""
                    Accessible.role: Accessible.StaticText
                    Accessible.name: (owner ? "You: " : "Kestrel: ")
                        + modelData.text + (notice ? " " + notice : "")
                    Accessible.description: spoken ? "Spoken message" : owner && modelData.source === "typed" ? "Typed message" : ""
                    Rectangle {
                        id: bubble
                        objectName: "turnBubble" + turnItem.index
                        x: turnItem.owner ? parent.width - width : 0
                        y: turnItem.groupGap
                        width: Math.min(parent.width - 56, Math.max(44, body.implicitWidth + 24,
                            turnItem.spoken ? provenance.width + 24 : 0))
                        visible: !turnItem.activeReply || turnItem.modelData.text.length > 0
                        height: visible ? body.implicitHeight + 16 + (turnItem.spoken ? root.captionLineHeight + 4 : 0) : 0
                        color: turnItem.owner ? root.bubbleWash : root.bubbleTint
                        topLeftRadius: !turnItem.owner && turnItem.continuesSpeaker ? 4 : 14
                        topRightRadius: turnItem.owner && turnItem.continuesSpeaker ? 4 : 14
                        bottomLeftRadius: turnItem.activeReply ? 0 : turnItem.owner ? 14 : 4
                        bottomRightRadius: turnItem.owner ? 4 : 14
                        Accessible.ignored: true
                        Text {
                            id: body
                            objectName: "turnText" + turnItem.index
                            x: 12
                            y: 8
                            width: parent.width - 24
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
                        Loader {
                            id: provenance
                            objectName: "turnProvenance" + turnItem.index
                            active: turnItem.spoken
                            x: parent.width - 12 - width
                            y: 8 + body.implicitHeight + 4
                            width: root.captionLineHeight
                            height: root.captionLineHeight
                            visible: turnItem.spoken
                            sourceComponent: root.glyphComponent
                            onLoaded: {
                                item.anchors.fill = item.parent
                                item.text = "󰍬"
                                item.fontSize = Qt.binding(function() { return root.captionPixelSize })
                                item.color = Qt.binding(function() { return root.ink })
                                item.Accessible.ignored = true
                            }
                            HoverHandler { id: provenanceHover }
                            Loader {
                                objectName: "turnProvenanceTooltip" + turnItem.index
                                active: turnItem.spoken
                                sourceComponent: root.tooltipComponent
                                onLoaded: {
                                    item.parent = provenance
                                    item.text = "Spoken message"
                                    root.fitTooltip(item)
                                    item.visible = Qt.binding(function() { return provenance.visible && provenanceHover.hovered })
                                }
                            }
                        }
                    }
                    Rectangle {
                        id: tail
                        objectName: "turnTail" + turnItem.index
                        x: bubble.x
                        y: bubble.y + bubble.height
                        width: 40
                        height: 26
                        visible: turnItem.activeReply
                        color: root.bubbleTint
                        topLeftRadius: bubble.visible ? 0 : 10
                        topRightRadius: bubble.visible ? 0 : 10
                        bottomRightRadius: 10
                        bottomLeftRadius: 4
                        Accessible.ignored: true
                        Marks {
                            objectName: "turnLiveMarks" + turnItem.index
                            anchors.centerIn: parent
                            feed: true
                            kind: turnItem.modelData.state
                            ink: root.ink
                            troubleInk: root.troubleInk
                            motionEnabled: root.motionEnabled && root.announcementsEnabled && turnItem.activeReply
                        }
                    }
                    Row {
                        id: noticeRow
                        y: bubble.y + bubble.height + 4
                        x: 2
                        visible: turnItem.notice.length > 0
                        width: parent.width - 4
                        spacing: 5
                        Accessible.ignored: true
                        Marks {
                            id: warningIcon
                            objectName: "turnFailure" + turnItem.index
                            visible: turnItem.modelData.state === "failed"
                            width: 25
                            height: 30
                            kind: "trouble"
                            ink: root.ink
                            troubleInk: root.troubleInk
                            motionEnabled: false
                        }
                        Text {
                            objectName: "turnNotice" + turnItem.index
                            width: parent.width - (warningIcon.visible ? warningIcon.width + parent.spacing : 0)
                            text: turnItem.notice
                            textFormat: Text.PlainText
                            wrapMode: Text.Wrap
                            color: root.ink
                            font.family: "monospace"
                            font.pixelSize: root.captionPixelSize
                            lineHeight: root.captionLineHeight
                            lineHeightMode: Text.FixedHeight
                        }
                    }
                }
            }
            Item {
                width: parent.width
                height: 14 + 26
                visible: root.listeningFeed
                Shape {
                    id: listeningGhost
                    objectName: "listeningGhost"
                    x: parent.width - width
                    y: 14
                    width: 40
                    height: 26
                    preferredRendererType: Shape.CurveRenderer
                    Accessible.role: Accessible.StaticText
                    Accessible.name: "Listening"
                    ShapePath {
                        objectName: "listeningGhostPath"
                        strokeColor: root.ink
                        strokeWidth: 1.5
                        strokeStyle: ShapePath.DashLine
                        capStyle: ShapePath.FlatCap
                        dashPattern: [4 / 1.5, 3 / 1.5]
                        fillColor: "transparent"
                        PathRectangle {
                            objectName: "listeningGhostOutline"
                            x: 0.75
                            y: 0.75
                            width: 38.5
                            height: 24.5
                            topLeftRadius: 9.25
                            topRightRadius: 9.25
                            bottomRightRadius: 3.25
                            bottomLeftRadius: 9.25
                        }
                    }
                    Marks {
                        objectName: "listeningGhostMark"
                        anchors.centerIn: parent
                        kind: "listening"
                        ink: root.ink
                        troubleInk: root.troubleInk
                        motionEnabled: root.motionEnabled && root.announcementsEnabled && root.listeningFeed
                    }
                }
            }
        }
    }
    Rectangle {
        objectName: "transcriptTopRule"
        x: transcript.x
        y: transcript.y
        width: transcript.width
        height: 1
        color: root.edgeRule
        visible: transcript.contentY > 0
        Accessible.ignored: true
    }
    Rectangle {
        objectName: "transcriptBottomRule"
        x: transcript.x
        y: transcript.y + transcript.height - height
        width: transcript.width
        height: 1
        color: root.edgeRule
        visible: transcript.contentY + transcript.height < transcript.contentHeight
        Accessible.ignored: true
    }
    Item {
        id: footer
        objectName: "composerFooter"
        x: 16
        y: root.height - height
        width: root.width - 32
        height: composerScroll.height + 10 + 12 + (submissionNotice.visible ? submissionNotice.height + 6 : 0)
        Text {
            id: submissionNotice
            objectName: "submissionNotice"
            y: 10
            width: parent.width
            visible: text.length > 0
            text: root.submissionNotice
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            color: root.ink
            font.family: "monospace"
            font.pixelSize: root.captionPixelSize
            lineHeight: root.captionLineHeight
            lineHeightMode: Text.FixedHeight
        }
        ScrollView {
            id: composerScroll
            objectName: "composerScroll"
            x: 0
            y: 10 + (submissionNotice.visible ? submissionNotice.height + 6 : 0)
            width: parent.width - sendButton.width - 9
            height: composer.contentHeight > 0 && composer.lineCount > 0
                ? Math.max(40, Math.min(composer.contentHeight,
                    composer.contentHeight / composer.lineCount * 5) + 18) : 40
            clip: true
            topPadding: 9
            bottomPadding: 9
            leftPadding: 12
            rightPadding: 12
            ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
            background: Rectangle {
                color: root.bubbleTint
                radius: 10
                border.width: composer.activeFocus ? 2 : 0
                border.color: root.accentInk
            }
            Flickable {
                contentWidth: width
                boundsBehavior: Flickable.StopAtBounds
                TextArea.flickable: TextArea {
                    id: composer
                    objectName: "composer"
                    color: root.ink
                    selectionColor: root.accentInk
                    selectedTextColor: root.flatBackground
                    textFormat: TextEdit.PlainText
                    wrapMode: TextEdit.Wrap
                    font.family: "monospace"
                    font.pixelSize: root.bodyPixelSize
                    topPadding: 0
                    bottomPadding: 0
                    leftPadding: 0
                    rightPadding: 0
                    background: null
                    Accessible.name: "Message Kestrel"
                    Accessible.multiLine: true
                    KeyNavigation.priority: KeyNavigation.BeforeItem
                    KeyNavigation.tab: sendButton.enabled ? sendButton : closeButton
                    KeyNavigation.backtab: transcript
                    onTextChanged: {
                        root.editRevision++
                        root.submissionOutcome = ""
                    }
                    Keys.onPressed: function(event) {
                        if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                            if (inputMethodComposing) return
                            if (event.modifiers & Qt.ShiftModifier) return
                            event.accepted = true
                            if (!event.isAutoRepeat) root.sendDraft()
                        } else if (event.key === Qt.Key_PageUp || event.key === Qt.Key_PageDown) {
                            transcript.scrollBy(event.key === Qt.Key_PageUp ? -transcript.height : transcript.height)
                            event.accepted = true
                        }
                    }
                }
            }
            Text {
                objectName: "composerPlaceholder"
                width: composerScroll.availableWidth
                text: "Message Kestrel"
                textFormat: Text.PlainText
                color: root.ink
                font.family: "monospace"
                font.pixelSize: root.bodyPixelSize
                font.italic: true
                visible: composer.length === 0 && !composer.inputMethodComposing
                Accessible.ignored: true
            }
        }
        Button {
            id: sendButton
            objectName: "sendMessage"
            anchors.right: parent.right
            y: composerScroll.y + composerScroll.height - height
            width: Math.max(40, sendGlyph.implicitWidth + 24)
            height: Math.max(40, sendGlyph.implicitHeight + 18)
            padding: 0
            enabled: root.service !== null && root.service.validSubmissionText(composer.text)
                && !root.service.submitPending && !composer.inputMethodComposing
            Accessible.name: "Send message"
            onEnabledChanged: if (!enabled && focus && root.activeFocus) composer.forceActiveFocus()
            KeyNavigation.tab: closeButton
            KeyNavigation.backtab: composer
            onClicked: root.sendDraft()
            Keys.onReturnPressed: function(event) { if (!event.isAutoRepeat) root.sendDraft() }
            Keys.onEnterPressed: function(event) { if (!event.isAutoRepeat) root.sendDraft() }
            contentItem: Loader {
                id: sendGlyph
                sourceComponent: root.glyphComponent
                onLoaded: {
                    item.anchors.fill = item.parent
                    item.text = "󰁝"
                    item.fontSize = Qt.binding(function() { return root.bodyPixelSize })
                    item.color = Qt.binding(function() { return sendButton.enabled ? root.flatBackground
                        : Qt.rgba(root.ink.r, root.ink.g, root.ink.b, 0.6) })
                    item.Accessible.ignored = true
                }
            }
            background: Rectangle {
                radius: 10
                color: sendButton.enabled ? root.accentInk : "transparent"
                border.width: sendButton.enabled ? 0 : 1.5
                border.color: root.edgeRule
                Rectangle {
                    anchors.fill: parent
                    anchors.margins: -4
                    radius: 14
                    color: "transparent"
                    border.width: 2
                    border.color: root.accentInk
                    visible: sendButton.activeFocus
                    Accessible.ignored: true
                }
            }
        }
    }
}
