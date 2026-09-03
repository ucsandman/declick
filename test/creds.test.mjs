import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { mintHint } from '../src/creds.mjs';

const savedPath = process.env.PATH;

test('mintHint is silent when no creds executable is on PATH', () => {
  process.env.PATH = mkdtempSync(join(tmpdir(), 'declick-nocreds-'));
  assert.equal(mintHint('stripe'), '');
});

test('mintHint appends the hint once a creds executable resolves on PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'declick-creds-'));
  const name = process.platform === 'win32' ? 'creds.cmd' : 'creds';
  const bin = join(dir, name);
  writeFileSync(bin, process.platform === 'win32' ? '@echo off\r\n' : '#!/usr/bin/env bash\n');
  if (process.platform !== 'win32') chmodSync(bin, 0o755);
  process.env.PATH = dir + delimiter + savedPath;
  assert.equal(mintHint('stripe'), ' (or run: creds mint stripe)');
});
