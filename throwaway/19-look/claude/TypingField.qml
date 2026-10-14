import QtQuick

// The typing field: accepts text and focus, sends nothing. Key presses are
// passed on through keyPressed so the panel can scroll or step.
Rectangle {
  id: root

  property alias input: edit
  signal keyPressed(var event)

  function takeFocus() { edit.forceActiveFocus() }

  height: 34
  color: Theme.lighterBackground
  border.width: 1
  border.color: Theme.controlBorder

  Text {
    x: 12
    anchors.verticalCenter: parent.verticalCenter
    text: ">"
    color: Theme.lightForeground
    font.family: Theme.family
    font.pixelSize: Theme.body
  }

  TextInput {
    id: edit
    x: 30
    width: parent.width - 42
    anchors.verticalCenter: parent.verticalCenter
    activeFocusOnTab: true
    clip: true
    color: Theme.text
    selectionColor: Theme.accent
    font.family: Theme.family
    font.pixelSize: Theme.body
    Keys.onPressed: function(event) { root.keyPressed(event) }

    Text {
      visible: edit.text === ""
      text: "type a message"
      color: Theme.lightForeground
      font: edit.font
    }
  }

  Rectangle {
    anchors.fill: parent
    anchors.margins: -2
    color: "transparent"
    border.width: 1
    border.color: Theme.accent
    visible: edit.activeFocus
  }
}
