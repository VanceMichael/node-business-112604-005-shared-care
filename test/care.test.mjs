import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { once } from 'node:events';

// 业务检查固定使用 2026-12-02（北京时间）的合成时段。
const T9 = '2026-12-02T09:00:00+08:00';
const T930 = '2026-12-02T09:30:00+08:00';
const T10 = '2026-12-02T10:00:00+08:00';
const T1030 = '2026-12-02T10:30:00+08:00';
const T11 = '2026-12-02T11:00:00+08:00';
const T12 = '2026-12-02T12:00:00+08:00';
const T13 = '2026-12-02T13:00:00+08:00';
const T14 = '2026-12-02T14:00:00+08:00';
const T16 = '2026-12-02T16:00:00+08:00';

async function startService(statePath, extraEnv = {}) {
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, CARE_STATE: statePath, CARE_PORT: '0', CARE_SEED: 'off', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = readline.createInterface({ input: child.stdout });
  const failed = new Promise((_, reject) => child.once('exit', (code) => reject(new Error('服务提前退出：' + code))));
  const line = await Promise.race([once(lines, 'line').then(([v]) => v), failed]);
  const base = 'http://127.0.0.1:' + JSON.parse(line).port;
  return {
    base,
    async stop() { const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended; lines.close(); },
  };
}

async function api(base, method, resource, body) {
  const r = await fetch(base + resource, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
const get = (base, resource) => api(base, 'GET', resource);
const post = (base, resource, body = {}) => api(base, 'POST', resource, body);

const member = (personId, service, level, extra = {}) => ({
  personId,
  service,
  level,
  pickupAuthorized: [],
  emergencyContacts: [{ name: '合成联系人', phone: '000' }],
  ...extra,
});

async function duty(base, worker, zone, from, until) {
  const r = await post(base, '/duties', { worker, zone, from, until });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.duty.id;
}

async function apply(base, familyId, members, from, until, together = 'separable') {
  const r = await post(base, '/applications', { familyId, from, until, together, members });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.application;
}

async function confirm(base, applicationId) {
  return post(base, `/applications/${applicationId}/confirm`, {});
}

async function applyConfirmArrive(base, familyId, m, from, until, at = T9) {
  const app = await apply(base, familyId, [m], from, until);
  const c = await confirm(base, app.id);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const bookingId = app.bookings[0].id;
  const a = await post(base, `/bookings/${bookingId}/arrivals`, { at, staffId: 'staff-1' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  return { app, bookingId };
}

async function untilOk(fn, timeout = 5000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('必须同行的申请只能整体确认；允许分别安排的逐人确认', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'care-'));
  const svc = await startService(path.join(tmp, 'state.json'));
  try {
    await duty(svc.base, 'worker-a', 'elder-room', T9, T16);
    await duty(svc.base, 'worker-c', 'child-room', T9, T16);
    // 儿童要求儿童区无人具备的 care 资质：同行申请一人也不能确认。
    const app1 = await apply(svc.base, 'family-a', [
      member('elder-a', 'elder', 'assisted'),
      member('child-a', 'child', 'toddler', { pickupAuthorized: ['guardian-a'], requiredQualifications: ['care'] }),
    ], T9, T12, 'required');
    const c1 = await confirm(svc.base, app1.id);
    assert.equal(c1.status, 422);
    const v1 = await get(svc.base, `/applications/${app1.id}`);
    assert.ok(v1.body.bookings.every((b) => b.status === 'pending'));
    // 允许分别安排：老人确认，儿童因缺少必需资质保持待确认。
    const app2 = await apply(svc.base, 'family-a', [
      member('elder-a', 'elder', 'assisted'),
      member('child-a', 'child', 'toddler', { pickupAuthorized: ['guardian-a'], requiredQualifications: ['care'] }),
    ], T13, T16, 'separable');
    const c2 = await confirm(svc.base, app2.id);
    assert.equal(c2.status, 200);
    const byPerson = Object.fromEntries(c2.body.results.map((r) => [r.personId, r]));
    assert.equal(byPerson['elder-a'].status, 'confirmed');
    assert.equal(byPerson['child-a'].status, 'pending');
    assert.ok(byPerson['child-a'].failures.some((f) => f.kind === 'qualification'));
  } finally { await svc.stop(); await rm(tmp, { recursive: true, force: true }); }
});

test('同一时段一名工作人员不能同时计入两处配比，即使两个房间都有余量', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'care-'));
  const svc = await startService(path.join(tmp, 'state.json'));
  try {
    // worker-a 的排班覆盖两个分区（老人区与儿童区同一时段）。
    await duty(svc.base, 'worker-a', 'elder-room', T9, T12);
    await duty(svc.base, 'worker-a', 'child-room', T9, T12);
    const elderApp = await apply(svc.base, 'family-a', [member('elder-a', 'elder', 'assisted')], T9, T12);
    assert.equal((await confirm(svc.base, elderApp.id)).status, 200);
    // 儿童区容量充足，但唯一候选人员已被老人区配比占用。
    const childApp = await apply(svc.base, 'family-a', [
      member('child-a', 'child', 'toddler', { pickupAuthorized: ['guardian-a'] }),
    ], T9, T12);
    const c = await confirm(svc.base, childApp.id);
    assert.equal(c.status, 200); // separable：逐人结果
    assert.equal(c.body.results[0].status, 'pending');
    assert.ok(c.body.results[0].failures.some((f) => f.kind === 'ratio'));
  } finally { await svc.stop(); await rm(tmp, { recursive: true, force: true }); }
});

test('延长时段不能挤掉之后已经确认的照护', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'care-'));
  const svc = await startService(path.join(tmp, 'state.json'));
  try {
    await duty(svc.base, 'worker-a', 'elder-room', T9, T14); // 1 名 care 人员，配比 1:2
    const appA = await apply(svc.base, 'family-a', [member('elder-a', 'elder', 'assisted')], T9, T12);
    assert.equal((await confirm(svc.base, appA.id)).status, 200);
    const appB = await apply(svc.base, 'family-b', [member('elder-b', 'elder', 'assisted')], T12, T13);
    assert.equal((await confirm(svc.base, appB.id)).status, 200);
    const appC = await apply(svc.base, 'family-b', [member('elder-c', 'elder', 'assisted')], T12, T13);
    assert.equal((await confirm(svc.base, appC.id)).status, 200); // 12-13 已有 2 名老人，满配比
    // 延长 elder-a 到 13:00 会使 12-13 变成 3 名老人，需要 2 名人员：拒绝且不改动任何预约。
    const ext = await post(svc.base, `/applications/${appA.id}/extensions`, { until: T13 });
    assert.equal(ext.status, 422);
    assert.equal((await get(svc.base, `/applications/${appA.id}`)).body.bookings[0].until, T12);
    assert.equal((await get(svc.base, `/applications/${appB.id}`)).body.bookings[0].status, 'confirmed');
    assert.equal((await get(svc.base, `/applications/${appC.id}`)).body.bookings[0].status, 'confirmed');
    // elder-b 延长到 14:00：13-14 只有 elder-b 一人，可以延长。
    const extB = await post(svc.base, `/applications/${appB.id}/extensions`, { until: T14 });
    assert.equal(extB.status, 200, JSON.stringify(extB.body));
    assert.equal(extB.body.application.bookings[0].until, T14);
  } finally { await svc.stop(); await rm(tmp, { recursive: true, force: true }); }
});

test('到站前请假或资质暂停：尚未到站的预约重新确认照护条件', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'care-'));
  const svc = await startService(path.join(tmp, 'state.json'));
  try {
    await duty(svc.base, 'worker-a', 'elder-room', T9, T12);
    const app = await apply(svc.base, 'family-a', [member('elder-a', 'elder', 'assisted')], T9, T12);
    assert.equal((await confirm(svc.base, app.id)).status, 200);
    const bookingId = app.bookings[0].id;
    // worker-a 10-12 请假 → 预约转为待重新确认，不能到站。
    const absence = await post(svc.base, '/workers/worker-a/absences', { from: T10, until: T12 });
    assert.equal(absence.status, 200);
    assert.deepEqual(absence.body.changes.reconfirmNeeded, [bookingId]);
    assert.equal((await get(svc.base, `/applications/${app.id}`)).body.bookings[0].status, 'reconfirm-needed');
    const arrival = await post(svc.base, `/bookings/${bookingId}/arrivals`, { at: T1030, staffId: 'staff-1' });
    assert.equal(arrival.status, 409);
    // 补充 worker-b 排班 → 自动恢复为已确认。
    await duty(svc.base, 'worker-b', 'elder-room', T9, T12);
    assert.equal((await get(svc.base, `/applications/${app.id}`)).body.bookings[0].status, 'confirmed');
    // 资质暂停：worker-a 的 care 暂停不影响（worker-b 在）；worker-b 也暂停则再次待确认。
    const s1 = await post(svc.base, '/workers/worker-a/qualification-suspensions', { qualification: 'care', from: T9, until: T12 });
    assert.equal(s1.status, 200);
    assert.equal((await get(svc.base, `/applications/${app.id}`)).body.bookings[0].status, 'confirmed');
    const s2 = await post(svc.base, '/workers/worker-b/qualification-suspensions', { qualification: 'care', from: T9, until: T12 });
    assert.equal(s2.body.changes.reconfirmNeeded.includes(bookingId), true);
    assert.equal((await get(svc.base, `/applications/${app.id}`)).body.bookings[0].status, 'reconfirm-needed');
  } finally { await svc.stop(); await rm(tmp, { recursive: true, force: true }); }
});

test('已到站的人预约失效不等于责任结束：缺口暴露、分区隔离、替班恢复', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'care-'));
  const svc = await startService(path.join(tmp, 'state.json'));
  try {
    await duty(svc.base, 'worker-a', 'elder-room', T9, T12);
    await duty(svc.base, 'worker-c', 'child-room', T9, T12);
    await applyConfirmArrive(svc.base, 'family-a', member('elder-a', 'elder', 'assisted'), T9, T12);
    await applyConfirmArrive(svc.base, 'family-a', member('child-a', 'child', 'toddler', { pickupAuthorized: ['guardian-a'] }), T9, T12);
    // worker-a 10-12 请假：老人区出现缺口，但 elder-a 仍在站、负责人仍是 worker-a。
    await post(svc.base, '/workers/worker-a/absences', { from: T10, until: T12 });
    const gaps = await get(svc.base, '/gaps?status=open');
    assert.equal(gaps.body.gaps.length, 1);
    assert.equal(gaps.body.gaps[0].zone, 'elder-room');
    const presence = await get(svc.base, '/persons/elder-a/presence');
    assert.equal(presence.body.onSite, true);
    assert.equal(presence.body.responsibleWorker, 'worker-a');
    // 停止受影响分区的新接收；其他独立分区不一并关停。
    const elderApp = await apply(svc.base, 'family-b', [member('elder-b', 'elder', 'assisted')], T9, T12, 'required');
    const blocked = await confirm(svc.base, elderApp.id);
    assert.equal(blocked.status, 422);
    assert.equal((await get(svc.base, `/applications/${elderApp.id}`)).body.bookings[0].status, 'pending');
    const childApp = await apply(svc.base, 'family-b', [
      member('child-b', 'child', 'toddler', { pickupAuthorized: ['guardian-c'] }),
    ], T9, T12);
    assert.equal((await confirm(svc.base, childApp.id)).status, 200);
    // 合格替班（worker-b 持 care、无其他责任）接管后缺口关闭。
    const sub = await post(svc.base, '/zones/elder-room/substitutions', { worker: 'worker-b', from: T10, until: T12 });
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    assert.equal((await get(svc.base, '/gaps?status=open')).body.gaps.length, 0);
    assert.equal((await get(svc.base, '/gaps?status=closed')).body.gaps.length, 1);
  } finally { await svc.stop(); await rm(tmp, { recursive: true, force: true }); }
});

test('替班判断结合在场人数、照护等级、原有责任与家属允许的照护范围', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'care-'));
  const svc = await startService(path.join(tmp, 'state.json'));
  try {
    await duty(svc.base, 'worker-a', 'elder-room', T9, T12);
    await duty(svc.base, 'worker-c', 'child-room', T9, T12);
    await applyConfirmArrive(svc.base, 'family-a',
      member('elder-a', 'elder', 'assisted', { careScope: { allowedWorkers: ['worker-a', 'worker-b'] } }), T9, T12);
    await applyConfirmArrive(svc.base, 'family-b',
      member('elder-b', 'elder', 'assisted', { careScope: { allowedWorkers: ['worker-a'] } }), T9, T12);
    await post(svc.base, '/workers/worker-a/absences', { from: T10, until: T12 });
    assert.equal((await get(svc.base, '/gaps?status=open')).body.gaps.length, 1);
    // worker-c 在儿童区有排班责任，不能同时接管老人区。
    const subC = await post(svc.base, '/zones/elder-room/substitutions', { worker: 'worker-c', from: T10, until: T12 });
    assert.equal(subC.status, 422);
    assert.match(subC.body.error, /排班责任/);
    // worker-b 合格且无其他责任，但不在 elder-b 家属允许的照护范围内。
    const subB = await post(svc.base, '/zones/elder-room/substitutions', { worker: 'worker-b', from: T10, until: T12 });
    assert.equal(subB.status, 422);
    assert.deepEqual(subB.body.persons, ['elder-b']);
    // 缺口保持暴露，等待值班负责人处理。
    assert.equal((await get(svc.base, '/gaps?status=open')).body.gaps.length, 1);
  } finally { await svc.stop(); await rm(tmp, { recursive: true, force: true }); }
});

test('接送授权：旧页面不能凭旧授权放人；交接后撤销留待核事项', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'care-'));
  const svc = await startService(path.join(tmp, 'state.json'));
  try {
    await duty(svc.base, 'worker-c', 'child-room', T9, T12);
    await applyConfirmArrive(svc.base, 'family-a',
      member('child-a', 'child', 'toddler', { pickupAuthorized: ['guardian-a'] }), T9, T12);
    assert.equal((await get(svc.base, '/persons/child-a/presence')).body.pickupVersion, 1);
    // 服务中家属更换授权人：guardian-a → guardian-b。
    const change = await post(svc.base, '/persons/child-a/pickup-authorizations', {
      grant: ['guardian-b'], revoke: ['guardian-a'], actor: 'guardian-a', at: T10,
    });
    assert.equal(change.status, 200);
    assert.equal(change.body.pickupVersion, 2);
    // 交接员的旧页面（版本 1）不能放人。
    const stale = await post(svc.base, '/persons/child-a/departures', {
      guardianId: 'guardian-a', staffId: 'staff-1', expectedPickupVersion: 1, at: T11,
    });
    assert.equal(stale.status, 409);
    // 刷新后旧授权人也不再有效。
    const oldGuardian = await post(svc.base, '/persons/child-a/departures', {
      guardianId: 'guardian-a', staffId: 'staff-1', expectedPickupVersion: 2, at: T11,
    });
    assert.equal(oldGuardian.status, 403);
    // 当前授权人交接成功。
    const departed = await post(svc.base, '/persons/child-a/departures', {
      guardianId: 'guardian-b', staffId: 'staff-1', expectedPickupVersion: 2, at: T11,
    });
    assert.equal(departed.status, 200);
    // 交接完成后又收到撤销授权：交接事实保留，产生待核事项。
    const late = await post(svc.base, '/persons/child-a/pickup-authorizations', { revoke: ['guardian-b'], actor: 'guardian-a', at: T12 });
    assert.equal(late.status, 200);
    assert.equal(late.body.reviewItems.length, 1);
    const items = await get(svc.base, '/review-items?status=pending');
    assert.equal(items.body.reviewItems.length, 1);
    assert.equal(items.body.reviewItems[0].kind, 'authorization-revoked-after-handover');
    assert.equal(items.body.reviewItems[0].departureId, departed.body.departure.id);
    const departures = await get(svc.base, '/persons/child-a/departures');
    assert.equal(departures.body.departures.length, 1);
    assert.equal(departures.body.departures[0].guardianId, 'guardian-b');
    const resolved = await post(svc.base, `/review-items/${items.body.reviewItems[0].id}/resolve`, { resolution: '已与家属核实', staffId: 'staff-2' });
    assert.equal(resolved.status, 200);
  } finally { await svc.stop(); await rm(tmp, { recursive: true, force: true }); }
});

test('两名员工同时为同一人交接只形成一次离站确认；流水可幂等重发', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'care-'));
  const svc = await startService(path.join(tmp, 'state.json'));
  try {
    await duty(svc.base, 'worker-c', 'child-room', T9, T12);
    await applyConfirmArrive(svc.base, 'family-a',
      member('child-a', 'child', 'toddler', { pickupAuthorized: ['guardian-a'] }), T9, T12);
    const [r1, r2] = await Promise.all([
      post(svc.base, '/persons/child-a/departures', { requestId: 'dep-1', guardianId: 'guardian-a', staffId: 'staff-1', expectedPickupVersion: 1, at: T11 }),
      post(svc.base, '/persons/child-a/departures', { requestId: 'dep-2', guardianId: 'guardian-a', staffId: 'staff-2', expectedPickupVersion: 1, at: T11 }),
    ]);
    assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
    assert.equal((await get(svc.base, '/persons/child-a/departures')).body.departures.length, 1);
    // 同流水同内容重发返回原结果，不产生第二次离站。
    const replay = await post(svc.base, '/persons/child-a/departures', { requestId: 'dep-1', guardianId: 'guardian-a', staffId: 'staff-1', expectedPickupVersion: 1, at: T11 });
    assert.equal(replay.status, 200);
    assert.equal((await get(svc.base, '/persons/child-a/departures')).body.departures.length, 1);
    // 同流水不同内容返回 409。
    const conflict = await post(svc.base, '/persons/child-a/departures', { requestId: 'dep-1', guardianId: 'guardian-a', staffId: 'staff-9', expectedPickupVersion: 1, at: T11 });
    assert.equal(conflict.status, 409);
  } finally { await svc.stop(); await rm(tmp, { recursive: true, force: true }); }
});

test('临时移到另一分区：原区不再计入该照护员，家属可查当前所在与负责人', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'care-'));
  const svc = await startService(path.join(tmp, 'state.json'));
  try {
    await duty(svc.base, 'worker-a', 'elder-room', T9, T12);
    await duty(svc.base, 'worker-b', 'elder-room', T9, T12);
    await duty(svc.base, 'worker-c', 'child-room', T9, T12);
    for (const [family, m] of [
      ['family-a', member('elder-a', 'elder', 'assisted')],
      ['family-b', member('elder-b', 'elder', 'assisted')],
      ['family-b', member('elder-c', 'elder', 'assisted')],
      ['family-b', member('elder-d', 'elder', 'assisted')],
    ]) {
      await applyConfirmArrive(svc.base, family, m, T9, T12);
    }
    await applyConfirmArrive(svc.base, 'family-a', member('child-a', 'child', 'toddler', { pickupAuthorized: ['guardian-a'] }), T9, T12);
    // 4 名老人需要 2 名照护员：此时把 worker-b 随行移走会让原区 3 名老人只剩 1 人，拒绝移动。
    const blocked = await post(svc.base, '/persons/elder-a/moves', { toZone: 'child-room', worker: 'worker-b', at: T10 });
    assert.equal(blocked.status, 422);
    assert.equal((await get(svc.base, '/persons/elder-a/presence')).body.zone, 'elder-room');
    // elder-c、elder-d 离站后，移动不再拖垮原区配比。
    await post(svc.base, '/persons/elder-c/departures', { staffId: 'staff-1', expectedPickupVersion: 1, at: T930 });
    await post(svc.base, '/persons/elder-d/departures', { staffId: 'staff-1', expectedPickupVersion: 1, at: T930 });
    const moved = await post(svc.base, '/persons/elder-a/moves', { toZone: 'child-room', worker: 'worker-b', at: T10 });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const presence = await get(svc.base, '/persons/elder-a/presence');
    assert.equal(presence.body.zone, 'child-room');
    assert.equal(presence.body.responsibleWorker, 'worker-b');
    // 10-12 原区不再把 worker-b 算在配比里，儿童区计入 worker-b。
    const q = `from=${encodeURIComponent(T10)}&until=${encodeURIComponent(T12)}`;
    const elderCoverage = await get(svc.base, `/zones/elder-room/coverage?${q}`);
    assert.deepEqual(elderCoverage.body.segments[0].workersPresent, ['worker-a']);
    assert.deepEqual(elderCoverage.body.segments[0].slots.map((s) => s.worker), ['worker-a']);
    const childCoverage = await get(svc.base, `/zones/child-room/coverage?${q}`);
    assert.ok(childCoverage.body.segments[0].workersPresent.includes('worker-b'));
    assert.deepEqual([...childCoverage.body.segments[0].people].sort(), ['child-a', 'elder-a']);
  } finally { await svc.stop(); await rm(tmp, { recursive: true, force: true }); }
});

test('重启后继续保留在场人员与每段照护责任', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'care-'));
  const statePath = path.join(tmp, 'state.json');
  let svc = await startService(statePath);
  await duty(svc.base, 'worker-a', 'elder-room', T9, T12);
  await duty(svc.base, 'worker-b', 'elder-room', T9, T12);
  await applyConfirmArrive(svc.base, 'family-a', member('elder-a', 'elder', 'assisted'), T9, T12);
  const handover = await post(svc.base, '/persons/elder-a/handovers', { toWorker: 'worker-b', at: T10 });
  assert.equal(handover.status, 200);
  await post(svc.base, '/workers/worker-a/absences', { from: T11, until: T12 });
  await post(svc.base, '/workers/worker-b/absences', { from: T11, until: T12 });
  assert.equal((await get(svc.base, '/gaps?status=open')).body.gaps.length, 1);
  await svc.stop();
  svc = await startService(statePath);
  try {
    const presence = await get(svc.base, '/persons/elder-a/presence');
    assert.equal(presence.body.onSite, true);
    assert.equal(presence.body.responsibleWorker, 'worker-b');
    const segments = (await get(svc.base, '/persons/elder-a/responsibility')).body.segments;
    assert.equal(segments.length, 2);
    assert.equal(segments[0].worker, 'worker-a');
    assert.equal(segments[0].until, T10);
    assert.equal(segments[1].worker, 'worker-b');
    assert.equal(segments[1].until, null);
    assert.equal((await get(svc.base, '/gaps?status=open')).body.gaps.length, 1);
  } finally { await svc.stop(); await rm(tmp, { recursive: true, force: true }); }
});

test('首次启动纳入既有合成排班，可用于办理', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'care-'));
  const svc = await startService(path.join(tmp, 'state.json'), { CARE_SEED: '' });
  try {
    const duties = await get(svc.base, '/duties');
    assert.equal(duties.body.duties.length, 2);
    assert.ok(duties.body.duties.some((d) => d.worker === 'worker-a' && d.zone === 'elder-room'));
    const app = await apply(svc.base, 'family-a', [member('elder-a', 'elder', 'assisted')], T9, T12);
    assert.equal((await confirm(svc.base, app.id)).status, 200);
  } finally { await svc.stop(); await rm(tmp, { recursive: true, force: true }); }
});

test('配置联调地址后，承诺变化通知家属通知接收端', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'care-'));
  const peerState = path.join(tmp, 'peer.json');
  const peerChild = spawn(process.execPath, ['support/peer.mjs'], {
    env: { ...process.env, PEER_STATE: peerState, PEER_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const peerLines = readline.createInterface({ input: peerChild.stdout });
  const peerLine = await once(peerLines, 'line').then(([v]) => v);
  const peerBase = 'http://127.0.0.1:' + JSON.parse(peerLine).port;
  const svc = await startService(path.join(tmp, 'state.json'), { CARE_PEER_URL: peerBase });
  try {
    await duty(svc.base, 'worker-a', 'elder-room', T9, T12);
    const app = await apply(svc.base, 'family-a', [member('elder-a', 'elder', 'assisted')], T9, T12);
    await confirm(svc.base, app.id);
    const headers = { 'x-peer-key': 'local-synthetic-peer' };
    await untilOk(async () => {
      const list = await fetch(peerBase + '/admin/requests', { headers }).then((r) => r.json());
      return list.find((x) => x.body.kind === 'booking-confirmed' && x.body.familyId === 'family-a');
    });
    await post(svc.base, '/workers/worker-a/absences', { from: T10, until: T12 });
    await untilOk(async () => {
      const list = await fetch(peerBase + '/admin/requests', { headers }).then((r) => r.json());
      return list.find((x) => x.body.kind === 'booking-reconfirm-needed');
    });
  } finally {
    await svc.stop();
    const ended = once(peerChild, 'exit');
    peerChild.kill('SIGTERM');
    await ended;
    peerLines.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
