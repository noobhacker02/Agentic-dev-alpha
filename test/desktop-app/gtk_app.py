"""An accessible native window (GTK 3) for the desktop tests that need a real accessibility tree:
a labelled button, a labelled text entry and a password entry. GTK exposes them over AT-SPI, which a Tk
window doesn't. Every effect is written to the state file (AGENT_LOOP_TEST_APP_STATE), one JSON object
per line.   python3 gtk_app.py [title]
"""
import json
import os
import sys

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk  # noqa: E402

title = sys.argv[1] if len(sys.argv) > 1 else "AgentLoop GTK App"
state_path = os.environ.get("AGENT_LOOP_TEST_APP_STATE")


def log(**fields) -> None:
    if state_path:
        with open(state_path, "a") as f:
            f.write(json.dumps(fields) + "\n")


win = Gtk.Window(title=title)
win.set_default_size(420, 260)
win.move(60, 60)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10, margin=16)
win.add(box)

count = 0
button = Gtk.Button(label="Increment")


def on_click(_b) -> None:
    global count
    count += 1
    log(event="click", count=count)


button.connect("clicked", on_click)
box.pack_start(button, False, False, 0)

entry = Gtk.Entry()
entry.set_placeholder_text("Your name")
entry.get_accessible().set_name("Name")
entry.connect("changed", lambda e: log(event="text", text=e.get_text()))
box.pack_start(entry, False, False, 0)

secret = Gtk.Entry()
secret.set_visibility(False)
secret.get_accessible().set_name("Password")
secret.connect("changed", lambda e: log(event="secret-changed", length=len(e.get_text())))
box.pack_start(secret, False, False, 0)

win.connect("destroy", Gtk.main_quit)
win.show_all()
# present() gives the window a real user-time, so the window manager treats it as one a person opened and will
# focus it (a GTK window left at user-time 0 is, by design, never focused by an activation request).
win.present()
log(event="ready", title=title)
Gtk.main()
