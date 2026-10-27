"""Execute production placement payloads without contacting a compositor."""

from pathlib import Path
import re
import subprocess
import unittest


PANEL = Path(__file__).resolve().parents[1] / "desktop" / "Panel.qml"


def payloads():
    source = PANEL.read_text()
    result = {}
    for name in ("prepareLua", "verifyOpenLua", "verifyCloseLua", "cleanupLua"):
        matches = re.findall(r"^    readonly property string " + name + r":\s*`([^`]*)`[ \t]*$", source, re.MULTILINE)
        if len(matches) != 1 or "${" in matches[0] or "\\" in matches[0]:
            raise AssertionError(f"{name} must be an uninterpolated literal Lua payload")
        result[name] = matches[0]
    return result


BOUNDARY = '''
local hdmi={name="HDMI-A-1",position={x=-1920,y=738},size={width=2560,height=1440},
    scale=1,transform=0,reserved={left=0,right=0,top=26,bottom=0},focused=false}
local edp={name="eDP-1",position={x=640,y=1278},size={width=2880,height=1800},
    scale=2,transform=0,reserved={left=0,right=0,top=26,bottom=0},focused=true}
local monitors={hdmi,edp}
local prior={address="0x123",stable_id=11,monitor=edp}
local active=prior
local windows={prior}
local events,calls={},{}
local refuseTransfer,failCleanup=false,false
hl={dsp={window={}}}
function hl.get_monitors() return monitors end
function hl.get_windows() return windows end
function hl.get_active_window() return active end
function hl.get_config(key)
    if key=="general.gaps_out" then return {left=10,right=10,top=10,bottom=10} end
    assert(key=="general.border_size"); return 2
end
function hl.window_rule(options)
    local rule={enabled=options.enabled}
    function rule:set_enabled(value)
        if failCleanup and not value then error("private native failure") end
        self.enabled=value
    end
    function rule:is_enabled() return self.enabled end
    return rule
end
function hl.on(name,callback)
    local subscription={active=true,callback=callback}
    function subscription:remove() self.active=false end
    function subscription:is_active() return self.active end
    events[name]=subscription
    return subscription
end
function hl.dsp.window.move(options) options.kind="move"; return options end
function hl.dsp.focus(options) options.kind="focus"; return options end
function hl.dispatch(options)
    calls[#calls+1]=options
    if options.kind=="focus" then active=options.window
    elseif options.monitor then
        if refuseTransfer then return end
        options.window.monitor=options.monitor
        options.window.workspace=options.monitor.name=="HDMI-A-1" and 4 or 1
        if options.follow then active=options.window end
    else
        -- Coordinate-only movement deliberately preserves native monitor ownership.
        options.window.at={x=options.x,y=options.y}
    end
end
local function saved(m,x,y,area)
    _kestrelConversationPlacement={saved={monitor=m.name,xLocal=x,yLocal=y,
        area=area or {left=12,right=m==hdmi and 2548 or 1428,top=38,bottom=m==hdmi and 1428 or 888}}}
end
local function openPanel()
    local w={initial_title="Kestrel conversation",initial_class="org.quickshell",
        address="0x456",stable_id=22,monitor=edp.focused and edp or hdmi,
        at={x=0,y=0},size={x=448,y=640}}
    windows[#windows+1]=w
    events["window.open"].callback(w)
    return w
end
local function cleaned(s)
    assert(s.openSub==nil and s.closeSub==nil,"subscriptions retained")
    assert(not s.rule or not s.rule:is_enabled(),"rule retained")
    assert(s.expected==nil and s.returnFocus==nil,"temporary state retained")
end
'''


class PanelPlacementTests(unittest.TestCase):
    def run_lua(self, scenario):
        self.assertTrue(Path("/usr/bin/lua").is_file(), "/usr/bin/lua is required; native evidence cannot skip")
        chunks = payloads()
        definitions = "\n".join(f"local function {name}()\n{body}\nend" for name, body in chunks.items())
        result = subprocess.run(
            ["/usr/bin/lua", "-"], input=BOUNDARY + definitions + scenario,
            text=True, capture_output=True, timeout=5, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_reopen_owns_saved_monitor(self):
        for destination, x, y, global_x, global_y, workspace in (
            ("hdmi", 2096, 786, 176, 1524, 4),
            ("edp", 860, 122, 1500, 1400, 1),
        ):
            for closing in ("restore", "gone", "reused", "none", "elsewhere", "panel-reused"):
                with self.subTest(destination=destination, closing=closing):
                    self.run_lua(f'''
local destination={destination}
hdmi.focused=destination==edp; edp.focused=destination==hdmi
if "{closing}"=="none" then active=nil; windows={{}} end
saved(destination,{x},{y})
prepareLua()
local w=openPanel()
assert(w.monitor==destination,"wrong monitor ownership")
assert(w.at.x=={global_x} and w.at.y=={global_y},"wrong saved coordinates")
assert(w.size.x==448 and w.size.y==640 and w.workspace=={workspace})
assert(#calls==2 and calls[1].monitor==destination and calls[1].follow==true,
    "monitor transfer must follow before coordinate movement")
assert(calls[2].x=={global_x} and calls[2].y=={global_y})
assert(active==w,"native transfer did not focus the panel")
verifyOpenLua()
if "{closing}"=="gone" then windows={{w}} end
if "{closing}"=="reused" then windows={{{{address=prior.address,stable_id=12}},w}} end
if "{closing}"=="elsewhere" then active=prior end
if "{closing}"=="panel-reused" then active={{address=w.address,stable_id=23}} end
events["window.close"].callback(w)
local s=_kestrelConversationPlacement
assert(s.saved.monitor==destination.name and s.saved.xLocal=={x} and s.saved.yLocal=={y})
if "{closing}"=="restore" then
    assert(#calls==3 and calls[3].kind=="focus" and active==prior,"prior focus was not restored")
else assert(#calls==2,"close stole focus") end
cleaned(s); verifyCloseLua(); cleanupLua()
''')

    def test_invisible_saved_position_recovers(self):
        # Full display bounds: HDMI [-1920,640] x [738,2178], eDP [640,2080] x [1278,2178].
        for x, y, expected_x, expected_y in (
            (2095, 787, 1620, 1316),
            (-2400, 1500, 652, 1500), (2200, 1500, 1620, 1500),
            (1000, 0, 1000, 1316), (1000, 2300, 1000, 1526),
            (-2368, 1500, 652, 1500), (2080, 1500, 1620, 1500),
            (0, 98, 652, 1316), (1000, 2178, 1000, 1526),
        ):
            with self.subTest(position=(x, y)):
                self.run_lua(f'''
saved(edp,{x - 640},{y - 1278})
prepareLua(); local w=openPanel(); verifyOpenLua()
assert(w.at.x=={expected_x} and w.at.y=={expected_y},"invisible saved position was not recovered")
cleanupLua(); cleaned(_kestrelConversationPlacement)
''')

    def test_partial_position_survives(self):
        for x, y in ((2079, 1500), (-2367, 1500), (0, 99), (1000, 2177), (176, 1524)):
            with self.subTest(position=(x, y)):
                self.run_lua(f'''
saved(edp,{x - 640},{y - 1278})
prepareLua(); local w=openPanel(); verifyOpenLua()
assert(w.at.x=={x} and w.at.y=={y},"intentional positive overlap was clamped")
assert(w.monitor==edp)
cleanupLua(); cleaned(_kestrelConversationPlacement)
''')

    def test_first_open_and_layout_change(self):
        for setup, x, y, monitor in (
            ("", 1620, 1526, "edp"),
            ("edp.focused=false; hdmi.focused=true", 180, 1526, "hdmi"),
            ("saved(edp,1300,800); edp.reserved.left=40", 1620, 1526, "edp"),
            ("saved(edp,860,122); edp.position={x=-1000,y=200}", -140, 322, "edp"),
            ("edp.transform=1", 1080, 2066, "edp"),
            ("saved(hdmi,2096,786); monitors={edp}", 1620, 1526, "edp"),
            ("_kestrelConversationPlacement={workArea=function() error('stale closure') end}", 1620, 1526, "edp"),
        ):
            with self.subTest(setup=setup):
                self.run_lua(f'''
{setup}
prepareLua(); local w=openPanel(); verifyOpenLua()
assert(w.monitor=={monitor} and w.at.x=={x} and w.at.y=={y},"first/layout placement drift")
assert(w.size.x==448 and w.size.y==640)
cleanupLua(); cleaned(_kestrelConversationPlacement)
''')

    def test_confirmation_rejects_drift(self):
        for drift in (
            "w.at.x=w.at.x+1", "w.at.y=w.at.y+1",
            "w.size.x=447", "w.size.y=639", "w.monitor=hdmi",
            "windows={prior}", "windows={prior,w,w}",
        ):
            with self.subTest(drift=drift):
                self.run_lua(f'''
prepareLua(); local w=openPanel(); verifyOpenLua()
{drift}
assert(not pcall(verifyOpenLua),"drift was reported as confirmed success")
cleanupLua(); cleaned(_kestrelConversationPlacement)
''')
        self.run_lua('''
saved(hdmi,2096,786); refuseTransfer=true
prepareLua()
assert(not pcall(openPanel),"refused transfer was accepted")
assert(not pcall(verifyOpenLua))
assert(_kestrelConversationPlacement.failed==true)
cleaned(_kestrelConversationPlacement); cleanupLua()
''')
        self.run_lua('''
prepareLua(); openPanel(); verifyOpenLua()
failCleanup=true
assert(not pcall(cleanupLua),"cleanup failure was accepted")
assert(not pcall(verifyOpenLua),"failed cleanup retained confirmed success")
assert(not pcall(verifyCloseLua),"failed cleanup confirmed close")
failCleanup=false; cleanupLua(); cleaned(_kestrelConversationPlacement)
''')

    def test_invalid_state_is_refused(self):
        for invalid in (
            'saved(edp,0/0,100)', 'saved(edp,"PRIVATE_METADATA",100)',
            'saved(edp,100,100); _kestrelConversationPlacement.saved.area=false',
            'saved(edp,100,100); _kestrelConversationPlacement.saved.area.left=nil',
            'saved(edp,100,100); _kestrelConversationPlacement.saved.area.right=math.huge',
            '_kestrelConversationPlacement={workArea=false}',
            'edp.scale=math.huge', 'edp.scale=0/0', 'edp.scale=0',
            'edp.transform=8', 'edp.transform=1.5',
            'prior.address="PRIVATE_METADATA"', 'prior.address="0x"',
            'prior.address="0x12345678901234567"',
            'prior.stable_id=0', 'prior.stable_id=-1', 'prior.stable_id=1.5',
            'prior.stable_id=math.huge', 'prior.stable_id=0/0',
            'prior.stable_id=9007199254740992',
        ):
            with self.subTest(invalid=invalid):
                self.run_lua(f'''
{invalid}
local s=_kestrelConversationPlacement or {{}}
_kestrelConversationPlacement=s
s.expected={{monitor="PRIVATE_METADATA"}}; s.returnFocus={{address="PRIVATE_METADATA"}}
s.openSub=hl.on("old.open",function() end); s.closeSub=hl.on("old.close",function() end)
local ok,message=pcall(prepareLua)
assert(not ok,"invalid state was accepted")
assert(message:find("Kestrel panel placement failed",1,true))
assert(not message:find("PRIVATE_METADATA",1,true),"raw metadata leaked")
assert(s.failed==true); cleaned(s)
for _,subscription in pairs(events) do assert(not subscription:is_active()) end
cleanupLua()
''')
        for expected in (
            'nil', 'false', '{}', '{monitor="",x=1620,y=1526}',
            '{monitor="eDP-1",x=0/0,y=1526}', '{monitor="eDP-1",x=math.huge,y=1526}',
            '{monitor="eDP-1",x=1620,y="PRIVATE_METADATA"}',
            '{monitor="eDP-1",x=1620,y=1.5}',
        ):
            with self.subTest(expected=expected):
                self.run_lua(f'''
prepareLua(); openPanel(); verifyOpenLua()
_kestrelConversationPlacement.expected={expected}
local ok,message=pcall(verifyOpenLua)
assert(not ok,"invalid expected state was accepted")
assert(message:find("Kestrel panel placement failed",1,true))
assert(not message:find("PRIVATE_METADATA",1,true),"raw metadata leaked")
cleanupLua(); cleaned(_kestrelConversationPlacement)
''')
        self.run_lua('''
prior.address="0x1234567890ABCDEF"; prior.stable_id=9007199254740991
prepareLua(); local w=openPanel(); verifyOpenLua()
events["window.close"].callback(w)
assert(active==prior); cleaned(_kestrelConversationPlacement); verifyCloseLua()
''')
