// Two parsers read a Windows command line built for a cmd.exe hop, and they disagree. The target
// program's own startup code (CommandLineToArgvW, which the CRT and Node both use) treats \" as a
// literal quote and \\ as a literal backslash. cmd.exe -- unavoidable for a .cmd/.bat target, or for
// npx/npm/pnpm/yarn/bunx on Windows -- does not: it counts " naively to track quote state, and inside
// that state it still expands %VAR%. A \" written for the first parser silently flips cmd's quote
// parity, and every later & | < > ^ on the line stops being data and becomes an operator; a live
// %VAR% pair expands even though it is quoted.
//
// The encoding below satisfies both parsers at once: an embedded quote is written as "" rather than
// \" (both decode to a literal quote, but only "" leaves cmd's naive quote count even), a run of
// backslashes is doubled wherever it precedes a quote or ends the argument (CommandLineToArgvW does
// interpret that part), and a % is closed out of the quoted run and escaped with ^ so cmd never sees
// a matched pair to expand -- verified against a real .cmd shim spawned exactly the way declick spawns
// one (see test/windows-cmd-quote.test.mjs).
//
// Adapted from stablyai/orca's src/shared/child-process/windows-command-line.ts (MIT). See NOTICE.md.
//
// Known limitation, pre-existing and not fixed here: cmd.exe reads a command line one line at a time, so
// a CR or LF inside an argument silently truncates everything after it -- data loss, not the quote-parity
// or injection class of bug above. Upstream refuses to encode that case outright; this module does not,
// matching its behaviour before this file existed.
export function cmdQuote(value) {
  let quoted = '"';
  let backslashes = 0;
  for (const char of String(value)) {
    if (char === '\\') { backslashes += 1; continue; }
    if (char === '"') { quoted += `${'\\'.repeat(backslashes * 2)}""`; backslashes = 0; continue; }
    // %VAR% expands even inside a quoted token, so the pair must be broken: close the quote, escape
    // the percent, reopen. The backslash run is doubled first -- a quote right after a single
    // backslash is an escaped quote to CommandLineToArgvW, which would otherwise corrupt every
    // C:\Users\%USERNAME%\... path.
    if (char === '%') { quoted += `${'\\'.repeat(backslashes * 2)}"^%"`; backslashes = 0; continue; }
    quoted += `${'\\'.repeat(backslashes)}${char}`;
    backslashes = 0;
  }
  // Trailing backslashes precede the closing quote, so they need doubling too -- otherwise a path
  // ending in \ swallows the close quote as an escaped one instead of terminating the argument.
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`;
}
