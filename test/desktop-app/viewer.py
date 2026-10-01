"""'What the agent sees' for the desktop demo video: shows the PNG at AGENT_LOOP_VIEW_FILE, reloading it whenever it
changes. Only reads."""
import os
import tkinter as tk

path = os.environ["AGENT_LOOP_VIEW_FILE"]
root = tk.Tk()
root.title("What the agent sees (the capture tool's result)")
root.geometry("620x460+650+40")
root.configure(bg="#1f1e1d")
head = tk.Label(root, text="Waiting for a capture…", fg="#e8e6e3", bg="#1f1e1d", font=("DejaVu Sans", 12, "bold"))
head.pack(pady=(10, 4))
pic = tk.Label(root, bg="#1f1e1d")
pic.pack()
last = None
img = None


def poll():
    global last, img
    try:
        m = os.path.getmtime(path)
    except OSError:
        m = None
    if m and m != last:
        try:
            img = tk.PhotoImage(file=path)
            pic.config(image=img)
            head.config(text=f"Window pixels only: {img.width()}x{img.height()} (never the screen)")
            last = m
        except tk.TclError:
            pass
    root.after(150, poll)


poll()
root.mainloop()
