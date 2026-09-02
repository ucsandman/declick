const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const STEP_KEYS = ['window', 'find', 'click', 'type', 'key', 'read', 'wait'];

export function buildPrompt({ window, goal, verb, desk, seed }) {
  const snap = `bash "${desk}" snapshot "${window}"`;
  const head = seed
    ? `You are repairing a desktop recipe for declick. The verb "${verb}" on window "${window}" stopped working.\nGoal of the verb: ${goal}\nLast error: ${seed.error}\nElements missing from the live tree: ${JSON.stringify(seed.diff?.missing || [])}\nElements newly present: ${JSON.stringify(seed.diff?.added || [])}\nPrevious recipe:\n\`\`\`json\n${JSON.stringify(seed.recipe, null, 2)}\n\`\`\`\nProduce a corrected recipe. Keep verb, args and description unless the goal requires otherwise.`
    : `You are authoring a desktop recipe for declick, a tool that replays deterministic UI steps so agents stop clicking.\nWindow: "${window}"\nVerb name: "${verb}"\nGoal: ${goal}`;
  return `${head}

Tools you may use: only this read-only command, as many times as you need:
  ${snap}
It prints one element per line: <indent>@eN ControlType "Name" [x,y]. Indentation is two spaces per depth level. Elements you act on must be located by a path of ControlType:Name segments from an ancestor down to the target, matched in tree order. "*" matches any name; a name ending in "*" is a prefix match. Never use coordinates or @eN refs in the recipe; they change between runs.

Recipe step vocabulary (JSON objects, in order):
  {"window": "<title substring>"}            focus the window (first step)
  {"find": ["Type:Name", ...], "as": "id"}   locate an element, remember it as id
  {"click": "id"}                            invoke it
  {"type": ["id", "text with {{arg}}"]}      set its value
  {"key": "{ENTER}"}                         send keys to the window (SendKeys syntax)
  {"read": "id", "as": "out"}                capture the element name into out
  {"wait": 300}                              sleep milliseconds
Arguments are substituted into {{name}} anywhere in a path or text. Re-find an element after acting if you need its updated name (for example a display readout).

Answer with reasoning as you like, then end with exactly one fenced json block of this shape:
\`\`\`json
{"verb": "${verb}", "description": "one line, imperative", "args": [{"name": "a"}], "mutating": false,
 "steps": [ ... ], "returns": "out",
 "example": ["value for each arg, in order"], "expect": "regex the returned value must match when run with example"}
\`\`\`
"example" and "expect" are required: declick replays the recipe once with the example values and only saves it when the returned value matches expect. Set mutating true if the verb changes application state or data. Do not include coordinates, secrets, or absolute refs.`;
}

export function parseRecipe(text) {
  const fences = [...String(text).matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  if (!fences.length) throw Object.assign(new Error('author produced no json fence'), { exit: 1 });
  try { return JSON.parse(fences[fences.length - 1][1]); }
  catch (e) { throw Object.assign(new Error(`author json did not parse: ${e.message}`), { exit: 1 }); }
}

export function validateRecipe(r) {
  const errs = [];
  if (!r || typeof r !== 'object') return ['recipe must be an object'];
  if (!KEBAB.test(r.verb || '')) errs.push('verb must be kebab-case');
  if (typeof r.description !== 'string' || !r.description) errs.push('description required');
  if (!Array.isArray(r.args)) errs.push('args must be an array');
  if (!Array.isArray(r.steps) || !r.steps.length) errs.push('steps must be a non-empty array');
  else r.steps.forEach((s, i) => {
    const keys = Object.keys(s || {}).filter(k => STEP_KEYS.includes(k));
    if (keys.length !== 1) errs.push(`steps[${i}]: unknown step ${JSON.stringify(s)}`);
    if ((s.find || s.read) && typeof s.as !== 'string') errs.push(`steps[${i}]: find and read need "as"`);
    if (s.find && (!Array.isArray(s.find) || !s.find.every(seg => typeof seg === 'string' && seg.includes(':')))) errs.push(`steps[${i}]: find must be an array of Type:Name`);
  });
  if (!Array.isArray(r.example)) errs.push('example args required');
  else if (Array.isArray(r.args) && r.example.length !== r.args.length) errs.push('example must have one value per arg');
  if (typeof r.expect !== 'string') errs.push('expect regex required');
  else { try { new RegExp(r.expect); } catch { errs.push('expect is not a valid regex'); } }
  return errs;
}
