"""A tiny native window for agent-loop's real desktop tests (test/desktop-real*.mjs).

Every effect is written to a state file (AGENT_LOOP_TEST_APP_STATE, one JSON object per line) and
mirrored in the window title. The tests read the state file -- a channel independent of the driver and
of the tool results they are checking. Run under a display:
    python3 app.py [title-prefix]
"""
import json
import os
import sys
import tkinter as tk

prefix = sys.argv[1] if len(sys.argv) > 1 else "AgentLoop Test App"
state_path = os.environ.get("AGENT_LOOP_TEST_APP_STATE")
root = tk.Tk()
root.geometry(os.environ.get("AGENT_LOOP_TEST_APP_GEOMETRY", "420x260+60+60"))
count = 0


def log(**fields) -> None:
    if state_path:
        with open(state_path, "a") as f:
            f.write(json.dumps(fields) + "\n")


def retitle(suffix: str) -> None:
    root.title(f"{prefix} | {suffix}")


def bump() -> None:
    global count
    count += 1
    retitle(f"count={count}")
    log(event="click", count=count)


retitle("ready")
tk.Button(root, text="Increment", command=bump, font=("TkDefaultFont", 16)).place(x=20, y=20, width=200, height=60)
entry = tk.Entry(root, font=("TkDefaultFont", 16))
entry.place(x=20, y=110, width=300, height=40)


def on_key(event) -> None:
    retitle(f"text={entry.get()}")
    log(event="text", text=entry.get(), keysym=event.keysym)


entry.bind("<KeyRelease>", on_key)
tk.Label(root, text="Type here, press the button", font=("TkDefaultFont", 12)).place(x=20, y=170)
log(event="ready", title=f"{prefix} | ready")
root.mainloop()
