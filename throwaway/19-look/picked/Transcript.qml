import QtQuick

// The scrolling transcript: follows new content only while at the bottom, keyboard scrolling when
// focused, a 32 px gutter holding a 25 px scrollbar track with a 5 px thumb of at least 33 px.
Item {
  id: root

  default property alias content: inner.data
  readonly property int contentWidth: width - Theme.iconSlot
  property bool following: true

  function toEnd() { flick.contentY = Math.max(0, flick.contentHeight - flick.height) }

  activeFocusOnTab: true
  Accessible.role: Accessible.StaticText
  Accessible.name: "Transcript"

  Keys.onPressed: function(event) {
    const max = Math.max(0, flick.contentHeight - flick.height)
    let y = flick.contentY
    if (event.key === Qt.Key_Up) y -= Theme.bodyLine
    else if (event.key === Qt.Key_Down) y += Theme.bodyLine
    else if (event.key === Qt.Key_PageUp) y -= flick.height - Theme.bodyLine
    else if (event.key === Qt.Key_PageDown) y += flick.height - Theme.bodyLine
    else if (event.key === Qt.Key_Home) y = 0
    else if (event.key === Qt.Key_End) y = max
    else return
    flick.contentY = Math.max(0, Math.min(max, y))
    event.accepted = true
  }

  Flickable {
    id: flick
    width: root.contentWidth
    height: parent.height
    clip: true
    contentWidth: width
    contentHeight: inner.height
    boundsBehavior: Flickable.StopAtBounds

    onContentHeightChanged: if (root.following) root.toEnd(); else returnToBounds()
    onContentYChanged: root.following = contentY >= contentHeight - height - 1

    Item {
      id: inner
      width: flick.width
      height: childrenRect.height
    }
  }

  Item {
    id: track
    x: root.width - Theme.slotWidth
    width: Theme.slotWidth
    height: root.height
    visible: flick.contentHeight > flick.height

    Rectangle {
      id: thumb
      x: (track.width - width) / 2
      width: Theme.labelGap
      height: Math.max(Theme.controlHeight, track.height * flick.visibleArea.heightRatio)
      y: (track.height - height) * Math.max(0, Math.min(1, flick.contentY / Math.max(1, flick.contentHeight - flick.height)))
      color: Theme.popupsText
    }

    MouseArea {
      anchors.fill: parent

      function scrubTo(mouseY) {
        const ratio = Math.max(0, Math.min(1, (mouseY - thumb.height / 2) / (track.height - thumb.height)))
        flick.contentY = ratio * (flick.contentHeight - flick.height)
      }

      onPressed: function(mouse) { scrubTo(mouse.y) }
      onPositionChanged: function(mouse) { if (pressed) scrubTo(mouse.y) }
    }
  }

  FocusRing {}
}
