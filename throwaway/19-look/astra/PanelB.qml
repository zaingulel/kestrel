import Quickshell
import QtQuick

// Panel B: a wide 704 x 512 conversation, each owner turn beside its Kestrel reply in one shared scroll.
FloatingWindow {
  id: win

  property var turns: []
  property string stateName: "idle"
  signal closeRequested()

  readonly property string blocked: Theme.sendBlocked[stateName] || ""
  readonly property int pad: Theme.popupPadding
  readonly property int sendWidth: 3 * Theme.controlHeight
  readonly property int composerTop: height - pad - (Theme.bodyLine + Theme.labelGap + 2 * Theme.controlHeight + Theme.labelGap + Theme.bodyLine)
  readonly property var rows: {
    const out = []
    for (let i = 0; i < turns.length; i++) {
      if (turns[i].who === "you")
        out.push({ you: turns[i], kestrel: i + 1 < turns.length && turns[i + 1].who === "kestrel" ? turns[i + 1] : null })
    }
    return out
  }

  title: "Kestrel"
  implicitWidth: 44 * pad
  implicitHeight: 32 * pad
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

    Item {
      id: headings
      x: win.pad
      y: head.y + head.height + win.pad
      height: Theme.bodyLine

      Text {
        height: parent.height
        verticalAlignment: Text.AlignVCenter
        text: "You"
        color: Theme.popupsText
        font.family: Theme.family
        font.pixelSize: Theme.bodySmall
        font.weight: Font.DemiBold
      }

      Row {
        x: 14 * win.pad
        spacing: Theme.controlGap

        Text {
          height: Theme.bodyLine
          verticalAlignment: Text.AlignVCenter
          text: "Kestrel"
          color: Theme.accent
          font.family: Theme.family
          font.pixelSize: Theme.bodySmall
          font.weight: Font.DemiBold
        }

        Text {
          visible: win.turns.some(t => t.speaking)
          height: Theme.bodyLine
          verticalAlignment: Text.AlignVCenter
          text: "Speaking"
          color: Theme.popupsText
          font.family: Theme.family
          font.pixelSize: Theme.bodySmall
        }
      }
    }

    Transcript {
      id: transcript
      x: win.pad
      y: headings.y + headings.height + Theme.controlGap
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
            : "Say something, or type below.\nYour words appear on the left. Kestrel replies on the right."
          lineHeight: Theme.bodyLine
          lineHeightMode: Text.FixedHeight
          color: Theme.popupsText
          font.family: Theme.family
          font.pixelSize: Theme.body
        }

        Repeater {
          model: win.rows

          Item {
            required property var modelData
            width: transcript.contentWidth
            height: Math.max(you.height, kestrel.height)

            Message {
              id: you
              width: 12 * win.pad
              turn: modelData.you
              showLabel: false
            }

            Message {
              id: kestrel
              x: 14 * win.pad
              width: 26 * win.pad
              visible: !!modelData.kestrel
              turn: modelData.kestrel || ({})
              showLabel: false
            }
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
      width: parent.width - 2 * win.pad - win.sendWidth - Theme.controlGap
    }

    SendButton {
      x: field.x + field.width + Theme.controlGap
      y: field.y
      height: field.height
      enabled: field.text.length > 0 && win.blocked === ""
    }

    Text {
      x: win.pad
      y: field.y + field.height + Theme.labelGap
      height: Theme.bodyLine
      verticalAlignment: Text.AlignVCenter
      text: (win.blocked ? win.blocked + "  " : "") + "Shift+Enter: new line. Move: Super + left drag."
      color: Theme.popupsText
      font.family: Theme.family
      font.pixelSize: Theme.caption
    }
  }
}
