import Quickshell
import QtQuick

// Tooltip under its target: at most 24 padding units wide, caption text, 2 px border, no motion.
PopupWindow {
  id: root

  required property Item target
  property string text: ""
  property bool shown: false

  readonly property int pad: Theme.popupPadding + Theme.focusStroke
  readonly property int textWidth: Math.min(Math.ceil(metrics.width) + 1, 24 * Theme.popupPadding - 2 * pad)

  visible: shown
  color: "transparent"
  implicitWidth: textWidth + 2 * pad
  implicitHeight: label.height + 2 * pad

  anchor.item: target
  anchor.edges: Edges.Bottom
  anchor.gravity: Edges.Bottom
  anchor.margins.top: Theme.labelGap

  TextMetrics {
    id: metrics
    text: root.text
    font.family: Theme.family
    font.pixelSize: Theme.caption
  }

  Rectangle {
    anchors.fill: parent
    color: Theme.tooltipBackground
    border.width: Theme.focusStroke
    border.color: Theme.tooltipBorder

    Text {
      id: label
      x: root.pad
      y: root.pad
      width: root.textWidth
      text: root.text
      textFormat: Text.PlainText
      wrapMode: Text.WrapAtWordBoundaryOrAnywhere
      lineHeight: Theme.captionLine
      lineHeightMode: Text.FixedHeight
      color: Theme.tooltipText
      font.family: Theme.family
      font.pixelSize: Theme.caption
    }
  }
}
