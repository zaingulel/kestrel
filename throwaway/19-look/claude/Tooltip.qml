import Quickshell
import QtQuick

// Bar-style tooltip: 6 px under its target, shown 400 ms after the pointer arrives.
PopupWindow {
  id: root

  required property Item target
  property bool hovered: false
  property string text: ""
  property bool armed: false

  visible: hovered && armed
  color: "transparent"
  implicitWidth: Math.ceil(label.implicitWidth + 20)
  implicitHeight: Math.ceil(label.implicitHeight + 14)

  anchor.item: target
  anchor.edges: Edges.Bottom
  anchor.gravity: Edges.Bottom
  anchor.margins.top: 6

  onHoveredChanged: if (!hovered) armed = false

  Timer {
    interval: 400
    running: root.hovered
    onTriggered: root.armed = true
  }

  Rectangle {
    anchors.fill: parent
    color: Theme.tooltipBackground
    border.width: 1
    border.color: Theme.text

    Text {
      id: label
      anchors.centerIn: parent
      text: root.text
      textFormat: Text.PlainText
      color: Theme.text
      font.family: Theme.family
      font.pixelSize: Theme.body
    }
  }
}
