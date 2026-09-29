/**
 * Strips every C0/C1 control byte except tab and newline from text before it reaches a real
 * terminal. Bash output, file content, a curl response body, the model's own turn text, and (via
 * "don't ask again" rules built from real Bash command text) approval-rule strings can all carry an
 * attacker- or accident-planted escape sequence -- printed raw, it could rewrite the terminal title,
 * clear/overwrite what's on screen, or (via OSC 52, which many terminal emulators honor) silently
 * write to the real clipboard. Stripping every control byte removes anything that could ever start
 * such a sequence, rather than trying to match specific known sequence shapes.
 *
 * Shared between every place that prints untrusted text to a real terminal (src/terminal.ts's live
 * transcript, src/cli.ts's `insights` report) so the one regex that matters can't quietly drift out
 * of sync between them.
 */
export function stripTerminalControlBytes(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
}
