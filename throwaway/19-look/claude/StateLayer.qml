import QtQuick

// One state's drawing; fades in when `current` is its `name`, 120 ms ease-out.
Item {
  property string name
  property string current

  anchors.fill: parent
  opacity: current === name ? 1 : 0
  visible: opacity > 0

  Behavior on opacity { NumberAnimation { duration: 120; easing.type: Easing.OutCubic } }
}
