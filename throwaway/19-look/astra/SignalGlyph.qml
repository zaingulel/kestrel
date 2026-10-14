import QtQuick

// The six drawings of Indicator A on a 19 px canvas; the panels reuse "trouble" in the accent colour.
Canvas {
  id: root

  property string kind: "idle"
  property color strokeColor: Theme.barText

  width: Theme.iconCanvas
  height: Theme.iconCanvas

  onKindChanged: requestPaint()
  onStrokeColorChanged: requestPaint()

  function dot(ctx, x, y, r) {
    ctx.beginPath()
    ctx.arc(x, y, r, 0, 2 * Math.PI)
    ctx.fill()
  }

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
    if (kind === "idle") {
      ctx.arc(c / 2, c / 2, c / 3, 0, 2 * Math.PI)
      ctx.stroke()
      dot(ctx, c / 2, c / 2, c / 12)
    } else if (kind === "listening") {
      ctx.moveTo(c / 6, c / 4)
      ctx.lineTo(5 * c / 12, c / 2)
      ctx.lineTo(c / 6, 3 * c / 4)
      ctx.moveTo(5 * c / 6, c / 4)
      ctx.lineTo(7 * c / 12, c / 2)
      ctx.lineTo(5 * c / 6, 3 * c / 4)
      ctx.moveTo(c / 2, c / 3)
      ctx.lineTo(c / 2, 2 * c / 3)
      ctx.stroke()
    } else if (kind === "thinking") {
      ctx.moveTo(c / 2, c / 6)
      ctx.lineTo(5 * c / 6, c / 2)
      ctx.lineTo(c / 2, 5 * c / 6)
      ctx.lineTo(c / 6, c / 2)
      ctx.closePath()
      ctx.stroke()
      dot(ctx, c / 2, c / 2, c / 12)
    } else if (kind === "speaking") {
      const heights = [c / 3, 2 * c / 3, c / 2]
      for (let i = 0; i < 3; i++) {
        const x = (i + 1) * c / 4
        ctx.moveTo(x, c / 2 - heights[i] / 2)
        ctx.lineTo(x, c / 2 + heights[i] / 2)
      }
      ctx.stroke()
    } else if (kind === "not-running") {
      ctx.rect(c / 6, c / 6, 2 * c / 3, 2 * c / 3)
      ctx.moveTo(c / 6, 5 * c / 6)
      ctx.lineTo(5 * c / 6, c / 6)
      ctx.stroke()
    } else if (kind === "trouble") {
      ctx.moveTo(c / 2, c / 6)
      ctx.lineTo(5 * c / 6, 5 * c / 6)
      ctx.lineTo(c / 6, 5 * c / 6)
      ctx.closePath()
      ctx.moveTo(c / 2, 5 * c / 12)
      ctx.lineTo(c / 2, 7 * c / 12)
      ctx.stroke()
      dot(ctx, c / 2, 3 * c / 4, c / 24)
    }
  }
}
