import Quickshell
import QtQuick

// Panel A, "ledger": a two-column record, 440 by 560 px. Hyprland draws the
// 2 px border, so none is drawn here.
FloatingWindow {
  id: win

  property var turns: []
  property string stateWord: ""
  signal closeRequested()

  implicitWidth: 440
  implicitHeight: 560
  minimumSize: Qt.size(440, 560)
  maximumSize: Qt.size(440, 560)
  color: Theme.background
  title: "Kestrel panel A (ledger)"

  // Keyboard order: typing field, source links newest to oldest, close button.
  function wireFocus() {
    var chain = [field.input]
    for (var i = turnRepeater.count - 1; i >= 0; i--) {
      var links = turnRepeater.itemAt(i).links()
      for (var j = 0; j < links.length; j++) chain.push(links[j])
    }
    chain.push(closeButton)
    for (var k = 0; k < chain.length; k++) {
      var next = chain[(k + 1) % chain.length]
      chain[k].KeyNavigation.tab = next
      next.KeyNavigation.backtab = chain[k]
    }
  }

  function scrollBy(dy) {
    record.contentY = Math.max(0, Math.min(record.contentHeight - record.height, record.contentY + dy))
  }

  Component.onCompleted: Qt.callLater(wireFocus)
  onTurnsChanged: Qt.callLater(wireFocus)
  onVisibleChanged: if (visible) Qt.callLater(field.takeFocus)

  Item {
    anchors.fill: parent

    Text {
      x: 12
      height: 30
      verticalAlignment: Text.AlignVCenter
      text: "kestrel"
      color: Theme.text
      font.family: Theme.family
      font.pixelSize: Theme.body
    }

    Text {
      anchors.right: closeButton.left
      anchors.rightMargin: 8
      height: 30
      verticalAlignment: Text.AlignVCenter
      text: win.stateWord
      color: Theme.lightForeground
      font.family: Theme.family
      font.pixelSize: Theme.caption
    }

    CloseButton {
      id: closeButton
      anchors.right: parent.right
      anchors.rightMargin: 4
      y: 2
      onClicked: win.closeRequested()
    }

    Rectangle { y: 30; width: parent.width; height: 1; color: Theme.muted }

    Flickable {
      id: record
      y: 31
      width: parent.width
      height: parent.height - 66
      clip: true
      contentWidth: width
      contentHeight: turnColumn.height + 24
      boundsBehavior: Flickable.StopAtBounds

      Column {
        id: turnColumn
        x: 12
        y: 12
        width: record.width - 24
        spacing: 12

        Repeater {
          id: turnRepeater
          model: win.turns

          Item {
            id: turn
            required property var modelData
            width: turnColumn.width
            height: Math.max(label.implicitHeight, body.height)

            function links() {
              var out = []
              for (var j = 0; j < sourceRepeater.count; j++) out.push(sourceRepeater.itemAt(j))
              return out
            }

            Text {
              id: label
              y: 2
              text: turn.modelData.who
              color: Theme.lightForeground
              font.family: Theme.family
              font.pixelSize: Theme.caption
            }

            Rectangle {
              visible: turn.modelData.who === "kestrel"
              x: 62
              width: 2
              height: turn.height
              color: Theme.accent
            }

            Column {
              id: body
              x: 72
              width: turn.width - 72

              Text {
                width: parent.width
                text: turn.modelData.text
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                lineHeight: 1.4
                lineHeightMode: Text.ProportionalHeight
                color: Theme.text
                font.family: Theme.family
                font.pixelSize: Theme.body
              }

              Repeater {
                id: sourceRepeater
                model: turn.modelData.sources

                SourceLink {
                  required property var modelData
                  required property int index
                  number: index + 1
                  site: modelData.site
                  title: modelData.title
                }
              }
            }
          }
        }
      }
    }

    Text {
      visible: win.turns.length === 0
      anchors.centerIn: record
      width: record.width - 48
      horizontalAlignment: Text.AlignHCenter
      wrapMode: Text.Wrap
      text: "Nothing said yet. Press the shortcut and speak, or type below."
      color: Theme.lightForeground
      font.family: Theme.family
      font.pixelSize: Theme.body
    }

    Rectangle { y: parent.height - 35; width: parent.width; height: 1; color: Theme.muted }

    TypingField {
      id: field
      y: parent.height - 34
      width: parent.width
      onKeyPressed: function(event) {
        if (field.input.text !== "") return
        if (event.key === Qt.Key_Up) win.scrollBy(-40)
        else if (event.key === Qt.Key_Down) win.scrollBy(40)
        else if (event.key === Qt.Key_PageUp) win.scrollBy(-record.height)
        else if (event.key === Qt.Key_PageDown) win.scrollBy(record.height)
      }
    }
  }
}
