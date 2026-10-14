import Quickshell
import QtQuick

// One mock bar: workspace numbers at the left, the clock in the exact centre,
// the indicator immediately left of the clock, and in sheet mode the state name
// at the far right.
Item {
  id: root

  property string which: "a"
  property string kind: "idle"
  property string label: ""

  height: Theme.barHeight

  SystemClock { id: clock }

  Text {
    anchors.left: parent.left
    anchors.leftMargin: 9
    anchors.verticalCenter: parent.verticalCenter
    text: "1  2  3  4"
    color: Theme.text
    font.family: Theme.family
    font.pixelSize: Theme.caption
  }

  Text {
    id: clockText
    anchors.centerIn: parent
    text: Qt.formatDateTime(clock.date, "ddd d MMM HH:mm")
    color: Theme.text
    font.family: Theme.family
    font.pixelSize: Theme.body
  }

  IndicatorA {
    visible: root.which === "a"
    anchors.right: clockText.left
    kind: root.kind
  }

  IndicatorB {
    visible: root.which === "b"
    anchors.right: clockText.left
    kind: root.kind
  }

  Text {
    anchors.right: parent.right
    anchors.rightMargin: 9
    anchors.verticalCenter: parent.verticalCenter
    text: root.label
    color: Theme.lightForeground
    font.family: Theme.family
    font.pixelSize: Theme.caption
  }
}
