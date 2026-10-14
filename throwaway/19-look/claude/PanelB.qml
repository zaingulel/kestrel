import Quickshell
import QtQuick

// Panel B, "caption": the present exchange large, the past a PageUp away.
// 720 by 200 px. Hyprland draws the 2 px border, so none is drawn here.
FloatingWindow {
  id: win

  property var turns: []
  signal closeRequested()

  // Each exchange is the owner's turn and Kestrel's reply after it.
  readonly property var exchanges: {
    var out = []
    for (var i = 0; i + 1 < turns.length; i += 2)
      out.push({ you: turns[i].text, reply: turns[i + 1].text, sources: turns[i + 1].sources })
    return out
  }
  property int stepsBack: 0
  readonly property var current: exchanges.length > 0 ? exchanges[exchanges.length - 1 - stepsBack] : null

  implicitWidth: 720
  implicitHeight: 200
  minimumSize: Qt.size(720, 200)
  maximumSize: Qt.size(720, 200)
  color: Theme.background
  title: "Kestrel panel B (caption)"

  // Keyboard order: typing field, source links, close button.
  function wireFocus() {
    var chain = [field.input]
    for (var j = 0; j < sourceRepeater.count; j++) chain.push(sourceRepeater.itemAt(j))
    chain.push(closeButton)
    for (var k = 0; k < chain.length; k++) {
      var next = chain[(k + 1) % chain.length]
      chain[k].KeyNavigation.tab = next
      next.KeyNavigation.backtab = chain[k]
    }
  }

  Component.onCompleted: Qt.callLater(wireFocus)
  onTurnsChanged: { stepsBack = 0; Qt.callLater(wireFocus) }
  onStepsBackChanged: Qt.callLater(wireFocus)
  onVisibleChanged: if (visible) Qt.callLater(field.takeFocus)

  Item {
    anchors.fill: parent

    Text {
      visible: win.current !== null
      x: 12
      height: 30
      verticalAlignment: Text.AlignVCenter
      text: win.current ? "you   " + win.current.you : ""
      textFormat: Text.PlainText
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

    Column {
      visible: win.current !== null
      x: 24
      y: 44
      width: parent.width - 48

      Text {
        width: parent.width
        text: win.current ? win.current.reply : ""
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        maximumLineCount: 3
        elide: Text.ElideRight
        color: Theme.text
        font.family: Theme.family
        font.pixelSize: Theme.heading
      }

      Repeater {
        id: sourceRepeater
        model: win.current ? win.current.sources : []

        SourceLink {
          required property var modelData
          required property int index
          number: index + 1
          site: modelData.site
          title: modelData.title
        }
      }
    }

    Text {
      visible: win.current === null
      x: 24
      y: 44
      width: parent.width - 48
      wrapMode: Text.Wrap
      text: "Nothing said yet. Press the shortcut and speak, or type below."
      color: Theme.lightForeground
      font.family: Theme.family
      font.pixelSize: Theme.heading
    }

    TypingField {
      id: field
      y: parent.height - 34
      width: parent.width * 0.6
      onKeyPressed: function(event) {
        if (event.key === Qt.Key_PageUp) win.stepsBack = Math.min(win.stepsBack + 1, win.exchanges.length - 1)
        else if (event.key === Qt.Key_PageDown) win.stepsBack = Math.max(win.stepsBack - 1, 0)
      }
    }

    Text {
      visible: win.current !== null
      anchors.right: parent.right
      anchors.rightMargin: 12
      y: parent.height - 34
      height: 34
      verticalAlignment: Text.AlignVCenter
      text: "earlier (PageUp)  " + (win.exchanges.length - win.stepsBack) + "/" + win.exchanges.length
      color: Theme.lightForeground
      font.family: Theme.family
      font.pixelSize: Theme.caption
    }
  }
}
