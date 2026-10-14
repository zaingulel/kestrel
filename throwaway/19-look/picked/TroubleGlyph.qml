import QtQuick

// The trouble triangle on a 19 px canvas, drawn in the panel's accent colour.
Canvas {
  id: root

  property color strokeColor: Theme.accent

  width: Theme.iconCanvas
  height: Theme.iconCanvas

  onStrokeColorChanged: requestPaint()

  onPaint: {
    const c = width
    const ctx = getContext("2d")
    ctx.clearRect(0, 0, width, height)
    ctx.lineWidth = Theme.focusStroke
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    ctx.strokeStyle = strokeColor
    ctx.fillStyle = strokeColor
    ctx.beginPath()
    ctx.moveTo(c / 2, c / 6)
    ctx.lineTo(5 * c / 6, 5 * c / 6)
    ctx.lineTo(c / 6, 5 * c / 6)
    ctx.closePath()
    ctx.moveTo(c / 2, 5 * c / 12)
    ctx.lineTo(c / 2, 7 * c / 12)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(c / 2, 3 * c / 4, c / 24, 0, 2 * Math.PI)
    ctx.fill()
  }
}
