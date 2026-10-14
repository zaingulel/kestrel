// Throwaway prototype for card #19 (Claude's half). Question it answers: which of
// two top-bar indicators (A "three marks", B "mark and word") and which of two
// conversation panels (A "ledger", B "caption") belongs in Omarchy's matte-black
// desktop, seen at real size and in the bar's own colours and font?
//
//   quickshell -p throwaway/19-look/claude
//   quickshell ipc -p throwaway/19-look/claude call proto indicator a|b
//   quickshell ipc -p throwaway/19-look/claude call proto state not-running|idle|listening|thinking|speaking|trouble
//   quickshell ipc -p throwaway/19-look/claude call proto sheet on|off
//   quickshell ipc -p throwaway/19-look/claude call proto panel a|b|none
//   quickshell ipc -p throwaway/19-look/claude call proto view conversation|empty
//
// Delete with the job; nothing here reaches main.
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import QtQuick

ShellRoot {
  id: root

  property string indicatorChoice: "a"
  property string stateName: "idle"
  property bool sheetOn: false
  property string panelChoice: "none"
  property string viewName: "conversation"

  readonly property var stateNames: ["not-running", "idle", "listening", "thinking", "speaking", "trouble"]

  // The sample conversation, rendered up to step 4.
  readonly property var sample: [
    { who: "you", text: "what's the tallest mountain in the Alps", sources: [] },
    { who: "kestrel", text: "Mont Blanc, at about 4,806 metres.", sources: [{ site: "en.wikipedia.org", title: "Mont Blanc" }] },
    { who: "you", text: "and the second", sources: [] },
    { who: "kestrel", text: "Monte Rosa's Dufourspitze, about 4,634 metres.", sources: [{ site: "en.wikipedia.org", title: "Monte Rosa" }] }
  ]
  readonly property var turns: viewName === "conversation" ? sample : []

  IpcHandler {
    target: "proto"

    function indicator(which: string): void {
      if (which === "a" || which === "b") root.indicatorChoice = which
    }

    function state(name: string): void {
      if (root.stateNames.indexOf(name) !== -1) root.stateName = name
    }

    function sheet(mode: string): void {
      if (mode === "on" || mode === "off") root.sheetOn = mode === "on"
    }

    function panel(which: string): void {
      if (which === "a" || which === "b" || which === "none") root.panelChoice = which
    }

    function view(name: string): void {
      if (name === "conversation" || name === "empty") root.viewName = name
    }
  }

  PanelWindow {
    anchors { top: true; left: true; right: true }
    margins.top: Theme.barHeight
    exclusionMode: ExclusionMode.Ignore
    implicitHeight: root.sheetOn ? Theme.barHeight * root.stateNames.length : Theme.barHeight
    color: Theme.background
    WlrLayershell.layer: WlrLayer.Top
    WlrLayershell.namespace: "kestrel-proto-strip"

    Column {
      anchors.fill: parent

      BarRow {
        visible: !root.sheetOn
        width: parent.width
        which: root.indicatorChoice
        kind: root.stateName
      }

      Repeater {
        model: root.stateNames

        BarRow {
          required property string modelData
          visible: root.sheetOn
          width: parent.width
          which: root.indicatorChoice
          kind: modelData
          label: modelData
        }
      }
    }
  }

  PanelA {
    visible: root.panelChoice === "a"
    turns: root.turns
    stateWord: root.viewName === "conversation" ? "listening" : ""
    onCloseRequested: root.panelChoice = "none"
  }

  PanelB {
    visible: root.panelChoice === "b"
    turns: root.turns
    onCloseRequested: root.panelChoice = "none"
  }
}
