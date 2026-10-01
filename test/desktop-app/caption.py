"""A caption bar for the desktop demo video (test/e2e/record-desktop-real.mjs): shows whatever text is in the
file named by AGENT_LOOP_CAPTION_FILE, along the bottom of the screen. Not a target of anything; it only reads."""
import os
import tkinter as tk

path = os.environ["AGENT_LOOP_CAPTION_FILE"]
root = tk.Tk()
root.overrideredirect(True)
root.geometry("1280x78+0+722")
root.configure(bg="#141413")
root.attributes("-topmost", True)
label = tk.Label(root, text="", fg="#f2efe9", bg="#141413", font=("DejaVu Sans", 14, "bold"), anchor="w", justify="left", wraplength=1230, padx=22)
label.pack(fill="both", expand=True)
tk.Frame(root, bg="#d97757", height=3).place(x=0, y=0, relwidth=1)
last = None


def poll():
    global last
    try:
        text = open(path, encoding="utf-8").read().strip()
    except OSError:
        text = ""
    if text != last:
        label.config(text=text)
        last = text
    root.after(120, poll)


poll()
root.mainloop()
