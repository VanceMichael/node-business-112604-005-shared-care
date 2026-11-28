// 老幼共托照护服务的 HTTP 接口层：路由、幂等流水、持久化与家属通知。
// 业务规则全部在 src/core.mjs；本文件只负责把请求映射到领域函数并保存状态。
import http from 'node:http';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as core from './core.mjs';

const home = path.dirname(fileURLToPath(import.meta.url));
const catalogPath = path.resolve(process.env.CARE_CATALOG || path.join(home, '../data/catalog.json'));
const recordsPath = path.resolve(process.env.CARE_RECORDS || path.join(home, '../data/records.json'));
const statePath = path.resolve(process.env.CARE_STATE || '.local/care-state.json');
const peerUrl = (process.env.CARE_PEER_URL || '').replace(/\/$/, '');
const peerKey = process.env.CARE_PEER_KEY || 'local-synthetic-peer';

const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
await mkdir(path.dirname(statePath), { recursive: true });
let state;
try { state = JSON.parse(await readFile(statePath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; state = core.createState(); }

let saveCounter = 0;
async function save() {
  // 每次写独立临时文件再改名，异步通知的保存与请求链的保存不会互相截断。
  const tmp = `${statePath}.${process.pid}.${++saveCounter}.tmp`;
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, statePath);
}

// 首次启动时把既有合成排班（records.json 中的 duty 记录）纳入可办理的初始状态。
if (!state.seeded && process.env.CARE_SEED !== 'off') {
  try {
    const records = JSON.parse(await readFile(recordsPath, 'utf8'));
    for (const record of records.records || []) {
      if (record.kind !== 'duty') continue;
      const { worker, zone, from, until } = record.payload || {};
      if (!catalog.workers.some((w) => w.id === worker) || !catalog.zones.some((z) => z.id === zone)) continue;
      const id = core.nextId(state, 'duty');
      state.duties[id] = { id, worker, zone, from, until, status: 'active', seededFrom: record.recordId };
    }
  } catch { /* 记录文件可选，缺失不影响启动 */ }
  state.seeded = true;
  await save();
}

const now = () => new Date().toISOString();

// 家属通知：配置 CARE_PEER_URL 后，把承诺变化投递给家属通知接收端；失败不阻塞业务。
function sendNotify(payload) {
  if (!peerUrl) return;
  const id = core.nextId(state, 'notice');
  const record = { id, ...payload, requestId: id, status: 'sending', createdAt: now() };
  state.notices[id] = record;
  fetch(`${peerUrl}/operations/notify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-peer-key': peerKey },
    body: JSON.stringify({ requestId: id, ...payload }),
  }).then(async (r) => {
    record.status = r.ok ? 'sent' : 'failed';
    record.receipt = await r.json().catch(() => null);
  }).catch((error) => {
    record.status = 'failed';
    record.error = String((error && error.message) || error);
  }).finally(() => save().catch(() => {}));
}

function deriveNotifications(result) {
  const out = [...(result.notifications || [])];
  for (const id of result.changes?.reconfirmNeeded || []) {
    const b = state.bookings[id];
    if (b) out.push({ kind: 'booking-reconfirm-needed', familyId: b.familyId, personId: b.personId, bookingId: id });
  }
  for (const id of result.changes?.restored || []) {
    const b = state.bookings[id];
    if (b) out.push({ kind: 'booking-restored', familyId: b.familyId, personId: b.personId, bookingId: id });
  }
  return out;
}

const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;

const fingerprintOf = (method, path, body) => {
  const rest = { ...(body || {}) };
  delete rest.requestId;
  return createHash('sha256').update(JSON.stringify(stable({ method, path, body: rest }))).digest('hex');
};

function reply(response, code, body) {
  response.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function bodyOf(request) {
  let data = '';
  for await (const chunk of request) {
    data += chunk;
    if (data.length > 1024 * 1024) throw new Error('请求过大');
  }
  return JSON.parse(data || '{}');
}

const routes = [];
const route = (method, pattern, handler) =>
  routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
const notFound = (message) => ({ status: 404, body: { error: message } });

route('GET', '/health', () => ({ status: 200, body: { name: '老幼共托照护服务', ok: true } }));

// 家属：申请、查询承诺、延长、接送授权、在场查询。
route('POST', '/applications', ({ body }) => core.createApplication(state, catalog, body, now()));
route('GET', '/applications/:id', ({ params }) => state.applications[params.id]
  ? { status: 200, body: core.applicationView(state, params.id) } : notFound('申请不存在'));
route('POST', '/applications/:id/extensions', ({ params, body }) => core.extendApplication(state, catalog, params.id, body, now()));
route('GET', '/families/:id/applications', ({ params }) => ({ status: 200, body: { applications: core.listApplicationsByFamily(state, params.id) } }));
route('POST', '/persons/:id/pickup-authorizations', ({ params, body }) => core.changePickupAuthorization(state, catalog, params.id, body, now()));
route('GET', '/persons/:id/pickup-changes', ({ params }) => ({ status: 200, body: { changes: core.pickupChangesOf(state, params.id) } }));
route('GET', '/persons/:id/presence', ({ params }) => {
  const view = core.presenceView(state, params.id);
  return view ? { status: 200, body: view } : notFound('没有该人员的预约');
});

// 站点：受理确认、重新确认、到离站登记、临时交接与移动、替班。
route('POST', '/applications/:id/confirm', ({ params }) => core.confirmApplication(state, catalog, params.id, now()));
route('GET', '/bookings/:id', ({ params }) => state.bookings[params.id]
  ? { status: 200, body: core.bookingView(state, state.bookings[params.id]) } : notFound('预约不存在'));
route('POST', '/bookings/:id/reconfirm', ({ params }) => core.reconfirmBooking(state, catalog, params.id, now()));
route('POST', '/bookings/:id/arrivals', ({ params, body }) => core.arrive(state, catalog, params.id, body, now()));
route('POST', '/persons/:id/handovers', ({ params, body }) => core.handover(state, catalog, params.id, body, now()));
route('POST', '/persons/:id/moves', ({ params, body }) => core.movePerson(state, catalog, params.id, body, now()));
route('POST', '/persons/:id/departures', ({ params, body }) => core.depart(state, catalog, params.id, body, now()));
route('GET', '/persons/:id/departures', ({ params }) => ({ status: 200, body: { departures: core.departuresOf(state, params.id) } }));
route('GET', '/persons/:id/responsibility', ({ params }) => ({ status: 200, body: { segments: core.responsibilityOf(state, params.id) } }));

// 站点：排班、请假、资质暂停、替班、覆盖核查。
route('POST', '/duties', ({ body }) => core.addDuty(state, catalog, body, now()));
route('GET', '/duties', () => ({ status: 200, body: { duties: Object.values(state.duties) } }));
route('POST', '/duties/:id/cancel', ({ params }) => core.cancelDuty(state, catalog, params.id, now()));
route('POST', '/workers/:id/absences', ({ params, body }) => core.addAbsence(state, catalog, params.id, body, now()));
route('POST', '/workers/:id/qualification-suspensions', ({ params, body }) => core.addSuspension(state, catalog, params.id, body, now()));
route('POST', '/zones/:id/substitutions', ({ params, body }) => core.substitute(state, catalog, params.id, body, now()));
route('GET', '/zones/:id/coverage', ({ params, query }) => {
  if (!catalog.zones.some((z) => z.id === params.id)) return notFound('分区不存在');
  const view = core.coverageView(state, catalog, params.id, query.get('from'), query.get('until'));
  return view ? { status: 200, body: view } : { status: 422, body: { error: '需要有效的 from/until 查询参数' } };
});

// 值班负责人：缺口与待核事项。
route('GET', '/gaps', ({ query }) => ({ status: 200, body: { gaps: core.gapsOf(state, query.get('status')) } }));
route('GET', '/review-items', ({ query }) => ({ status: 200, body: { reviewItems: core.reviewItemsOf(state, query.get('status')) } }));
route('POST', '/review-items/:id/resolve', ({ params, body }) => core.resolveReviewItem(state, params.id, body, now()));
route('GET', '/notices', () => ({ status: 200, body: { notices: Object.values(state.notices) } }));

function matchRoute(method, segments) {
  for (const r of routes) {
    if (r.method !== method || r.parts.length !== segments.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < r.parts.length; i++) {
      if (r.parts[i].startsWith(':')) params[r.parts[i].slice(1)] = segments[i];
      else if (r.parts[i] !== segments[i]) { matched = false; break; }
    }
    if (matched) return { handler: r.handler, params };
  }
  return null;
}

// 所有变更串行执行：同一人员的并发交接只会形成一次离站确认；
// 可选 requestId 提供幂等流水——同流水同内容重发返回原结果，同流水不同内容返回 409。
let serial = Promise.resolve();
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const matched = matchRoute(request.method, segments);
  if (!matched) return reply(response, 404, { error: '路径不存在' });
  if (request.method === 'GET') {
    try {
      const result = matched.handler({ params: matched.params, query: url.searchParams });
      return reply(response, result.status, result.body);
    } catch {
      return reply(response, 500, { error: '服务处理失败' });
    }
  }
  const run = serial.then(async () => {
    let body;
    try { body = await bodyOf(request); }
    catch (error) { return reply(response, error instanceof SyntaxError ? 400 : 413, { error: error instanceof SyntaxError ? 'JSON 格式无效' : '请求过大' }); }
    const requestId = body?.requestId;
    if (requestId !== undefined && (typeof requestId !== 'string' || !/^[\w.-]{1,100}$/.test(requestId))) {
      return reply(response, 422, { error: '需要稳定流水号' });
    }
    const fingerprint = fingerprintOf(request.method, url.pathname, body);
    if (requestId) {
      const existing = state.idempotency[requestId];
      if (existing) {
        if (existing.fingerprint !== fingerprint) return reply(response, 409, { error: '流水号已用于其他请求' });
        return reply(response, existing.status, existing.body);
      }
    }
    const result = await matched.handler({ params: matched.params, body: body || {}, query: url.searchParams });
    if (requestId) state.idempotency[requestId] = { fingerprint, status: result.status, body: result.body };
    await save();
    for (const notice of deriveNotifications(result)) sendNotify(notice);
    return reply(response, result.status, result.body);
  });
  serial = run.catch((error) => {
    console.error(error);
    if (!response.headersSent) reply(response, 500, { error: '服务处理失败' });
  });
});

server.listen(Number(process.env.CARE_PORT || 4400), process.env.CARE_HOST || '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ message: '老幼共托照护服务已启动', port: server.address().port }) + '\n');
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
