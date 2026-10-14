import QtQuick

// A provenance link: underlined accent text, at least 33 px square, wraps instead of truncating.
// Enter and click do nothing in the prototype; the destination shows in a tooltip.
Item {
  id: root

  property string label: ""
  property string url: ""
  property int maxWidth: 0

  width: Math.max(Theme.controlHeight, Math.min(Math.ceil(metrics.width) + 1, maxWidth))
  height: Math.max(Theme.controlHeight, text.height)
  activeFocusOnTab: true
  Accessible.role: Accessible.Link
  Accessible.name: label

  TextMetrics {
    id: metrics
    text: root.label
    font.family: Theme.family
    font.pixelSize: Theme.body
  }

  Text {
    id: text
    width: parent.width
    anchors.verticalCenter: parent.verticalCenter
    text: root.label
    textFormat: Text.PlainText
    wrapMode: Text.WrapAtWordBoundaryOrAnywhere
    lineHeight: Theme.bodyLine
    lineHeightMode: Text.FixedHeight
    color: Theme.accent
    font.family: Theme.family
    font.pixelSize: Theme.body
    font.underline: true
  }

  HoverRule { visible: hover.hovered }
  FocusRing {}

  HoverHandler { id: hover }

  Tooltip { target: root; text: root.url; shown: hover.hovered }
}
