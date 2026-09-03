#!/usr/bin/env node
// A real MCP stdio server with zero dependencies: JSON-RPC 2.0 over stdin/stdout, newline-delimited.
// test/mcp.test.mjs spawns this as an actual child process, so nothing about the transport is mocked.
// Pass --framing content-length to answer with LSP-style framing instead of one JSON object per line.
// Pass --blob to add one more tool that answers with as many bytes as it is asked for; off by default, so the
// three-tool list every other test asserts on is unchanged.
// Pass --slow-start <ms> to hold the initialize answer for that long. This fixture starts instantly and a real
// MCP server does not, so test/daemon.test.mjs uses it to give a spawn the cost the warm pool exists to avoid.

const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const framing = arg('--framing', 'ndjson');
const slowStart = Number(arg('--slow-start', 0)) || 0;

const TOOLS = [
  {
    name: 'list_notes',
    // Two lines on purpose: declick keeps the first one only.
    description: 'List notes, newest first.\nEverything after the first line is dropped.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'only notes carrying this tag' },
        limit: { type: 'integer', description: 'how many notes to return', default: 10 },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        notes: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } } },
        total: { type: 'integer' },
      },
    },
  },
  {
    name: 'add_note',
    description: 'Add a note to the book',
    inputSchema: {
      type: 'object',
      required: ['title', 'count'],
      properties: {
        title: { type: 'string', description: 'note title' },
        count: { type: 'integer', description: 'how many copies' },
        kind: { type: 'string', enum: ['todo', 'memo'], description: 'note kind' },
        tags: { type: 'array', items: { type: 'string' }, description: 'labels' },
        meta: { type: 'object', description: 'free-form metadata' },
        pinned: { type: 'boolean', description: 'pin it to the top' },
      },
    },
  },
  { name: 'boom', description: 'Always reports a tool error', inputSchema: { type: 'object', properties: {} } },
];
if (process.argv.includes('--blob')) TOOLS.push({
  name: 'blob', description: 'Return a payload of the requested size', annotations: { readOnlyHint: true },
  inputSchema: { type: 'object', required: ['bytes'], properties: { bytes: { type: 'integer', description: 'how many bytes to return' } } },
});

const send = msg => {
  const body = JSON.stringify(msg);
  process.stdout.write(framing === 'content-length' ? `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}` : `${body}\n`);
};

function call(name, args = {}) {
  if (name === 'list_notes') {
    return {
      content: [{ type: 'text', text: '2 notes' }],
      structuredContent: { notes: [{ id: 'n1', title: 'A' }, { id: 'n2', title: 'B' }], total: 2, echo: args },
    };
  }
  if (name === 'add_note') return { content: [{ type: 'text', text: JSON.stringify({ id: 'n3', echo: args }) }] };
  if (name === 'boom') return { content: [{ type: 'text', text: 'boom: the note book is on fire' }], isError: true };
  if (name === 'blob') return { content: [{ type: 'text', text: JSON.stringify({ bytes: args.bytes, blob: 'x'.repeat(args.bytes) }) }] };
  return null;
}

function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize') {
    const answer = () => send({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'fixture-notes', version: '0.0.1' } } });
    return slowStart ? setTimeout(answer, slowStart) : answer();
  }
  if (id === undefined || id === null) return; // notification
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const result = call(params?.name, params?.arguments);
    return result
      ? send({ jsonrpc: '2.0', id, result })
      : send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${params?.name}` } });
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d;
  for (let nl; (nl = buf.indexOf('\n')) > -1;) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) try { handle(JSON.parse(line)); } catch { /* a half-written line is not fatal */ }
  }
});
process.stdin.on('end', () => process.exit(0));
