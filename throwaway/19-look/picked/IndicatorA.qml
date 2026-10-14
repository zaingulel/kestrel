import QtQuick

// Indicator A, "three marks": 3 px marks, 3 px gaps, centred in the 25 px slot, bottom-aligned to a line
// (markBase) 9 px above the bar's bottom edge. The whole slot is the click target.
Item {
  id: root

  property string kind: "idle"
  readonly property int markBase: Theme.barHeight - 9

  signal activated()

  implicitWidth: Theme.slotWidth
  implicitHeight: Theme.barHeight

  HoverHandler { id: hover }
  TapHandler { onTapped: root.activated() }
  Tooltip { target: root; shown: hover.hovered; text: Theme.tips[root.kind] }

  StateLayer {
    name: "not-running"; current: root.kind
    Rectangle { x: 5; y: root.markBase - 2; width: 15; height: 2; color: Theme.barTextResting }
  }

  StateLayer {
    name: "idle"; current: root.kind
    Repeater {
      model: 3
      Rectangle {
        required property int index
        x: 5 + index * 6; y: root.markBase - 3; width: 3; height: 3
        color: Theme.barTextResting
      }
    }
  }

  StateLayer {
    name: "listening"; current: root.kind
    Repeater {
      model: 3
      Rectangle {
        required property int index
        x: 5 + index * 6; y: root.markBase - 12; width: 3; height: 12
        color: Theme.barText
      }
    }
  }

  StateLayer {
    id: thinking
    name: "thinking"; current: root.kind
    property int step: 0
    Timer {
      interval: 280; repeat: true; running: thinking.visible
      onTriggered: thinking.step = (thinking.step + 1) % 3
    }
    Repeater {
      model: 3
      Rectangle {
        required property int index
        x: 5 + index * 6; y: root.markBase - 3 - (thinking.step === index ? 5 : 0); width: 3; height: 3
        color: Theme.barText
      }
    }
  }

  StateLayer {
    id: speaking
    name: "speaking"; current: root.kind
    Repeater {
      model: [{ h: 6, period: 420 }, { h: 12, period: 520 }, { h: 8, period: 610 }]
      Rectangle {
        required property int index
        required property var modelData
        x: 5 + index * 6; y: root.markBase - height; width: 3; height: modelData.h
        color: Theme.barText
        SequentialAnimation on height {
          loops: Animation.Infinite; running: speaking.visible
          NumberAnimation { to: 4; duration: modelData.period / 2; easing.type: Easing.InOutSine }
          NumberAnimation { to: 12; duration: modelData.period / 2; easing.type: Easing.InOutSine }
        }
      }
    }
  }

  StateLayer {
    name: "trouble"; current: root.kind
    Rectangle { x: 5; y: root.markBase - 3; width: 3; height: 3; color: Theme.barActive }
    Rectangle { x: 11; y: root.markBase - 3; width: 3; height: 3; color: Theme.barActive }
    Rectangle { x: 17; y: root.markBase - 12; width: 3; height: 7; color: Theme.barActive }
    Rectangle { x: 17; y: root.markBase - 3; width: 3; height: 3; color: Theme.barActive }
  }
}
