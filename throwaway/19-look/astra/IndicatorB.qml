import QtQuick

// Indicator B: a fixed 224 x 30 readout, a 96 px name cell and a 128 px state cell.
Item {
  id: root

  property string kind: "idle"
  signal activated()

  readonly property string tip: Theme.tips[kind] + " Open conversation."
  readonly property int nameCell: 3 * Theme.iconSlot
  readonly property int stateCell: 4 * Theme.iconSlot

  width: nameCell + stateCell
  height: Theme.barHeight
  activeFocusOnTab: true
  Accessible.role: Accessible.Button
  Accessible.name: tip

  Keys.onReturnPressed: root.activated()
  Keys.onEnterPressed: root.activated()
  Keys.onSpacePressed: root.activated()

  Text {
    width: root.nameCell
    height: parent.height
    horizontalAlignment: Text.AlignHCenter
    verticalAlignment: Text.AlignVCenter
    text: "Kestrel"
    color: Theme.barText
    font.family: Theme.family
    font.pixelSize: Theme.body
  }

  Rectangle {
    x: root.nameCell
    anchors.verticalCenter: parent.verticalCenter
    width: Theme.hairline
    height: Theme.body
    color: Theme.barText
  }

  Text {
    x: root.nameCell + Theme.md
    width: root.stateCell - 2 * Theme.md
    height: parent.height
    verticalAlignment: Text.AlignVCenter
    text: Theme.words[root.kind]
    color: Theme.barColor(root.kind)
    font.family: Theme.family
    font.pixelSize: Theme.body
  }

  HoverRule { visible: hover.hovered; color: Theme.barText }
  FocusRing {}

  HoverHandler { id: hover }
  TapHandler { onTapped: root.activated() }

  Tooltip { target: root; text: root.tip; shown: hover.hovered }
}
