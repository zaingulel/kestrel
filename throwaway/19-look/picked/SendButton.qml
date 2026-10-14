import QtQuick

// Send does nothing in the prototype. Disabled it keeps its readable text and only leaves the Tab order.
Rectangle {
  id: root

  width: 3 * Theme.controlHeight
  color: Theme.popupsBackground
  border.width: Theme.hairline
  border.color: Theme.popupsText
  activeFocusOnTab: true
  Accessible.role: Accessible.Button
  Accessible.name: "Send"

  Text {
    anchors.centerIn: parent
    text: "Send"
    color: Theme.popupsText
    font.family: Theme.family
    font.pixelSize: Theme.body
  }

  HoverRule { visible: hover.hovered && root.enabled }
  FocusRing {}

  HoverHandler { id: hover }
}
