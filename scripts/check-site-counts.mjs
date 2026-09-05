#!/usr/bin/env node
// Site-count drift gate: declick.dev states a command count, an engine count and a benchmark multiplier as
// prose ("Ten engines", "All 35 commands", "4.1x"); nothing enforced they track their sources, and they drifted
// (the site once said 13 engines while src/engines/index.mjs had 10). This derives each number from its real
// source and asserts every place a site page repeats it still matches: `declick commands --json` (never a
// source-file regex, so a command registered any other way still counts), the real ENGINE_INFO module (never a
// directory listing under src/engines), and docs/bench.md's own TOTAL row. Wired into `npm run qa` (which
// publish.yml runs on every tag) and into `npm test` as a node test, so drift is caught before either.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE_DIR = join(ROOT, 'site');
const siteFiles = readdirSync(SITE_DIR).filter(f => f.endsWith('.html') || f === 'llms.txt');
const siteText = f => readFileSync(join(SITE_DIR, f), 'utf8');

// -- real command count: the compiled CLI's own `commands --json`, built from the COMMANDS array that every
// C(...) call in bin/declick.mjs populates, never a regex over that file.
function realCommandCount() {
  const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'declick.mjs'), 'commands', '--json', '--limit', '100'], { encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0) throw new Error(`declick commands --json exited ${r.status}: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  // A future 100+ command table would silently undercount here (data.length would stop at --limit 100
  // while the real total kept growing); fail loudly instead of reporting a truncated count as real.
  if (parsed.meta?.truncated) throw new Error('declick commands --json truncated at --limit 100 (meta.truncated=true); raise the --limit above so realCommandCount() is not undercounting');
  return parsed.data.length;
}

// -- real engine count: the actual ENGINE_INFO module, imported (not a directory listing under src/engines,
// which would also count non-engine helper files).
function realEngineCount() {
  const script = "import { pathToFileURL } from 'node:url'; const { ENGINE_INFO } = await import(pathToFileURL(process.argv[1]).href); process.stdout.write(String(ENGINE_INFO.length));";
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, join(ROOT, 'src', 'engines', 'index.mjs')], { encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0) throw new Error(`could not import src/engines/index.mjs: ${r.stderr}`);
  return Number(r.stdout.trim());
}

// -- real benchmark numbers: every row of docs/bench.md's table (each per-adapter row and the TOTAL row), not
// just TOTAL, so a site page restating one adapter's own figures (site/mcp-vs-cli.html's per-row table) is
// checked against the same source as the aggregate. Also the one-off `--call` verification ratio stated in
// bench.md's prose (fs: 160 raw bytes vs 191 declick bytes) — a different comparison than the table, and the
// source of site/index.html's "0.8x on the fs server" claim.
function realBenchRows() {
  const md = readFileSync(join(ROOT, 'docs', 'bench.md'), 'utf8');
  const re = /^\|\s*(?:\*\*)?([A-Za-z0-9_-]+)(?:\*\*)?\s*\|\s*(?:\*\*)?([\d,]+)(?:\*\*)?\s*\|\s*(?:\*\*)?([\d,]+)\s*\(~[\d,]+t\)(?:\*\*)?\s*\|\s*(?:\*\*)?([\d,]+)\s*\(~[\d,]+t\)(?:\*\*)?\s*\|\s*(?:\*\*)?([\d,]+)\s*\(~[\d,]+t\)(?:\*\*)?\s*\|\s*(?:\*\*)?([\d.]+)x(?:\*\*)?\s*\|$/gm;
  const rows = [...md.matchAll(re)].map(m => ({ adapter: m[1], tools: m[2], raw: m[3], describe: m[4], verb: m[5], ratio: m[6] }));
  if (rows.length === 0) throw new Error('docs/bench.md table rows not found in the expected shape');
  return rows;
}

function realBenchTotal() {
  const total = realBenchRows().find(r => r.adapter === 'TOTAL');
  if (!total) throw new Error('docs/bench.md TOTAL row not found in the expected shape');
  return { tools: total.tools, raw: total.raw, declick: total.describe, ratio: total.ratio };
}

function realBenchCallRatio() {
  const md = readFileSync(join(ROOT, 'docs', 'bench.md'), 'utf8');
  const m = md.match(/came back ([\d,]+) raw bytes vs ([\d,]+) for/);
  if (!m) throw new Error('docs/bench.md --call verification sentence not found in the expected shape');
  return (Number(m[1].replace(/,/g, '')) / Number(m[2].replace(/,/g, ''))).toFixed(1);
}

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen'];
const numberFor = w => { const i = WORDS.indexOf(String(w).toLowerCase()); return i === -1 ? Number(String(w).replace(/,/g, '')) : i; };

// Every place a site page states the engine count in words: the hero line, any "across all N engines"
// claim (site/index.html and site/controls.html both make one), and llms.txt's "compiles any of N sources"
// framing (the same ten engines, named as source kinds rather than as "engines").
function engineWordClaims() {
  const out = [];
  for (const f of siteFiles) {
    const t = siteText(f);
    for (const m of t.matchAll(/\b([A-Za-z]+) engines, zero runtime dependencies\b/gi)) out.push({ file: f, text: m[0], value: m[1] });
    for (const m of t.matchAll(/across all ([a-z]+) engines/gi)) out.push({ file: f, text: m[0], value: m[1] });
    for (const m of t.matchAll(/\bany of ([a-z]+) sources\b/gi)) out.push({ file: f, text: m[0], value: m[1] });
  }
  return out;
}

// site/index.html's own arithmetic: "Start with four engines. Six more are compiled in." must sum to the
// real total whichever four (or six) it names.
function engineSplitClaims() {
  const out = [];
  for (const f of siteFiles) for (const m of siteText(f).matchAll(/Start with ([a-z]+) engines\. ([A-Za-z]+) more are compiled in/gi)) out.push({ file: f, text: m[0], first: m[1], second: m[2] });
  return out;
}

function commandCountClaims() {
  const out = [];
  for (const f of siteFiles) {
    const t = siteText(f);
    for (const m of t.matchAll(/\bAll (\d+) commands\b/g)) out.push({ file: f, text: m[0], value: m[1] });
    // The second command-count claim on site/index.html: the worked example of `declick commands --json`'s
    // own envelope, which restates the count as `"meta":{"count":N` rather than prose.
    for (const m of t.matchAll(/<code>declick commands --json<\/code> returns <code>"meta":\{"count":(\d+)/g)) out.push({ file: f, text: m[0], value: m[1] });
    // llms.txt's own phrasing: "declick's own N commands honor the same contract".
    for (const m of t.matchAll(/\bown (\d+) commands\b/g)) out.push({ file: f, text: m[0], value: m[1] });
  }
  return out;
}

// The bench-tokens.mjs summary row, however it is labelled ("combined" on site/index.html, "total" on
// site/mcp-vs-cli.html): tools, raw bytes, declick bytes and the ratio, skipping the optional describe --verb
// column some pages add.
function benchClaims() {
  const out = [];
  const re = /\b(?:combined|total)\s+(\d+)\s+([\d,]+) bytes\s+([\d,]+) bytes(?:\s+[\d,]+ bytes)?\s+([\d.]+)x/gi;
  for (const f of siteFiles) for (const m of siteText(f).matchAll(re)) out.push({ file: f, text: m[0], tools: m[1], raw: m[2], declick: m[3], ratio: m[4] });
  return out;
}

// Any 5-6 digit byte figure, any N.Nx ratio, or any 2-3 digit "N tools" claim, anywhere on any site page --
// not just the tabular summary rows benchClaims() matches. Catches a retyped number in lead prose, a meta
// description, an OG tag or a JSON-LD block, none of which repeat the "combined"/"total" label benchClaims()
// anchors on (site/mcp-vs-cli.html restates 258 tools / 236,818 bytes / 58,309 bytes four times before its
// table even starts). The comma-grouped byte pattern is deliberately 5-6 digits: it excludes plain 3-digit
// figures with no thousands separator (192, 330, 160, 191 bytes elsewhere on the site, none of which retype a
// bench.md row) and the rounded "near 1,100 bytes" prose (a 1-digit thousands group), which is an
// approximation, not a retyped figure.
function benchNumberClaims() {
  const out = [];
  for (const f of siteFiles) {
    const t = siteText(f);
    for (const m of t.matchAll(/\b(\d{2,3},\d{3}) bytes\b/g)) out.push({ file: f, kind: 'bytes', text: m[0], value: m[1] });
    for (const m of t.matchAll(/\b(\d+\.\d)x\b/g)) out.push({ file: f, kind: 'ratio', text: m[0], value: m[1] });
    for (const m of t.matchAll(/\b(\d{2,3}) tools\b/g)) out.push({ file: f, kind: 'tools', text: m[0], value: m[1] });
  }
  return out;
}

// Running total across every test in this file, so one line beside the final verdict answers "how much of
// the site did this actually check" instead of a bare pass/fail per test hiding a zero-claim category.
// `tally` counts one claim as failed on its first mismatch (matching assert's own behaviour) but keeps
// going through the rest of the claims in its list, so a real drift is reported once per offending claim
// instead of stopping the whole test at the first one.
let totalChecked = 0, totalPass = 0, totalFail = 0;
function tally(claims, check) {
  const failures = [];
  for (const c of claims) {
    totalChecked++;
    try { check(c); totalPass++; }
    catch (e) { totalFail++; failures.push(e.message); }
  }
  return failures;
}

test('site pages state the real command count', () => {
  const real = realCommandCount();
  const claims = commandCountClaims();
  console.log(`command-count claims scanned=${claims.length} real=${real}`);
  assert.ok(claims.length > 0, 'no "All N commands" claim found on any site page');
  const failures = tally(claims, c => assert.equal(Number(c.value), real, `${c.file}: "${c.text}" claims ${c.value} commands, declick commands --json has ${real}`));
  assert.equal(failures.length, 0, failures.join('\n'));
});

test('site pages state the real engine count', () => {
  const real = realEngineCount();
  const claims = engineWordClaims();
  console.log(`engine-count claims scanned=${claims.length} real=${real}`);
  assert.ok(claims.length > 0, 'no engine-count claim found on any site page');
  const wordFailures = tally(claims, c => assert.equal(numberFor(c.value), real, `${c.file}: "${c.text}" claims ${c.value} engines, ENGINE_INFO has ${real}`));

  const splits = engineSplitClaims();
  console.log(`engine-split claims scanned=${splits.length} real=${real}`);
  assert.ok(splits.length > 0, 'no "Start with N engines. M more are compiled in" claim found on any site page');
  const splitFailures = tally(splits, c => assert.equal(numberFor(c.first) + numberFor(c.second), real, `${c.file}: "${c.text}" sums to ${numberFor(c.first) + numberFor(c.second)}, ENGINE_INFO has ${real}`));

  assert.equal(wordFailures.length + splitFailures.length, 0, [...wordFailures, ...splitFailures].join('\n'));
});

test('site pages state the real docs/bench.md benchmark', () => {
  const real = realBenchTotal();
  const claims = benchClaims();
  console.log(`benchmark claims scanned=${claims.length} real=tools:${real.tools} raw:${real.raw} declick:${real.declick} ratio:${real.ratio}x`);
  assert.ok(claims.length > 0, 'no benchmark summary row found on any site page');
  const failures = tally(claims, c => {
    assert.equal(c.tools, real.tools, `${c.file}: "${c.text}" tools`);
    assert.equal(c.raw, real.raw, `${c.file}: "${c.text}" raw bytes`);
    assert.equal(c.declick, real.declick, `${c.file}: "${c.text}" declick bytes`);
    assert.equal(c.ratio, real.ratio, `${c.file}: "${c.text}" ratio`);
  });
  assert.equal(failures.length, 0, failures.join('\n'));
});

test('every 5-6 digit byte / N.Nx ratio / N tools claim anywhere on the site is a real docs/bench.md number', () => {
  const rows = realBenchRows();
  const byteSet = new Set(rows.flatMap(r => [r.raw, r.describe, r.verb]));
  const ratioSet = new Set(rows.map(r => r.ratio));
  ratioSet.add(realBenchCallRatio());
  const toolSet = new Set(rows.map(r => r.tools));
  const claims = benchNumberClaims();
  console.log(`benchmark-number claims scanned=${claims.length} rows=${rows.length} legal_bytes=${byteSet.size} legal_ratios=${ratioSet.size} legal_tools=${toolSet.size}`);
  assert.ok(claims.length > 0, 'no 5-6 digit byte / N.Nx ratio / N tools claim found on any site page');
  const setFor = { bytes: byteSet, ratio: ratioSet, tools: toolSet };
  const labelFor = { bytes: 'byte figures', ratio: 'ratios', tools: 'tool counts' };
  const failures = tally(claims, c => assert.ok(setFor[c.kind].has(c.value), `${c.file}: "${c.text}" (${c.kind}) is ${c.value}, not one of docs/bench.md's real ${labelFor[c.kind]}`));
  assert.equal(failures.length, 0, failures.join('\n'));
});

after(() => { console.log(`checked=${totalChecked} pass=${totalPass} fail=${totalFail}`); });
