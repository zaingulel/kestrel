import QtQuick

// Bottom rule drawn on the parent item while the pointer is over it; the caller sets visible.
Rectangle {
  anchors { left: parent.left; right: parent.right; bottom: parent.bottom }
  height: Theme.focusStroke
  color: Theme.popupsText
}
