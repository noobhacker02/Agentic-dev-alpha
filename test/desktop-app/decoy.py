"""A solid-colour native window used as an adversary in the desktop tests (test/desktop-real-adversarial.mjs):
an overlapping window whose pixels must never appear in a capture of another window, a window that holds
focus while input is aimed at another, a same-named window that appears after the real one is gone.

    python3 decoy.py <title> [colour]        env: AGENT_LOOP_TEST_APP_STATE, AGENT_LOOP_TEST_APP_GEOMETRY
Logs every key and click it receives to the state file, one JSON object per line.
"""
import json
import os
import sys
import tkinter as tk

title = sys.argv[1] if len(sys.argv) > 1 else "Decoy"
colour = sys.argv[2] if len(sys.argv) > 2 else "#ff0000"
state_path = os.environ.get("AGENT_LOOP_TEST_APP_STATE")
root = tk.Tk()
root.title(title)
root.configure(bg=colour)
root.geometry(os.environ.get("AGENT_LOOP_TEST_APP_GEOMETRY", "300x200+100+100"))


def log(**fields) -> None:
    if state_path:
        with open(state_path, "a") as f:
            f.write(json.dumps(fields) + "\n")


cmd_path = os.environ.get("AGENT_LOOP_TEST_APP_CMD")
cmd_offset = 0


def poll_commands() -> None:
    """`focus` takes keyboard focus (and logs when it has it), so a test can steal it at a chosen moment."""
    global cmd_offset
    if cmd_path and os.path.exists(cmd_path):
        with open(cmd_path) as f:
            f.seek(cmd_offset)
            for line in f.read().splitlines():
                if line.strip() == "focus":
                    root.deiconify()
                    root.lift()
                    root.focus_force()
                    entry.focus_force()
            cmd_offset = f.tell()
    root.after(80, poll_commands)


entry = tk.Entry(root)
entry.place(x=10, y=10, width=200)
entry.focus_force()
entry.bind("<KeyRelease>", lambda e: log(event="text", text=entry.get(), keysym=e.keysym))
root.bind("<Button-1>", lambda e: log(event="click", x=e.x, y=e.y))
entry.bind("<FocusIn>", lambda e: log(event="focus-in"))
poll_commands()
root.bind("<Key>", lambda e: log(event="key", keysym=e.keysym))
log(event="ready", title=title)
root.mainloop()
