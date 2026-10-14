import QtQuick

// One turn: speaker label (with "Speaking" while a reply is in progress), the text, the source row
// and, after a failed reply, the incomplete-reply line. Panel B hides the label (its columns have headings).
Column {
  id: root

  property var turn: ({})
  property bool showLabel: true

  spacing: Theme.labelGap

  Row {
    visible: root.showLabel
    spacing: Theme.controlGap

    Text {
      height: Theme.bodyLine
      verticalAlignment: Text.AlignVCenter
      text: root.turn.who === "you" ? "You" : "Kestrel"
      color: root.turn.who === "you" ? Theme.popupsText : Theme.accent
      font.family: Theme.family
      font.pixelSize: Theme.bodySmall
      font.weight: Font.DemiBold
    }

    Text {
      visible: !!root.turn.speaking
      height: Theme.bodyLine
      verticalAlignment: Text.AlignVCenter
      text: "Speaking"
      color: Theme.popupsText
      font.family: Theme.family
      font.pixelSize: Theme.bodySmall
    }
  }

  Text {
    width: root.width
    text: root.turn.text || ""
    textFormat: Text.PlainText
    wrapMode: Text.WrapAtWordBoundaryOrAnywhere
    lineHeight: Theme.bodyLine
    lineHeightMode: Text.FixedHeight
    color: Theme.popupsText
    font.family: Theme.family
    font.pixelSize: Theme.body
  }

  SourceLink {
    visible: !!root.turn.sourceLabel
    label: root.turn.sourceLabel || ""
    url: root.turn.sourceUrl || ""
    maxWidth: root.width
  }

  Item {
    visible: !!root.turn.incomplete
    width: root.width
    height: incomplete.height

    TroubleGlyph {
      id: glyph
      anchors.verticalCenter: parent.verticalCenter
      strokeColor: Theme.accent
    }

    Text {
      id: incomplete
      x: glyph.width + Theme.controlGap
      width: parent.width - x
      text: "Reply incomplete. Check Kestrel's local log before reconnecting."
      textFormat: Text.PlainText
      wrapMode: Text.WrapAtWordBoundaryOrAnywhere
      lineHeight: Theme.bodyLine
      lineHeightMode: Text.FixedHeight
      color: Theme.popupsText
      font.family: Theme.family
      font.pixelSize: Theme.body
    }
  }
}
