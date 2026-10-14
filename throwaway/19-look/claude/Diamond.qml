import QtQuick
import QtQuick.Shapes

// A 7 px diamond in a 10 by 10 box; `fill` is none, full, left or right.
Shape {
  id: root

  property color color: Theme.text
  property string fill: "none"

  width: 10
  height: 10
  preferredRendererType: Shape.CurveRenderer

  ShapePath {
    strokeWidth: -1
    fillColor: root.fill === "full" || root.fill === "left" ? root.color : "transparent"
    startX: 5; startY: 1
    PathLine { x: 1; y: 5 }
    PathLine { x: 5; y: 9 }
  }

  ShapePath {
    strokeWidth: -1
    fillColor: root.fill === "full" || root.fill === "right" ? root.color : "transparent"
    startX: 5; startY: 1
    PathLine { x: 9; y: 5 }
    PathLine { x: 5; y: 9 }
  }

  ShapePath {
    strokeColor: root.color
    strokeWidth: 1
    fillColor: "transparent"
    startX: 5; startY: 1
    PathLine { x: 9; y: 5 }
    PathLine { x: 5; y: 9 }
    PathLine { x: 1; y: 5 }
    PathLine { x: 5; y: 1 }
  }
}
