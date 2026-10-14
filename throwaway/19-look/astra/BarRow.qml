import Quickshell
import QtQuick

// One mock bar: workspace numbers at the left, Indicator B after them, the clock in the exact
// centre with Indicator A immediately before it, and in sheet mode the state name at the far right.
Item {
  id: root

  property string which: "a"
  property string kind: "idle"
  property string label: ""
  signal activated()

  height: Theme.barHeight

  SystemClock { id: clock }

  Row {
    id: spaces
    x: Theme.controlGap
    anchors.verticalCenter: parent.verticalCenter
    spacing: Theme.controlGap

    Repeater {
      model: ["1", "2", "3", "4"]

      Text {
        required property string modelData
        text: modelData
        color: Theme.barText
        font.family: Theme.family
        font.pixelSize: Theme.caption
      }
    }
  }

  Text {
    id: clockText
    anchors.centerIn: parent
    text: Qt.formatDateTime(clock.date, "ddd d MMM HH:mm")
    color: Theme.barText
    font.family: Theme.family
    font.pixelSize: Theme.body
  }

  IndicatorA {
    visible: root.which === "a"
    anchors.right: clockText.left
    kind: root.kind
    onActivated: root.activated()
  }

  IndicatorB {
    visible: root.which === "b"
    anchors.left: spaces.right
    anchors.leftMargin: Theme.popupPadding
    kind: root.kind
    onActivated: root.activated()
  }

  Text {
    anchors.right: parent.right
    anchors.rightMargin: Theme.controlGap
    anchors.verticalCenter: parent.verticalCenter
    text: root.label
    color: Theme.barText
    font.family: Theme.family
    font.pixelSize: Theme.caption
  }
}
