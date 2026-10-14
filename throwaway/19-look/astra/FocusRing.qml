import QtQuick

// Inset keyboard-focus outline on the parent item.
Rectangle {
  anchors.fill: parent
  visible: parent.activeFocus
  color: "transparent"
  border.width: Theme.focusStroke
  border.color: Theme.popupsBorder
}
