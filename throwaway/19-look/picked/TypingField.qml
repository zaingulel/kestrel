import QtQuick

// The message field: 66 px high, 1 px outline, 9 px padding, longer drafts scroll inside.
// Enter does nothing (Send does nothing); Shift+Enter inserts a newline; Tab leaves the field.
Item {
  id: root

  readonly property alias text: edit.text

  function focusInput() { edit.forceActiveFocus() }

  height: 2 * Theme.controlHeight

  Rectangle {
    anchors.fill: parent
    color: Theme.popupsBackground
    border.width: Theme.hairline
    border.color: Theme.popupsText
  }

  Flickable {
    id: flick
    anchors.fill: parent
    anchors.margins: Theme.controlGap
    clip: true
    contentWidth: width
    contentHeight: edit.height

    TextEdit {
      id: edit
      width: flick.width
      wrapMode: TextEdit.Wrap
      color: Theme.popupsText
      selectionColor: Theme.accent
      selectedTextColor: Theme.popupsBackground
      font.family: Theme.family
      font.pixelSize: Theme.body
      Accessible.name: "Message"

      onCursorRectangleChanged: {
        if (cursorRectangle.y < flick.contentY) flick.contentY = cursorRectangle.y
        else if (cursorRectangle.y + cursorRectangle.height > flick.contentY + flick.height)
          flick.contentY = cursorRectangle.y + cursorRectangle.height - flick.height
      }

      Keys.onPressed: function(event) {
        if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter) && !(event.modifiers & Qt.ShiftModifier))
          event.accepted = true
      }
      Keys.onTabPressed: function(event) { nextItemInFocusChain(true).forceActiveFocus(Qt.TabFocusReason) }
      Keys.onBacktabPressed: function(event) { nextItemInFocusChain(false).forceActiveFocus(Qt.BacktabFocusReason) }
    }

    Text {
      visible: edit.text.length === 0
      text: "Type a message"
      color: Theme.popupsText
      font.family: Theme.family
      font.pixelSize: Theme.body
    }
  }

  FocusRing { visible: edit.activeFocus }
}
