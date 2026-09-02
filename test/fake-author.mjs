#!/usr/bin/env node
// Test double for the authoring model. Reads the prompt on stdin, logs it when FAKE_AUTHOR_LOG is set,
// and prints whatever recipe FAKE_AUTHOR_RECIPE holds (a JSON string) inside a json fence.
import { readFileSync, writeFileSync } from 'node:fs';
if (!process.stdin.isTTY) {
  const prompt = readFileSync(0, 'utf8');
  if (process.env.FAKE_AUTHOR_LOG) writeFileSync(process.env.FAKE_AUTHOR_LOG, prompt);
}
if (process.env.FAKE_AUTHOR_MODE === 'nofence') { console.log('I could not figure it out.'); process.exit(0); }
const recipe = process.env.FAKE_AUTHOR_RECIPE || '{}';
console.log('Here is the recipe.\n```json\n' + recipe + '\n```');
