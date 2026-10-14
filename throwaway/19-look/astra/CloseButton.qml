import QtQuick

// 33 x 33 close target with a cross on a centred 19 px canvas.
Item {
  id: root

  signal clicked()

  width: Theme.controlHeight
  height: Theme.controlHeight
  activeFocusOnTab: true
  Accessible.role: Accessible.Button
  Accessible.name: "Close conversation panel"

  Keys.onReturnPressed: root.clicked()
  Keys.onEnterPressed: root.clicked()
  Keys.onSpacePressed: root.clicked()

  Canvas {
    anchors.centerIn: parent
    width: Theme.iconCanvas
    height: Theme.iconCanvas

    onPaint: {
      const c = width
      const ctx = getContext("2d")
      ctx.lineWidth = Theme.focusStroke
      ctx.lineCap = "round"
      ctx.strokeStyle = Theme.popupsText
      ctx.beginPath()
      ctx.moveTo(c / 4, c / 4)
      ctx.lineTo(3 * c / 4, 3 * c / 4)
      ctx.moveTo(3 * c / 4, c / 4)
      ctx.lineTo(c / 4, 3 * c / 4)
      ctx.stroke()
    }
  }

  HoverRule { visible: hover.hovered }
  FocusRing {}

  HoverHandler { id: hover }
  TapHandler { onTapped: root.clicked() }
}
