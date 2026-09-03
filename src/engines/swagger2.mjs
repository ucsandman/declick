import { EXIT } from '../output.mjs';

const fail = (msg, exit = EXIT.ERROR) => Object.assign(new Error(msg), { exit });
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head'];
const FLOWS = { implicit: 'implicit', password: 'password', application: 'clientCredentials', accessCode: 'authorizationCode' };
const FORMISH = /x-www-form-urlencoded|multipart/;

// '#/parameters/X' and '#/responses/X' stay resolvable against the 2.0 tree; only schema refs move to 3.0 addresses.
const deref = (spec, node) => (node?.$ref?.startsWith('#/') ? node.$ref.split('/').slice(1).reduce((o, k) => o?.[k], spec) || {} : node || {});

// 2.0 puts the type inline on the parameter; 3.0 wants a schema, and a file becomes a binary string.
const schemaOf = p => p.schema ? p.schema : {
  ...(p.type === 'file' ? { type: 'string', format: 'binary' } : { ...(p.type ? { type: p.type } : {}), ...(p.format ? { format: p.format } : {}) }),
  ...(p.items ? { items: p.items } : {}), ...(p.enum ? { enum: p.enum } : {}),
  ...(p.default !== undefined ? { default: p.default } : {}), ...(p['x-example'] !== undefined ? { example: p['x-example'] } : {}),
};

function scheme3(name, d) {
  if (d.type === 'apiKey') {
    if (!['header', 'query'].includes(d.in)) throw fail(`securityDefinitions.${name}: apiKey in ${d.in} has no openapi 3 equivalent`);
    return { type: 'apiKey', in: d.in, name: d.name };
  }
  if (d.type === 'basic') return { type: 'http', scheme: 'basic' };
  if (d.type === 'oauth2') {
    const flow = FLOWS[d.flow];
    if (!flow) throw fail(`securityDefinitions.${name}: oauth2 flow ${d.flow} has no openapi 3 equivalent`);
    return { type: 'oauth2', flows: { [flow]: { ...(d.authorizationUrl ? { authorizationUrl: d.authorizationUrl } : {}), ...(d.tokenUrl ? { tokenUrl: d.tokenUrl } : {}), scopes: d.scopes || {} } } };
  }
  throw fail(`securityDefinitions.${name}: type ${d.type} has no openapi 3 equivalent`);
}

const res3 = (r, produces) => ({
  ...(r.description ? { description: r.description } : {}),
  ...(r.schema ? { content: Object.fromEntries(produces.map(c => [c, { schema: r.schema }])) } : {}),
});

function op3(spec, op, shared, path, method) {
  const params = [...shared, ...(op.parameters || []).map(p => deref(spec, p))];
  const out = { ...op };
  for (const k of ['parameters', 'consumes', 'produces', 'schemes']) delete out[k];
  const plain = []; const form = []; let bodyParam = null;
  for (const p of params) {
    if (p.in === 'body') { bodyParam = p; continue; }
    if (p.in === 'formData') { form.push(p); continue; }
    if (!['path', 'query', 'header'].includes(p.in)) throw fail(`${method.toUpperCase()} ${path}: parameter ${p.name} in ${p.in} has no openapi 3 equivalent`);
    plain.push({ name: p.name, in: p.in, ...(p.required ? { required: true } : {}), ...(p.description ? { description: p.description } : {}), schema: schemaOf(p) });
  }
  if (plain.length) out.parameters = plain;
  if (bodyParam && form.length) throw fail(`${method.toUpperCase()} ${path}: a body parameter and formData parameters cannot both be sent`);
  const consumes = op.consumes || spec.consumes || ['application/json'];
  if (bodyParam) {
    const types = consumes.filter(c => !FORMISH.test(c));
    out.requestBody = { ...(bodyParam.required ? { required: true } : {}), content: Object.fromEntries((types.length ? types : ['application/json']).map(c => [c, { schema: bodyParam.schema || {} }])) };
  }
  if (form.length) {
    const required = form.filter(p => p.required).map(p => p.name);
    const schema = { type: 'object', ...(required.length ? { required } : {}), properties: Object.fromEntries(form.map(p => [p.name, { ...schemaOf(p), ...(p.description ? { description: p.description } : {}) }])) };
    const type = form.some(p => p.type === 'file') ? 'multipart/form-data' : consumes.find(c => FORMISH.test(c)) || 'application/x-www-form-urlencoded';
    out.requestBody = { content: { [type]: { schema } } };
  }
  const produces = op.produces || spec.produces || ['application/json'];
  if (op.responses) out.responses = Object.fromEntries(Object.entries(op.responses).map(([code, r]) => [code, res3(deref(spec, r), produces)]));
  return out;
}

// https wins when a spec offers both, so a compiled adapter never defaults to plaintext.
function servers2(spec, source) {
  const base = (spec.basePath || '').replace(/\/$/, '');
  if (!spec.host) return base ? [{ url: base }] : [];
  const declared = spec.schemes?.length ? spec.schemes : [/^http:\/\//.test(String(source)) ? 'http' : 'https'];
  const order = ['https', 'http'].filter(s => declared.includes(s));
  return (order.length ? order : ['https']).map(s => ({ url: `${s}://${spec.host}${base}` }));
}

// Swagger 2.0 in, OpenAPI 3.0 out, so the openapi engine only ever compiles one shape.
export function toOpenApi3(spec, source) {
  if (!/^2\./.test(String(spec?.swagger ?? ''))) throw fail(`${source}: swagger ${JSON.stringify(spec?.swagger)} is not 2.x; declick reads openapi 3.x and swagger 2.x`);
  const s = JSON.parse(JSON.stringify(spec).replaceAll('#/definitions/', '#/components/schemas/'));
  const paths = {};
  for (const [path, item] of Object.entries(s.paths || {})) {
    const shared = (item.parameters || []).map(p => deref(s, p));
    const node = {};
    for (const [method, op] of Object.entries(item)) if (METHODS.includes(method)) node[method] = op3(s, op, shared, path, method);
    if (Object.keys(node).length) paths[path] = node;
  }
  return {
    openapi: '3.0.3', info: s.info || { title: 'api', version: '1.0.0' }, servers: servers2(s, source),
    ...(s.security ? { security: s.security } : {}), paths,
    components: { schemas: s.definitions || {}, securitySchemes: Object.fromEntries(Object.entries(s.securityDefinitions || {}).map(([k, d]) => [k, scheme3(k, d)])) },
  };
}
