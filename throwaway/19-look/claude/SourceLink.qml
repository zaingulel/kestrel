import QtQuick

// A source line: a number, the site name in accent underlined, the page title.
// Focusable; the prototype opens nothing.
Item {
  id: root

  property int number: 1
  property string site
  property string title

  activeFocusOnTab: true
  implicitWidth: row.implicitWidth
  implicitHeight: 17

  Row {
    id: row
    spacing: 14

    Text {
      height: root.height
      verticalAlignment: Text.AlignVCenter
      text: root.number
      color: Theme.lightForeground
      font.family: Theme.family
      font.pixelSize: Theme.caption
    }
    Text {
      height: root.height
      verticalAlignment: Text.AlignVCenter
      text: root.site
      textFormat: Text.PlainText
      color: Theme.accent
      font.family: Theme.family
      font.pixelSize: Theme.caption
      font.underline: true
    }
    Text {
      height: root.height
      verticalAlignment: Text.AlignVCenter
      text: root.title
      textFormat: Text.PlainText
      color: Theme.lightForeground
      font.family: Theme.family
      font.pixelSize: Theme.caption
    }
  }

  MouseArea {
    anchors.fill: parent
    onClicked: root.forceActiveFocus()
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
