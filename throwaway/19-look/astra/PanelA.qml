import Quickshell
import QtQuick

// Panel A: a narrow 448 x 640 conversation, Kestrel turns flush left, owner turns inset by 32 px.
FloatingWindow {
  id: win

  property var turns: []
  property string stateName: "idle"
  signal closeRequested()

  readonly property string blocked: Theme.sendBlocked[stateName] || ""
  readonly property int pad: Theme.popupPadding
  readonly property int composerTop: height - pad - (Theme.bodyLine + Theme.labelGap + 2 * Theme.controlHeight + Theme.controlGap + Theme.controlHeight)

  title: "Kestrel"
  implicitWidth: 28 * pad
  implicitHeight: 40 * pad
  minimumSize: Qt.size(implicitWidth, implicitHeight)
  maximumSize: Qt.size(implicitWidth, implicitHeight)
  color: Theme.popupsBackground

  onVisibleChanged: if (visible) field.focusInput()

  Item {
    anchors.fill: parent
    focus: true
    Keys.onEscapePressed: win.closeRequested()

    PanelHead {
      id: head
      x: win.pad
      y: win.pad
      width: parent.width - 2 * win.pad
      stateName: win.stateName
      onCloseRequested: win.closeRequested()
    }

    Text {
      id: moveHint
      x: win.pad
      y: head.y + head.height
      height: Theme.bodyLine
      verticalAlignment: Text.AlignVCenter
      text: "Move: Super + left drag"
      color: Theme.popupsText
      font.family: Theme.family
      font.pixelSize: Theme.caption
    }

    Transcript {
      id: transcript
      x: win.pad
      y: moveHint.y + moveHint.height + win.pad
      width: parent.width - 2 * win.pad
      height: win.composerTop - win.pad - y

      Column {
        width: transcript.contentWidth
        spacing: win.pad

        Text {
          visible: win.turns.length === 0
          width: parent.width
          text: win.stateName === "not-running"
            ? "Kestrel is not running.\nStart Kestrel to begin a conversation."
            : "Say something, or type below.\nKestrel replies after you."
          lineHeight: Theme.bodyLine
          lineHeightMode: Text.FixedHeight
          color: Theme.popupsText
          font.family: Theme.family
          font.pixelSize: Theme.body
        }

        Repeater {
          model: win.turns

          Message {
            required property var modelData
            readonly property int inset: modelData.who === "you" ? 2 * win.pad : 0
            turn: modelData
            x: inset
            width: transcript.contentWidth - inset
          }
        }
      }
    }

    Text {
      x: win.pad
      y: win.composerTop
      height: Theme.bodyLine
      verticalAlignment: Text.AlignVCenter
      text: "Message"
      color: Theme.popupsText
      font.family: Theme.family
      font.pixelSize: Theme.bodySmall
    }

    TypingField {
      id: field
      x: win.pad
      y: win.composerTop + Theme.bodyLine + Theme.labelGap
      width: parent.width - 2 * win.pad
    }

    Text {
      x: win.pad
      y: field.y + field.height + Theme.controlGap
      height: Theme.controlHeight
      verticalAlignment: Text.AlignVCenter
      text: win.blocked || "Enter to send"
      color: Theme.popupsText
      font.family: Theme.family
      font.pixelSize: Theme.caption
    }

    SendButton {
      x: parent.width - win.pad - width
      y: field.y + field.height + Theme.controlGap
      height: Theme.controlHeight
      enabled: field.text.length > 0 && win.blocked === ""
    }
  }
}
