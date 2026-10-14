import QtQuick

// Panel title with the close target, then the persistent status line (with the trouble triangle).
Item {
  id: root

  property string stateName: "idle"
  signal closeRequested()

  height: Theme.controlHeight + Theme.labelGap + Theme.bodyLine

  Text {
    height: Theme.controlHeight
    verticalAlignment: Text.AlignVCenter
    text: "Kestrel"
    color: Theme.popupsText
    font.family: Theme.family
    font.pixelSize: Theme.title
    font.weight: Font.DemiBold
  }

  CloseButton {
    anchors.right: parent.right
    onClicked: root.closeRequested()
  }

  Item {
    y: Theme.controlHeight + Theme.labelGap
    width: parent.width
    height: Theme.bodyLine

    TroubleGlyph {
      id: glyph
      visible: root.stateName === "trouble"
      anchors.verticalCenter: parent.verticalCenter
      strokeColor: Theme.accent
    }

    Text {
      x: glyph.visible ? glyph.width + Theme.controlGap : 0
      height: parent.height
      verticalAlignment: Text.AlignVCenter
      text: Theme.statuses[root.stateName]
      color: Theme.popupsText
      font.family: Theme.family
      font.pixelSize: Theme.bodySmall
    }
  }
}
