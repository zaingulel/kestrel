import QtQuick

// Indicator A, "three marks": the marks centred in the 25 px bar slot. The whole slot is the click target.
Item {
  id: root

  property string kind: "idle"

  signal activated()

  implicitWidth: Theme.slotWidth
  implicitHeight: Theme.barHeight

  HoverHandler { id: hover }
  TapHandler { onTapped: root.activated() }
  Tooltip { target: root; shown: hover.hovered; text: Theme.tips[root.kind] }

  Marks {
    anchors.fill: parent
    kind: root.kind
    ink: Theme.barText
    restingInk: Theme.barTextResting
    troubleInk: Theme.barActive
  }
}
