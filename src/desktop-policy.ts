/**
 * The rules desktop computer use enforces on its own, independent of whichever driver carries them
 * out (specs/computer-use/SPEC.md, threats T1, T2, T6): which windows may never be a target, which
 * keys and text may never be sent. Pure functions, so they're tested directly and can't drift from
 * what the tools call.
 *
 * Why a list of names at all, when the human picks the one target? Because the safety net only ever
 * inspects the `Bash` tool's `command`: typing into a terminal, an IDE's integrated terminal, or a
 * run/launcher dialog would execute anything with none of the Bash protections in play. A human who
 * names one of those by mistake (or a name that resolves to one) gets a refusal, not a session.
 * Matching is by process identity, never by window title, because a title is whatever the app says.
 */

export type DeniedCategory = "terminal" | "shell" | "ide" | "launcher" | "browser" | "remote" | "secrets";

const DENIED: Record<DeniedCategory, { why: string; names: string[] }> = {
  terminal: {
    why: "typing into a terminal runs commands with none of the Bash protections in play",
    names: [
      "xterm", "uxterm", "gnome-terminal", "konsole", "alacritty", "kitty", "wezterm", "tilix", "terminator",
      "urxvt", "rxvt", "st", "foot", "lxterminal", "xfce4-terminal", "mate-terminal", "deepin-terminal",
      "terminology", "guake", "yakuake", "tmux", "screen", "iterm", "iterm2", "terminal", "hyper", "warp",
      "ghostty", "windowsterminal", "windows-terminal", "wt", "conhost", "openconsole", "mintty", "putty", "cmd",
      "command-prompt", "powershell", "windows-powershell", "pwsh", "console",
    ],
  },
  shell: {
    why: "a shell window runs whatever is typed into it",
    names: ["bash", "zsh", "sh", "fish", "dash", "ksh", "tcsh", "csh", "ash", "nu", "xonsh", "elvish"],
  },
  ide: {
    why: "editors and IDEs have integrated terminals and run configurations",
    names: [
      "code", "code-insiders", "code-oss", "codium", "vscodium", "cursor", "windsurf", "zed", "lapce", "fleet",
      "idea", "idea64", "pycharm", "webstorm", "phpstorm", "goland", "clion", "rider", "rubymine", "datagrip",
      "studio", "android-studio", "intellij-idea", "visual-studio-code", "eclipse", "netbeans", "sublime_text",
      "sublime", "sublime-text", "atom", "emacs", "vim",
      "gvim", "nvim", "neovide", "xcode", "kate",
    ],
  },
  launcher: {
    why: "a launcher or run dialog starts any program by name",
    names: [
      "rofi", "dmenu", "wofi", "bemenu", "fuzzel", "ulauncher", "albert", "krunner", "synapse", "gnome-shell",
      "plasmashell", "xfce4-appfinder", "alfred", "raycast", "spotlight", "launchbar", "quicksilver",
      "searchhost", "searchapp", "startmenuexperiencehost", "shellexperiencehost", "explorer",
    ],
  },
  browser: {
    why: "a desktop-controlled browser can navigate anywhere, bypassing the browser tools' localhost-only boundary (use the browser tools for web apps)",
    names: [
      "chrome", "google-chrome", "chromium", "chromium-browser", "firefox", "firefox-esr", "brave", "brave-browser",
      "msedge", "microsoft-edge", "edge", "safari", "opera", "vivaldi", "epiphany", "librewolf", "tor-browser", "arc", "waterfox",
      "zen", "orion",
    ],
  },
  remote: {
    why: "a remote-desktop window is a terminal on another machine",
    names: ["remmina", "vncviewer", "tigervnc", "teamviewer", "anydesk", "mstsc", "rdesktop", "xfreerdp", "parsec", "rustdesk"],
  },
  secrets: {
    why: "password managers, key agents, authentication prompts and lock screens show or guard secrets",
    names: [
      "keepassxc", "keepass", "1password", "bitwarden", "lastpass", "dashlane", "enpass", "seahorse",
      "gnome-keyring", "polkit", "pkexec", "ssh-askpass", "loginwindow", "gnome-screensaver", "xscreensaver",
      "swaylock", "i3lock",
    ],
  },
};

/** The last path segment, lower-cased, without a platform executable suffix. */
export function normalizeProcessName(raw: string): string {
  const last = String(raw ?? "").split(/[\\/]/).pop() ?? "";
  return last.toLowerCase().replace(/\.(exe|app|bin)$/, "").trim().replace(/\s+/g, "-");
}

/** `entry`, or `entry` followed by a separator or digit ("gnome-terminal-server", "python3.12",
 * "wezterm-gui") -- but not another word that merely starts with it ("shotwell" is not "sh"). */
function matchesEntry(name: string, entry: string): boolean {
  return name === entry || (name.startsWith(entry) && /[-_.0-9]/.test(name[entry.length]));
}

export interface DeniedMatch {
  category: DeniedCategory;
  entry: string;
  why: string;
  /** The raw identifier that matched, for the refusal message. */
  matched: string;
}

/** Checks every identifier a window's owner goes by (process name, executable, argv[0], app/class
 * name, the target string the human typed). Any one matching is enough: the point is to refuse, so the
 * check errs on the side of "yes, that's one of them". */
export function classifyDeniedTarget(identifiers: Array<string | undefined>): DeniedMatch | undefined {
  for (const raw of identifiers) {
    if (!raw) continue;
    const name = normalizeProcessName(raw);
    if (!name) continue;
    for (const [category, { why, names }] of Object.entries(DENIED) as Array<[DeniedCategory, { why: string; names: string[] }]>) {
      const entry = names.find((n) => matchesEntry(name, n));
      if (entry) return { category, entry, why, matched: raw };
    }
  }
  return undefined;
}

export function deniedTargetMessage(m: DeniedMatch): string {
  return `"${m.matched}" is a ${m.category} ("${m.entry}"): ${m.why}. Desktop tools refuse it as a target, by process identity, whatever its window title says.`;
}

// ---------------------------------------------------------------- keys

const NAMED_KEYS = new Set([
  "enter", "return", "tab", "escape", "esc", "backspace", "delete", "insert", "home", "end", "pageup", "pagedown",
  "page_up", "page_down", "up", "down", "left", "right", "arrowup", "arrowdown", "arrowleft", "arrowright", "space",
]);

/** Modifiers the tool accepts at all. No meta/super/windows/command: combos with those are how a
 * keyboard reaches the OS (launchers, app switchers, lock screens) rather than the target window. */
export const ALLOWED_MODIFIERS = ["ctrl", "shift", "alt"] as const;
export type KeyModifier = (typeof ALLOWED_MODIFIERS)[number];

/**
 * Returns why a key press must be refused, or undefined if it may go to the target window. An
 * allowlist on the key itself (one visible ASCII character, F1-F12, or an ordinary editing/navigation
 * key) keeps XF86 power/sleep/media keysyms, SysRq and the like unreachable; the combination checks
 * then drop the window-manager chords that leave the window (Alt+Tab, Alt+F4, Ctrl+Alt+anything,
 * Ctrl+Esc, Ctrl+Shift+Esc).
 */
export function checkKeyPress(key: string, modifiers: readonly string[] = []): string | undefined {
  const k = String(key ?? "").trim();
  if (!k) return "key is empty";
  if (k.length > 1 && /[+\s]/.test(k)) return `key "${k.slice(0, 20)}" must be one key; put modifiers in the modifiers list`;
  const lower = k.toLowerCase();
  const isChar = /^[\x21-\x7e]$/.test(k);
  const isFn = /^f(?:[1-9]|1[0-2])$/.test(lower);
  if (!isChar && !isFn && !NAMED_KEYS.has(lower)) {
    return `key "${k.slice(0, 30)}" isn't allowed: only a single visible character, F1-F12, or an ordinary editing/navigation key (Enter, Tab, Escape, Backspace, Delete, arrows, Home/End, PageUp/PageDown, Space)`;
  }
  const mods = new Set(modifiers.map((m) => String(m).toLowerCase()));
  for (const m of mods) if (!(ALLOWED_MODIFIERS as readonly string[]).includes(m)) return `modifier "${m.slice(0, 20)}" isn't allowed: only ctrl, shift and alt`;
  if (mods.has("ctrl") && mods.has("alt")) return "Ctrl+Alt combinations are window-manager and OS shortcuts (console switch, terminal launch, log out), not input for the target window";
  if (mods.has("alt") && (lower === "tab" || lower === "escape" || lower === "esc" || lower === "space" || isFn)) {
    return `Alt+${k} switches, closes or moves windows rather than acting inside the target`;
  }
  if (mods.has("ctrl") && (lower === "escape" || lower === "esc")) return "Ctrl+Escape opens the OS start menu";
  if (mods.has("ctrl") && mods.has("shift") && (lower === "escape" || lower === "esc")) return "Ctrl+Shift+Escape opens the OS task manager";
  return undefined;
}

// ---------------------------------------------------------------- typed text

export const MAX_TYPED_CHARS = 1000;

/** Returns why a string must not be typed, or undefined. Control characters (other than newline and
 * tab) and invisible/bidirectional-override characters are refused so that what the human sees in the
 * approval prompt is exactly what lands in the window. */
export function checkTypedText(text: string): string | undefined {
  if (typeof text !== "string" || text.length === 0) return "text is empty";
  if (text.length > MAX_TYPED_CHARS) return `text is ${text.length} characters; the limit is ${MAX_TYPED_CHARS} per action`;
  if (/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/.test(text)) return "text contains control characters (only newline and tab are allowed)";
  if (/[​-‏‪-‮⁦-⁩﻿]/.test(text)) return "text contains invisible or bidirectional-override characters";
  return undefined;
}
