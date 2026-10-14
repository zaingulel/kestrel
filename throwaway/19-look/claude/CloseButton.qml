import QtQuick

// 26 by 26 px close button drawing a 10 px cross.
Item {
  id: root

  signal clicked()

  width: 26
  height: 26
  activeFocusOnTab: true

  Keys.onReturnPressed: root.clicked()
  Keys.onSpacePressed: root.clicked()

  Repeater {
    model: [45, -45]
    Rectangle {
      required property int modelData
      anchors.centerIn: parent
      width: 14
      height: 1
      rotation: modelData
      color: Theme.text
      antialiasing: true
    }
  }

  MouseArea {
    anchors.fill: parent
    onClicked: root.clicked()
  }

  Rectangle {
    anchors.fill: parent
    anchors.margins: -2
    color: "transparent"
    border.width: 1
    border.color: Theme.accent
    visible: root.activeFocus
  }
}
