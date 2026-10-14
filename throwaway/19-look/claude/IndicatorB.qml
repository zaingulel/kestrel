import QtQuick
import QtQuick.Shapes

// Indicator B, "mark and word": a diamond, and during a conversation a lowercase
// word 6 px to its right. The word grows leftwards because the slot is anchored
// to the clock on its right.
Item {
  id: root

  property string kind: "idle"
  readonly property string word: Theme.words[kind] || ""

  implicitWidth: Math.max(Theme.slotWidth, content.width + 10)
  implicitHeight: Theme.barHeight

  HoverHandler { id: hover }
  Tooltip { target: root; hovered: hover.hovered; text: Theme.tips[root.kind] }

  component Arc: Shape {
    id: arc
    required property real radius
    width: 20
    height: 30
    preferredRendererType: Shape.CurveRenderer
    ShapePath {
      strokeColor: Theme.text
      strokeWidth: 1
      fillColor: "transparent"
      PathAngleArc { centerX: 5; centerY: 15; radiusX: arc.radius; radiusY: arc.radius; startAngle: -40; sweepAngle: 80 }
    }
  }

  Row {
    id: content
    anchors.centerIn: parent
    spacing: 6

    Item {
      width: 10
      height: Theme.barHeight

      StateLayer {
        name: "not-running"; current: root.kind
        opacity: (root.kind === name ? 1 : 0) * 0.45
        Diamond { y: 10 }
        Rectangle { x: 4.5; y: 8.5; width: 1; height: 13; rotation: 45; color: Theme.text; antialiasing: true }
      }

      StateLayer {
        name: "idle"; current: root.kind
        opacity: (root.kind === name ? 1 : 0) * 0.45
        Diamond { y: 10 }
      }

      StateLayer {
        name: "listening"; current: root.kind
        Diamond { y: 10; fill: "full" }
      }

      StateLayer {
        id: thinking
        name: "thinking"; current: root.kind
        property bool leftHalf: true
        Timer {
          interval: 500; repeat: true; running: thinking.visible
          onTriggered: thinking.leftHalf = !thinking.leftHalf
        }
        Diamond { y: 10; fill: thinking.leftHalf ? "left" : "right" }
      }

      StateLayer {
        id: speaking
        name: "speaking"; current: root.kind
        Diamond { y: 10; fill: "full" }
        Arc { id: arc1; radius: 7 }
        Arc { id: arc2; radius: 9.5 }
        SequentialAnimation {
          loops: Animation.Infinite; running: speaking.visible
          PropertyAction { target: arc1; property: "opacity"; value: 0 }
          PropertyAction { target: arc2; property: "opacity"; value: 0 }
          NumberAnimation { target: arc1; property: "opacity"; to: 1; duration: 200 }
          NumberAnimation { target: arc2; property: "opacity"; to: 1; duration: 200 }
          PauseAnimation { duration: 200 }
        }
      }

      StateLayer {
        name: "trouble"; current: root.kind
        Diamond { y: 10; fill: "full"; color: Theme.active }
      }
    }

    Text {
      visible: root.word !== ""
      anchors.verticalCenter: parent.verticalCenter
      text: root.word
      textFormat: Text.PlainText
      color: root.kind === "trouble" ? Theme.active : Theme.text
      font.family: Theme.family
      font.pixelSize: Theme.caption
    }
  }
}
