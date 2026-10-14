import QtQuick

// Indicator A: one 32 x 30 target holding a drawn signal glyph.
Item {
  id: root

  property string kind: "idle"
  signal activated()

  readonly property string tip: Theme.tips[kind] + " Open conversation."

  width: Theme.iconSlot
  height: Theme.barHeight
  activeFocusOnTab: true
  Accessible.role: Accessible.Button
  Accessible.name: tip

  Keys.onReturnPressed: root.activated()
  Keys.onEnterPressed: root.activated()
  Keys.onSpacePressed: root.activated()

  SignalGlyph {
    anchors.centerIn: parent
    kind: root.kind
    strokeColor: Theme.barColor(root.kind)
  }

  HoverRule { visible: hover.hovered; color: Theme.barText }
  FocusRing {}

  HoverHandler { id: hover }
  TapHandler { onTapped: root.activated() }

  Tooltip { target: root; text: root.tip; shown: hover.hovered }
}
