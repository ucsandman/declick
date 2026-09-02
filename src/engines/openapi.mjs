import { readFileSync } from 'node:fs';

const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
const upperSnake = s => s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();

async function loadSpec(source) {
  if (/^https?:\/\//.test(source)) {
    const r = await fetch(source);
    if (!r.ok) throw new Error(`fetch ${source}: ${r.status}`);
    return r.json();
  }
  return JSON.parse(readFileSync(source, 'utf8'));
}

export async function compile(source, { name } = {}) {
  const spec = await loadSpec(source);
  const apiName = name || kebab(spec.info?.title || 'api');
  const schemes = Object.keys(spec.components?.securitySchemes || {});
  const envFor = s => `${upperSnake(apiName)}_${upperSnake(s)}`;
  const verbs = [];
  for (const [path, ops] of Object.entries(spec.paths || {})) {
    for (const [method, op] of Object.entries(ops)) {
      if (!['get', 'post', 'put', 'patch', 'delete', 'head'].includes(method)) continue;
      const params = [...(ops.parameters || []), ...(op.parameters || [])];
      const args = params.filter(p => p.in === 'path').map(p => ({ name: p.name, required: true }));
      const query = params.filter(p => p.in === 'query');
      const flags = query.map(p => ({ name: p.name, description: p.description || '' }));
      const bodySchema = op.requestBody?.content?.['application/json']?.schema;
      const bodyProps = bodySchema?.type === 'object' ? Object.keys(bodySchema.properties || {}) : [];
      if (op.requestBody) flags.unshift({ name: 'body', description: 'raw JSON body' });
      for (const p of bodyProps) flags.push({ name: p, description: bodySchema.properties[p].description || '' });
      const security = (op.security || spec.security || []).flatMap(s => Object.keys(s));
      verbs.push({
        name: kebab(op.operationId || `${method} ${path}`),
        description: (op.summary || op.description || `${method.toUpperCase()} ${path}`).slice(0, 80),
        args, flags, mutating: !['get', 'head'].includes(method),
        http: { method, path, query: query.map(p => p.name), bodyProps, security },
      });
    }
  }
  const usedSchemes = [...new Set(verbs.flatMap(v => v.http.security))].filter(s => schemes.includes(s));
  return {
    name: apiName, engine: 'openapi', source, builtAt: new Date().toISOString(),
    baseUrl: spec.servers?.[0]?.url || '',
    auth: { env: usedSchemes.map(envFor), schemes: Object.fromEntries(usedSchemes.map(s => [s, { ...spec.components.securitySchemes[s], env: envFor(s) }])) },
    verbs,
  };
}
