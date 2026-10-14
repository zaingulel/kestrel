import QtQuick

// Panel title with the close target, then the persistent status line: the state's marks (the bar indicator's
// drawing, base line on the text baseline) and the sentence.
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

    Marks {
      // The drawing sits 5 px inside its frame and is 15 px wide; shift the frame so the marks start at the row's edge.
      x: -5
      y: sentence.baselineOffset - markBase
      kind: root.stateName
      ink: Theme.popupsText
      restingInk: Qt.alpha(Theme.popupsText, 0.6)
      troubleInk: Theme.barActive
      Accessible.ignored: true
    }

    Text {
      id: sentence
      // After the marks' 15 px drawing, one labelGap.
      x: 15 + Theme.labelGap
      height: parent.height
      verticalAlignment: Text.AlignVCenter
      text: Theme.statuses[root.stateName]
      color: Theme.popupsText
      font.family: Theme.family
      font.pixelSize: Theme.bodySmall
    }
  }
}
