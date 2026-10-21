import * as path from 'path';

/**
 * A file reference in the active harness's own mention syntax.
 *
 * Mirrors what each harness's @ completion inserts (and herdr-obsidian's
 * drag-and-drop): only Claude Code turns raw @path into an attachment; the
 * others resolve the path with their file tools.
 */
export function formatReference(
  agent: string | null,
  filePath: string,
  start?: number,
  end?: number
): string {
  const lines = start === undefined ? '' : start === end ? `${start}` : `${start}-${end}`;
  const colon = lines ? `:${lines}` : '';
  const hashL = lines ? `#L${lines}` : '';
  const quote = (s: string) => (s.includes(' ') ? `"${s}"` : s);

  switch (agent) {
    // Codex's @ menu inserts a bare path; the @ is only the trigger.
    case 'codex':
      return `${quote(filePath)}${colon} `;
    // Copilot, Grok and Antigravity attach @path:10-20.
    case 'agy':
    case 'copilot':
    case 'grok':
      return `@${filePath}${colon} `;
    // opencode's own extension sends @path#L10-20.
    case 'opencode':
      return `@${filePath}${hashL} `;
    // pi quotes paths with spaces and has no range syntax.
    case 'pi':
      return `@${quote(filePath)}${colon} `;
    // Claude (and unknown harnesses) parse @path#L10-20, quotes included.
    default:
      return `@${quote(filePath + hashL)} `;
  }
}

/** Relative path when inside the folder, absolute otherwise. */
export function referencePath(folder: string, file: string): string {
  const rel = path.relative(folder, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return file;
  return rel.split(path.sep).join('/');
}
