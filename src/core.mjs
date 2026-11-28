// 老幼共托照护承诺与交接的领域逻辑。
// 所有函数直接修改传入的 state（由调用方负责持久化），返回 { status, body, ... } 供 HTTP 层映射。
// 时间一律为 ISO 字符串，比较按毫秒值；时段为左闭右开 [from, until)。

const T = (s) => Date.parse(s);
const iso = (t) => new Date(t).toISOString();
const overlaps = (af, au, bf, bu) => T(af) < T(bu) && T(bf) < T(au);
const validTime = (s) => typeof s === 'string' && Number.isFinite(T(s));

// 占用容量与配比的预约状态：已确认、待重新确认（位置仍保留）、已到站。
export const OCCUPYING = new Set(['confirmed', 'reconfirm-needed', 'arrived']);
// 临时移动的安全核查不纳入待重新确认的预约（它们本身已待处理，不应阻挡安全调整）。
const CONFIRMED_AND_ARRIVED = new Set(['confirmed', 'arrived']);
const ARRIVED = new Set(['arrived']);
const PICKUP_CHANGEABLE = ['confirmed', 'reconfirm-needed', 'arrived', 'departed'];

const err = (status, message, extra = {}) => ({ status, body: { error: message, ...extra } });
const ok = (body = {}) => ({ status: 200, body: { ok: true, ...body } });

export function createState() {
  return {
    version: 1,
    seeded: false,
    counters: {},
    applications: {},
    bookings: {},
    duties: {},
    absences: {},
    suspensions: {},
    assignments: {},
    gaps: {},
    departures: {},
    pickupChanges: {},
    responsibility: {},
    reviewItems: {},
    idempotency: {},
    notices: {},
  };
}

export function nextId(state, kind) {
  state.counters[kind] = (state.counters[kind] || 0) + 1;
  return `${kind}-${state.counters[kind]}`;
}

const ratioFor = (catalog, service, level) =>
  catalog.ratios.find((r) => r.service === service && r.level === level) || null;

const personView = (b, zone) => ({
  bookingId: b.id,
  personId: b.personId,
  service: b.service,
  level: b.level,
  requiredQualifications: b.requiredQualifications || [],
  careScope: b.careScope || null,
  zone,
});

// ---------- 时段切片与照护条件核查 ----------

// 把 [from, until) 按所有相关边界（排班、请假、资质暂停、临时安排、预约分区段、候选人员）切成
// 条件恒定的小段，每段内排班/请假/暂停/在场人员都不会变化。
function collectSegments(state, from, until, extras = []) {
  const lo = T(from);
  const hi = T(until);
  const points = new Set([lo, hi]);
  const add = (v) => {
    const t = T(v);
    if (Number.isFinite(t) && t > lo && t < hi) points.add(t);
  };
  for (const d of Object.values(state.duties)) if (d.status === 'active') { add(d.from); add(d.until); }
  for (const a of Object.values(state.absences)) { add(a.from); add(a.until); }
  for (const s of Object.values(state.suspensions)) { add(s.from); add(s.until); }
  for (const a of Object.values(state.assignments)) if (a.status === 'active') { add(a.from); add(a.until); }
  for (const b of Object.values(state.bookings)) {
    if (OCCUPYING.has(b.status)) for (const zs of b.zoneSegments) { add(zs.from); add(zs.until); }
  }
  for (const e of extras) { add(e.from); add(e.until); }
  const sorted = [...points].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < sorted.length; i++) out.push([sorted[i], sorted[i + 1]]);
  return out;
}

// 工作人员在某一切片内的有效所在：排班可覆盖多个分区，但临时安排（替班/随行移动）优先；
// 同一时刻一名工作人员只能计入一个分区的配比。请假则在任何分区都不可用。
function workerPresence(state, catalog, s, e) {
  const presence = new Map();
  for (const w of catalog.workers) {
    presence.set(w.id, { zones: new Set(), absent: false, suspended: new Set(), qualifications: w.qualifications });
  }
  for (const d of Object.values(state.duties)) {
    if (d.status !== 'active') continue;
    if (T(d.from) < e && s < T(d.until)) presence.get(d.worker)?.zones.add(d.zone);
  }
  const redirected = new Map();
  for (const a of Object.values(state.assignments)) {
    if (a.status !== 'active') continue;
    if (T(a.from) < e && s < T(a.until)) {
      if (!redirected.has(a.worker)) redirected.set(a.worker, new Set());
      redirected.get(a.worker).add(a.zone);
    }
  }
  for (const [worker, zones] of redirected) {
    const p = presence.get(worker);
    if (p) p.zones = zones;
  }
  for (const ab of Object.values(state.absences)) {
    if (T(ab.from) < e && s < T(ab.until)) {
      const p = presence.get(ab.worker);
      if (p) p.absent = true;
    }
  }
  for (const su of Object.values(state.suspensions)) {
    if (T(su.from) < e && s < T(su.until)) presence.get(su.worker)?.suspended.add(su.qualification);
  }
  return presence;
}

function occupyingPeople(state, s, e, statuses) {
  const out = [];
  for (const b of Object.values(state.bookings)) {
    if (!statuses.has(b.status)) continue;
    for (const zs of b.zoneSegments) {
      if (T(zs.from) < e && s < T(zs.until)) { out.push({ booking: b, zone: zs.zone }); break; }
    }
  }
  return out;
}

// 为每个配比名额分配一名不同的合格工作人员（回溯匹配；名额与人员都是小数目）。
// 全局唯一约束保证一名工作人员同一时段不会同时计入两处配比。
function matchSlots(slots, candidatesOf) {
  const cand = new Map(slots.map((s) => [s.id, candidatesOf(s)]));
  const order = [...slots].sort((a, b) => cand.get(a.id).length - cand.get(b.id).length);
  const used = new Set();
  const assignment = new Map();
  const visit = (i) => {
    if (i === order.length) return true;
    const slot = order[i];
    for (const w of cand.get(slot.id)) {
      if (used.has(w)) continue;
      used.add(w);
      assignment.set(slot.id, w);
      if (visit(i + 1)) return true;
      used.delete(w);
      assignment.delete(slot.id);
    }
    return false;
  };
  return visit(0) ? assignment : null;
}

// 单一切片内：容量、各服务等级的配比名额、必须具备的资质、家属允许的照护范围。
function checkSegment(catalog, presence, people) {
  const failures = [];
  const byZone = new Map();
  for (const p of people) {
    if (!byZone.has(p.zone)) byZone.set(p.zone, []);
    byZone.get(p.zone).push(p);
  }
  const slots = [];
  for (const [zoneId, list] of byZone) {
    const zone = catalog.zones.find((z) => z.id === zoneId);
    if (!zone) { failures.push({ kind: 'unknown-zone', zone: zoneId }); continue; }
    if (list.length > zone.capacity) {
      failures.push({ kind: 'capacity', zone: zoneId, count: list.length, capacity: zone.capacity });
    }
    const groups = new Map();
    for (const p of list) {
      const key = `${p.service}|${p.level}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    for (const members of groups.values()) {
      const ratio = ratioFor(catalog, members[0].service, members[0].level);
      if (!ratio) {
        failures.push({ kind: 'no-ratio', zone: zoneId, service: members[0].service, level: members[0].level });
        continue;
      }
      const needed = Math.ceil(members.length / ratio.peoplePerWorker);
      for (let i = 0; i < needed; i++) {
        slots.push({ id: slots.length, zone: zoneId, qual: ratio.qualification, group: `${members[0].service}|${members[0].level}` });
      }
    }
  }
  const candidatesOf = (slot) => [...presence.entries()]
    .filter(([, p]) => !p.absent && p.zones.has(slot.zone) && p.qualifications.includes(slot.qual) && !p.suspended.has(slot.qual))
    .map(([id]) => id);
  const assignment = matchSlots(slots, candidatesOf);
  if (!assignment) {
    const zones = [...new Set(slots.map((s) => s.zone))];
    // 缺口归因：独立匹配仍失败的分区必然缺人；若各分区单独都能满足、
    // 合起来才冲突（争夺同一人员），则相关分区都暴露缺口。
    const failingAlone = zones.filter((z) => !matchSlots(slots.filter((s) => s.zone === z), candidatesOf));
    const available = [...presence.entries()].filter(([, p]) => !p.absent).map(([id]) => id);
    failures.push({
      kind: 'ratio',
      zones: failingAlone.length ? failingAlone : zones,
      neededSlots: slots.length,
      availableWorkers: available.length,
    });
  }
  for (const [zoneId, list] of byZone) {
    const present = [...presence.entries()].filter(([, p]) => !p.absent && p.zones.has(zoneId));
    for (const qual of new Set(list.flatMap((p) => p.requiredQualifications || []))) {
      const covered = present.some(([, p]) => p.qualifications.includes(qual) && !p.suspended.has(qual));
      if (!covered) failures.push({ kind: 'qualification', zone: zoneId, qualification: qual });
    }
    for (const p of list) {
      const allowed = p.careScope?.allowedWorkers;
      if (allowed?.length && !present.some(([id]) => allowed.includes(id))) {
        failures.push({ kind: 'care-scope', zone: zoneId, person: p.personId });
      }
    }
  }
  return { failures, slots, assignment };
}

// 对整个窗口逐段核查；extras 为尚未落库的候选人员（申请确认、延长、移动时的假设对象）。
export function checkWindow(state, catalog, from, until, { extras = [], statuses = OCCUPYING } = {}) {
  const failures = [];
  for (const [s, e] of collectSegments(state, from, until, extras)) {
    const presence = workerPresence(state, catalog, s, e);
    const people = occupyingPeople(state, s, e, statuses).map((x) => personView(x.booking, x.zone));
    for (const ex of extras) if (T(ex.from) < e && s < T(ex.until)) people.push(ex);
    const result = checkSegment(catalog, presence, people);
    for (const f of result.failures) failures.push({ segment: [iso(s), iso(e)], ...f });
  }
  return failures;
}

// ---------- 照护条件重估：排班/请假/资质变化后调用 ----------

// 未到站的预约重新确认照护条件；已到站的人不改动预约状态，而是暴露缺口。
export function reevaluate(state, catalog, now) {
  const changes = { reconfirmNeeded: [], restored: [], gapsOpened: [], gapsClosed: [] };
  for (const b of Object.values(state.bookings)) {
    if (b.status !== 'confirmed' && b.status !== 'reconfirm-needed') continue;
    const failures = checkWindow(state, catalog, b.from, b.until);
    if (failures.length) {
      if (b.status !== 'reconfirm-needed') changes.reconfirmNeeded.push(b.id);
      b.status = 'reconfirm-needed';
      b.reconfirmReason = { message: '排班、请假或资质变化导致照护条件不再满足，需重新确认', failures: failures.slice(0, 5) };
    } else if (b.status === 'reconfirm-needed') {
      b.status = 'confirmed';
      b.reconfirmReason = null;
      changes.restored.push(b.id);
    }
  }
  // 已到站的人：预约失效不等于责任结束，缺口按分区暴露给值班负责人。
  const arrived = Object.values(state.bookings).filter((b) => b.status === 'arrived');
  const failingByZone = new Map();
  if (arrived.length) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const b of arrived) for (const zs of b.zoneSegments) {
      lo = Math.min(lo, T(zs.from));
      hi = Math.max(hi, T(zs.until));
    }
    for (const [s, e] of collectSegments(state, iso(lo), iso(hi))) {
      const presence = workerPresence(state, catalog, s, e);
      const people = occupyingPeople(state, s, e, ARRIVED).map((x) => personView(x.booking, x.zone));
      if (!people.length) continue;
      const { failures } = checkSegment(catalog, presence, people);
      for (const f of failures) {
        for (const z of f.zones || [f.zone]) {
          if (!failingByZone.has(z)) failingByZone.set(z, []);
          failingByZone.get(z).push({ segment: [iso(s), iso(e)], ...f });
        }
      }
    }
  }
  for (const zone of catalog.zones) {
    const open = Object.values(state.gaps).find((g) => g.zone === zone.id && g.status === 'open');
    const failing = failingByZone.get(zone.id);
    if (failing?.length) {
      const from = iso(Math.min(...failing.map((f) => T(f.segment[0]))));
      const until = iso(Math.max(...failing.map((f) => T(f.segment[1]))));
      if (open) {
        open.from = from;
        open.until = until;
        open.shortfalls = failing.slice(0, 10);
        open.updatedAt = now;
      } else {
        const gap = {
          id: nextId(state, 'gap'), zone: zone.id, from, until,
          shortfalls: failing.slice(0, 10), status: 'open', openedAt: now,
        };
        state.gaps[gap.id] = gap;
        changes.gapsOpened.push(gap.id);
      }
    } else if (open) {
      open.status = 'closed';
      open.closedAt = now;
      open.resolution = 'coverage-restored';
      changes.gapsClosed.push(open.id);
    }
  }
  return changes;
}

// ---------- 查询辅助 ----------

function currentZoneSegment(b, at) {
  if (!b.zoneSegments.length) return null;
  if (at === undefined) return b.zoneSegments[b.zoneSegments.length - 1];
  return b.zoneSegments.find((zs) => T(zs.from) <= T(at) && T(at) < T(zs.until)) || null;
}

function currentResponsibility(state, bookingId) {
  return Object.values(state.responsibility).find((r) => r.bookingId === bookingId && r.until === null) || null;
}

function activeArrivedBooking(state, personId) {
  return Object.values(state.bookings).find((b) => b.personId === personId && b.status === 'arrived') || null;
}

function latestBooking(state, personId, statuses = null) {
  const list = Object.values(state.bookings)
    .filter((b) => b.personId === personId && (!statuses || statuses.includes(b.status)));
  list.sort((a, b) => Number(a.id.split('-')[1]) - Number(b.id.split('-')[1]));
  return list[list.length - 1] || null;
}

const workerAbsent = (state, worker, from, until) =>
  Object.values(state.absences).some((a) => a.worker === worker && overlaps(a.from, a.until, from, until));

const qualSuspended = (state, worker, qualification, from, until) =>
  Object.values(state.suspensions).some((s) =>
    s.worker === worker && s.qualification === qualification && overlaps(s.from, s.until, from, until));

// 分区存在未解决缺口时，停止该分区受影响时段的新接收；其他独立分区不受影响。
function gapBlocks(state, zoneId, from, until) {
  return Object.values(state.gaps).some((g) =>
    g.zone === zoneId && g.status === 'open' && overlaps(g.from, g.until, from, until));
}

function occupyingBookingsInZone(state, zoneId, from, until, statuses = OCCUPYING) {
  return Object.values(state.bookings).filter((b) =>
    statuses.has(b.status) && b.zoneSegments.some((zs) => zs.zone === zoneId && overlaps(zs.from, zs.until, from, until)));
}

function addResponsibility(state, { personId, bookingId, worker, zone, from, kind }) {
  const id = nextId(state, 'responsibility');
  state.responsibility[id] = { id, personId, bookingId, worker, zone, from, until: null, kind };
  return state.responsibility[id];
}

function closeResponsibility(state, bookingId, at) {
  for (const r of Object.values(state.responsibility)) {
    if (r.bookingId === bookingId && r.until === null) r.until = at;
  }
}

function endMoveAssignments(state, bookingId, at, exceptId = null) {
  for (const a of Object.values(state.assignments)) {
    if (a.kind !== 'move' || a.bookingId !== bookingId || a.status !== 'active' || a.id === exceptId) continue;
    if (T(a.from) < T(at)) a.until = at;
    else a.status = 'ended';
  }
}

// ---------- 家属申请 ----------

export function createApplication(state, catalog, body, now) {
  const family = catalog.families.find((f) => f.id === body.familyId);
  if (!family) return err(422, '家庭不存在');
  const { from, until } = body;
  if (!validTime(from) || !validTime(until) || T(from) >= T(until)) return err(422, '照护时段无效');
  if (!['required', 'separable'].includes(body.together)) return err(422, 'together 需为 required（必须同时获接收）或 separable（允许分别安排）');
  if (!Array.isArray(body.members) || !body.members.length) return err(422, '需要至少一名被照护人');
  const knownQuals = new Set([
    ...catalog.ratios.map((r) => r.qualification),
    ...catalog.workers.flatMap((w) => w.qualifications),
  ]);
  const seen = new Set();
  for (const m of body.members) {
    if (seen.has(m.personId)) return err(422, '同一申请内被照护人重复');
    seen.add(m.personId);
    const member = family.members.find((x) => x.id === m.personId);
    if (!member) return err(422, `被照护人 ${m.personId} 不属于该家庭`);
    if (member.service !== m.service || member.level !== m.level) {
      return err(422, `被照护人 ${m.personId} 的服务或照护等级与资料不符`);
    }
    if (!ratioFor(catalog, m.service, m.level)) return err(422, '缺少该服务等级的配比资料');
    for (const q of m.requiredQualifications || []) {
      if (!knownQuals.has(q)) return err(422, `未知资质：${q}`);
    }
    const needsAccompanied = m.needsAccompaniedDeparture ?? (m.service === 'child');
    const pickup = m.pickupAuthorized || [];
    if (needsAccompanied && !pickup.length) return err(422, `被照护人 ${m.personId} 需要至少一名接送授权人`);
    for (const g of pickup) {
      if (!family.guardians.includes(g)) return err(422, `接送人 ${g} 不在家庭监护人资料中`);
    }
    if (!Array.isArray(m.emergencyContacts) || !m.emergencyContacts.length) {
      return err(422, `被照护人 ${m.personId} 需要紧急联系人`);
    }
    for (const w of m.careScope?.allowedWorkers || []) {
      if (!catalog.workers.some((x) => x.id === w)) return err(422, `未知工作人员：${w}`);
    }
    const clash = Object.values(state.bookings).some((b) =>
      b.personId === m.personId
      && ['pending', 'confirmed', 'reconfirm-needed', 'arrived'].includes(b.status)
      && overlaps(b.from, b.until, from, until));
    if (clash) return err(409, `被照护人 ${m.personId} 已有重叠时段的预约`);
  }
  const appId = nextId(state, 'application');
  const bookingIds = [];
  for (const m of body.members) {
    const id = nextId(state, 'booking');
    state.bookings[id] = {
      id,
      applicationId: appId,
      familyId: body.familyId,
      personId: m.personId,
      service: m.service,
      level: m.level,
      requiredQualifications: m.requiredQualifications || [],
      pickupAuthorized: [...(m.pickupAuthorized || [])],
      emergencyContacts: m.emergencyContacts,
      needsAccompaniedDeparture: m.needsAccompaniedDeparture ?? (m.service === 'child'),
      careScope: m.careScope || null,
      from,
      until,
      together: body.together,
      status: 'pending',
      zoneSegments: [],
      pickupVersion: 1,
      reconfirmReason: null,
      createdAt: now,
      confirmedAt: null,
      arrivedAt: null,
      departedAt: null,
    };
    bookingIds.push(id);
  }
  state.applications[appId] = {
    id: appId, familyId: body.familyId, from, until, together: body.together, bookingIds, createdAt: now,
  };
  return ok({ application: applicationView(state, appId) });
}

// ---------- 站点确认照护条件 ----------

function candidateZones(state, catalog, booking) {
  return catalog.zones
    .filter((z) => z.service === booking.service)
    .map((z) => z.id)
    .filter((zoneId) => !gapBlocks(state, zoneId, booking.from, booking.until))
    .sort();
}

// 为一批预约选择分区并整体核查；必须同行的申请通过同一批核查保证只能一起确认。
function findZoneAssignment(state, catalog, bookings) {
  const candidates = bookings.map((b) => candidateZones(state, catalog, b));
  if (candidates.some((c) => !c.length)) return null;
  const chosen = new Map();
  let solution = null;
  const from = iso(Math.min(...bookings.map((b) => T(b.from))));
  const until = iso(Math.max(...bookings.map((b) => T(b.until))));
  const visit = (i) => {
    if (solution) return;
    if (i === bookings.length) {
      const extras = bookings.map((b) => ({ ...personView(b, chosen.get(b.id)), from: b.from, until: b.until }));
      if (!checkWindow(state, catalog, from, until, { extras }).length) solution = new Map(chosen);
      return;
    }
    for (const zoneId of candidates[i]) {
      chosen.set(bookings[i].id, zoneId);
      visit(i + 1);
      if (solution) return;
    }
    chosen.delete(bookings[i].id);
  };
  visit(0);
  return solution;
}

function diagnosticFailures(state, catalog, bookings) {
  const zones = bookings.map((b) => candidateZones(state, catalog, b)[0]);
  if (zones.some((z) => !z)) {
    return [{ kind: 'no-zone', message: '没有可接收的分区（服务类型不符，或分区存在未解决缺口已暂停新接收）' }];
  }
  const extras = bookings.map((b, i) => ({ ...personView(b, zones[i]), from: b.from, until: b.until }));
  const from = iso(Math.min(...bookings.map((b) => T(b.from))));
  const until = iso(Math.max(...bookings.map((b) => T(b.until))));
  return checkWindow(state, catalog, from, until, { extras });
}

function confirmBooking(state, booking, zone, now) {
  booking.status = 'confirmed';
  booking.zoneSegments = [{ zone, from: booking.from, until: booking.until }];
  booking.confirmedAt = now;
}

export function confirmApplication(state, catalog, applicationId, now) {
  const app = state.applications[applicationId];
  if (!app) return err(404, '申请不存在');
  const pendings = app.bookingIds.map((id) => state.bookings[id]).filter((b) => b.status === 'pending');
  if (!pendings.length) return err(409, '没有待确认的预约');
  const notifications = [];
  if (app.together === 'required') {
    // 必须同行：整体核查，任一成员条件不满足则一人都不确认。
    const assignment = findZoneAssignment(state, catalog, pendings);
    if (!assignment) {
      return err(422, '照护条件不满足，必须同行的申请不能拆分确认', { failures: diagnosticFailures(state, catalog, pendings) });
    }
    for (const b of pendings) {
      confirmBooking(state, b, assignment.get(b.id), now);
      notifications.push({ kind: 'booking-confirmed', familyId: b.familyId, personId: b.personId, bookingId: b.id, zone: assignment.get(b.id), from: b.from, until: b.until });
    }
    const changes = reevaluate(state, catalog, now);
    return { ...ok({ confirmed: pendings.map((b) => bookingView(state, b)) }), notifications, changes };
  }
  // 允许分别安排：逐人核查，能确认的确认，其余保持待确认并说明原因。
  const results = [];
  for (const b of pendings) {
    const assignment = findZoneAssignment(state, catalog, [b]);
    if (assignment) {
      confirmBooking(state, b, assignment.get(b.id), now);
      notifications.push({ kind: 'booking-confirmed', familyId: b.familyId, personId: b.personId, bookingId: b.id, zone: assignment.get(b.id), from: b.from, until: b.until });
      results.push({ id: b.id, personId: b.personId, status: 'confirmed', zone: assignment.get(b.id) });
    } else {
      results.push({ id: b.id, personId: b.personId, status: 'pending', failures: diagnosticFailures(state, catalog, [b]) });
    }
  }
  const changes = reevaluate(state, catalog, now);
  return { ...ok({ results }), notifications, changes };
}

export function reconfirmBooking(state, catalog, bookingId, now) {
  const b = state.bookings[bookingId];
  if (!b) return err(404, '预约不存在');
  if (b.status !== 'reconfirm-needed' && b.status !== 'confirmed') {
    return err(409, `当前状态不能重新确认：${b.status}`);
  }
  const failures = checkWindow(state, catalog, b.from, b.until);
  if (failures.length) {
    b.status = 'reconfirm-needed';
    b.reconfirmReason = { message: '照护条件仍不满足', failures: failures.slice(0, 5) };
    return err(422, '照护条件仍不满足', { failures });
  }
  b.status = 'confirmed';
  b.reconfirmReason = null;
  return ok({ booking: bookingView(state, b) });
}

// ---------- 延长时段：不能挤掉之后已经确认的照护 ----------

export function extendApplication(state, catalog, applicationId, body, now) {
  const app = state.applications[applicationId];
  if (!app) return err(404, '申请不存在');
  if (!validTime(body.until)) return err(422, '新的结束时间无效');
  const targets = app.bookingIds.map((id) => state.bookings[id])
    .filter((b) => ['confirmed', 'arrived'].includes(b.status))
    .filter((b) => !body.memberIds?.length || body.memberIds.includes(b.personId));
  if (!targets.length) return err(409, '没有可延长的已确认预约');
  for (const b of targets) {
    if (T(body.until) <= T(b.until)) return err(422, '新的结束时间必须晚于原时段');
  }
  // 延长段与所有已占用位置（包括之后已确认的预约）一起核查；不满足则不延长任何人的时段。
  const extras = targets.map((b) => ({ ...personView(b, currentZoneSegment(b).zone), from: b.until, until: body.until }));
  const from = iso(Math.min(...targets.map((b) => T(b.until))));
  const failures = checkWindow(state, catalog, from, body.until, { extras });
  if (failures.length) {
    return err(422, '延长会与之后已确认的照护冲突或照护条件不满足，未延长', { failures });
  }
  for (const b of targets) {
    currentZoneSegment(b).until = body.until;
    b.until = body.until;
  }
  const changes = reevaluate(state, catalog, now);
  return { ...ok({ application: applicationView(state, applicationId) }), changes };
}

// ---------- 排班、请假与资质暂停 ----------

export function addDuty(state, catalog, body, now) {
  if (!catalog.workers.some((w) => w.id === body.worker)) return err(422, '工作人员不存在');
  if (!catalog.zones.some((z) => z.id === body.zone)) return err(422, '分区不存在');
  if (!validTime(body.from) || !validTime(body.until) || T(body.from) >= T(body.until)) return err(422, '排班时段无效');
  const id = nextId(state, 'duty');
  state.duties[id] = { id, worker: body.worker, zone: body.zone, from: body.from, until: body.until, status: 'active', createdAt: now };
  const changes = reevaluate(state, catalog, now);
  return { ...ok({ duty: state.duties[id], changes }), changes };
}

export function cancelDuty(state, catalog, dutyId, now) {
  const d = state.duties[dutyId];
  if (!d) return err(404, '排班不存在');
  if (d.status !== 'active') return err(409, '排班已取消');
  d.status = 'cancelled';
  d.cancelledAt = now;
  const changes = reevaluate(state, catalog, now);
  return { ...ok({ changes }), changes };
}

export function addAbsence(state, catalog, workerId, body, now) {
  if (!catalog.workers.some((w) => w.id === workerId)) return err(404, '工作人员不存在');
  if (!validTime(body.from) || !validTime(body.until) || T(body.from) >= T(body.until)) return err(422, '请假时段无效');
  const id = nextId(state, 'absence');
  state.absences[id] = { id, worker: workerId, from: body.from, until: body.until, reason: body.reason || null, createdAt: now };
  const changes = reevaluate(state, catalog, now);
  return { ...ok({ absence: state.absences[id], changes }), changes };
}

export function addSuspension(state, catalog, workerId, body, now) {
  const worker = catalog.workers.find((w) => w.id === workerId);
  if (!worker) return err(404, '工作人员不存在');
  if (!worker.qualifications.includes(body.qualification)) return err(422, '该工作人员不持有此资质');
  if (!validTime(body.from) || !validTime(body.until) || T(body.from) >= T(body.until)) return err(422, '暂停时段无效');
  const id = nextId(state, 'suspension');
  state.suspensions[id] = { id, worker: workerId, qualification: body.qualification, from: body.from, until: body.until, createdAt: now };
  const changes = reevaluate(state, catalog, now);
  return { ...ok({ suspension: state.suspensions[id], changes }), changes };
}

// ---------- 到站登记 ----------

export function arrive(state, catalog, bookingId, body, now) {
  const b = state.bookings[bookingId];
  if (!b) return err(404, '预约不存在');
  const at = body.at || now;
  if (!validTime(at)) return err(422, '到站时间无效');
  if (b.status === 'reconfirm-needed') {
    return { status: 409, body: { error: '照护条件已变化，需重新确认后才能到站', reconfirmReason: b.reconfirmReason } };
  }
  if (b.status !== 'confirmed') return err(409, `当前状态不能登记到站：${b.status}`);
  if (T(at) >= T(b.until)) return err(422, '到站时间不在预约时段内');
  const zone = b.zoneSegments[0]?.zone;
  if (!zone) return err(409, '预约尚未确认分区');
  if (gapBlocks(state, zone, at, iso(T(at) + 1))) return err(409, '该分区存在未解决缺口，暂停新接收');
  const ratio = ratioFor(catalog, b.service, b.level);
  const presence = workerPresence(state, catalog, T(at), T(at) + 1);
  const candidates = [...presence.entries()]
    .filter(([, p]) => !p.absent && p.zones.has(zone) && p.qualifications.includes(ratio.qualification) && !p.suspended.has(ratio.qualification))
    .map(([id]) => id)
    .sort();
  let worker = body.workerId;
  if (worker) {
    if (!candidates.includes(worker)) return err(422, '指定的负责人员当时不符合条件');
  } else {
    worker = candidates[0];
  }
  if (b.careScope?.allowedWorkers?.length && worker && !b.careScope.allowedWorkers.includes(worker)) {
    const scoped = candidates.filter((c) => b.careScope.allowedWorkers.includes(c));
    if (body.workerId) return err(422, '指定人员不在家属允许的照护范围内');
    worker = scoped[0];
  }
  if (!worker) return err(409, '现场没有符合条件的负责人员');
  b.status = 'arrived';
  b.arrivedAt = at;
  addResponsibility(state, { personId: b.personId, bookingId: b.id, worker, zone, from: at, kind: 'arrival' });
  const changes = reevaluate(state, catalog, now);
  return { ...ok({ booking: bookingView(state, b), responsibleWorker: worker, zone }), changes };
}

// ---------- 临时交接（同分区内更换实际照护人） ----------

export function handover(state, catalog, personId, body, now) {
  const b = activeArrivedBooking(state, personId);
  if (!b) return err(409, '该人员当前不在站');
  const at = body.at || now;
  if (!validTime(at)) return err(422, '交接时间无效');
  const current = currentResponsibility(state, b.id);
  if (!current) return err(409, '没有进行中的照护责任记录');
  if (body.toWorker === current.worker) return err(422, '替班人员与当前负责人相同');
  if (T(at) < T(current.from)) return err(422, '交接时间早于当前责任开始时间');
  const zone = current.zone;
  const ratio = ratioFor(catalog, b.service, b.level);
  const p = workerPresence(state, catalog, T(at), T(at) + 1).get(body.toWorker);
  if (!p) return err(422, '工作人员不存在');
  if (p.absent || !p.zones.has(zone)) return err(422, '替班人员当时不在该分区，不能接管');
  if (!p.qualifications.includes(ratio.qualification) || p.suspended.has(ratio.qualification)) {
    return err(422, '替班人员缺少该照护等级所需资质');
  }
  if (b.careScope?.allowedWorkers?.length && !b.careScope.allowedWorkers.includes(body.toWorker)) {
    return err(422, '替班人员不在家属允许的照护范围内');
  }
  closeResponsibility(state, b.id, at);
  endMoveAssignments(state, b.id, at);
  addResponsibility(state, { personId, bookingId: b.id, worker: body.toWorker, zone, from: at, kind: 'handover' });
  return ok({ responsibleWorker: body.toWorker, zone });
}

// ---------- 临时移到另一分区 ----------

export function movePerson(state, catalog, personId, body, now) {
  const b = activeArrivedBooking(state, personId);
  if (!b) return err(409, '该人员当前不在站');
  const at = body.at || now;
  if (!validTime(at)) return err(422, '移动时间无效');
  const zone = catalog.zones.find((z) => z.id === body.toZone);
  if (!zone) return err(404, '目标分区不存在');
  const current = currentResponsibility(state, b.id);
  if (!current) return err(409, '没有进行中的照护责任记录');
  if (body.toZone === current.zone) return err(422, '已在该分区，更换照护人请用交接接口');
  if (T(at) < T(current.from) || T(at) >= T(b.until)) return err(422, '移动时间不在当前责任时段内');
  const ratio = ratioFor(catalog, b.service, b.level);
  const w = catalog.workers.find((x) => x.id === body.worker);
  if (!w) return err(404, '工作人员不存在');
  if (!w.qualifications.includes(ratio.qualification)) return err(422, '负责人员缺少该照护等级所需资质');
  if (qualSuspended(state, w.id, ratio.qualification, at, b.until)) return err(422, '负责人员所需资质在移动时段被暂停');
  if (workerAbsent(state, w.id, at, b.until)) return err(422, '负责人员在移动时段请假');
  if (b.careScope?.allowedWorkers?.length && !b.careScope.allowedWorkers.includes(w.id)) {
    return err(422, '负责人员不在家属允许的照护范围内');
  }
  // 先假设移动：随行负责人员计入目标分区，原区不能再把同一人算在配比里；整体不满足则回滚。
  const seg = currentZoneSegment(b, at);
  if (!seg || T(at) <= T(seg.from)) return err(422, '移动时间需晚于当前分区段的开始时间');
  const savedSegments = b.zoneSegments.map((x) => ({ ...x }));
  const assignmentId = nextId(state, 'assignment');
  seg.until = at;
  b.zoneSegments.push({ zone: body.toZone, from: at, until: b.until });
  state.assignments[assignmentId] = {
    id: assignmentId, worker: w.id, zone: body.toZone, from: at, until: b.until,
    kind: 'move', personId: b.personId, bookingId: b.id, status: 'active', reason: body.reason || null,
  };
  const failures = checkWindow(state, catalog, at, b.until, { statuses: CONFIRMED_AND_ARRIVED });
  if (failures.length) {
    b.zoneSegments = savedSegments;
    delete state.assignments[assignmentId];
    return err(422, '临时移动后原区或目标分区的照护条件不满足，未移动', { failures });
  }
  closeResponsibility(state, b.id, at);
  endMoveAssignments(state, b.id, at, assignmentId);
  addResponsibility(state, { personId, bookingId: b.id, worker: w.id, zone: body.toZone, from: at, kind: 'move' });
  const changes = reevaluate(state, catalog, now);
  return { ...ok({ zone: body.toZone, responsibleWorker: w.id }), changes };
}

// ---------- 替班（为分区补充临时合格人员） ----------

export function substitute(state, catalog, zoneId, body, now) {
  const zone = catalog.zones.find((z) => z.id === zoneId);
  if (!zone) return err(404, '分区不存在');
  const w = catalog.workers.find((x) => x.id === body.worker);
  if (!w) return err(404, '工作人员不存在');
  if (!validTime(body.from) || !validTime(body.until) || T(body.from) >= T(body.until)) return err(422, '替班时段无效');
  if (workerAbsent(state, w.id, body.from, body.until)) return err(422, '替班人员在该时段请假');
  // 原有责任：已在其他分区排班或有临时安排的人不能同时接管。
  const conflictingDuty = Object.values(state.duties).some((d) =>
    d.status === 'active' && d.worker === w.id && d.zone !== zoneId && overlaps(d.from, d.until, body.from, body.until));
  if (conflictingDuty) return err(422, '替班人员在该时段已有其他分区的排班责任，不能同时接管');
  const redirected = Object.values(state.assignments).some((a) =>
    a.status === 'active' && a.worker === w.id && overlaps(a.from, a.until, body.from, body.until));
  if (redirected) return err(422, '替班人员在该时段已有临时安排');
  // 家属允许的照护范围：分区内受影响时段的每一位被照护人都要接受该替班人员。
  const scopedOut = occupyingBookingsInZone(state, zoneId, body.from, body.until)
    .filter((b) => b.careScope?.allowedWorkers?.length && !b.careScope.allowedWorkers.includes(w.id))
    .map((b) => b.personId);
  if (scopedOut.length) {
    return err(422, '替班人员不在部分被照护人家属允许的照护范围内', { persons: scopedOut });
  }
  // 结合在场人数与照护等级做假设核查；仍不满足则拒绝并保持缺口暴露。
  const id = nextId(state, 'assignment');
  state.assignments[id] = {
    id, worker: w.id, zone: zoneId, from: body.from, until: body.until,
    kind: 'substitution', status: 'active', reason: body.reason || null, createdAt: now,
  };
  const failures = checkWindow(state, catalog, body.from, body.until, { statuses: ARRIVED })
    .filter((f) => (f.zones || [f.zone]).includes(zoneId));
  if (failures.length) {
    delete state.assignments[id];
    const changes = reevaluate(state, catalog, now);
    return { ...err(422, '替班后仍无法同时满足在场人数、照护等级与资质要求，缺口已向值班负责人暴露', { failures }), changes };
  }
  const changes = reevaluate(state, catalog, now);
  return { ...ok({ assignment: state.assignments[id], changes }), changes };
}

// ---------- 接送确认（离站） ----------

export function depart(state, catalog, personId, body, now) {
  const b = activeArrivedBooking(state, personId);
  if (!b) {
    const latest = latestBooking(state, personId);
    if (latest?.status === 'departed') return err(409, '该人员已离站，不能重复交接');
    return err(409, '该人员当前不在站');
  }
  const at = body.at || now;
  if (!validTime(at)) return err(422, '离站时间无效');
  if (T(at) < T(b.arrivedAt)) return err(422, '离站时间早于到站时间');
  // 交接员页面必须携带看到的授权版本：旧页面不能凭旧授权完成放人。
  if (body.expectedPickupVersion === undefined) {
    return err(422, '需要携带页面上看到的接送授权版本 expectedPickupVersion');
  }
  if (body.expectedPickupVersion !== b.pickupVersion) {
    return { status: 409, body: { error: '接送授权已变更，请刷新页面核对当前授权后再办理', pickupVersion: b.pickupVersion } };
  }
  if (b.needsAccompaniedDeparture) {
    if (!body.guardianId) return err(422, '该被照护人需由当前有效的接送人陪同离站');
    if (!b.pickupAuthorized.includes(body.guardianId)) return err(403, '接送人未获当前授权，不能放人');
  }
  const id = nextId(state, 'departure');
  state.departures[id] = {
    id, personId, bookingId: b.id, guardianId: body.guardianId ?? null,
    staffId: body.staffId ?? null, at, pickupVersion: b.pickupVersion,
  };
  b.status = 'departed';
  b.departedAt = at;
  closeResponsibility(state, b.id, at);
  endMoveAssignments(state, b.id, at);
  const changes = reevaluate(state, catalog, now);
  const notifications = [{ kind: 'departure', familyId: b.familyId, personId, bookingId: b.id, at }];
  return { ...ok({ departure: state.departures[id] }), changes, notifications };
}

// ---------- 接送授权变更 ----------

export function changePickupAuthorization(state, catalog, personId, body, now) {
  const b = latestBooking(state, personId, PICKUP_CHANGEABLE);
  if (!b) return err(404, '没有可变更授权的预约');
  const grant = body.grant || [];
  const revoke = body.revoke || [];
  if (!grant.length && !revoke.length) return err(422, '需要 grant 或 revoke');
  const family = catalog.families.find((f) => f.id === b.familyId);
  for (const g of grant) {
    if (family && !family.guardians.includes(g)) return err(422, `接送人 ${g} 不在家庭监护人资料中`);
  }
  const at = body.at || now;
  if (!validTime(at)) return err(422, '变更时间无效');
  b.pickupAuthorized = [...new Set([...b.pickupAuthorized.filter((g) => !revoke.includes(g)), ...grant])];
  b.pickupVersion += 1;
  const changeId = nextId(state, 'pickupChange');
  state.pickupChanges[changeId] = {
    id: changeId, personId, bookingId: b.id, grant, revoke, actor: body.actor || null, at, version: b.pickupVersion,
  };
  // 实际交接完成后才收到撤销授权：保留已经发生的交接事实，并留下待核事项。
  const reviewItems = [];
  for (const g of revoke) {
    const used = Object.values(state.departures).filter((d) => d.bookingId === b.id && d.guardianId === g);
    for (const d of used) {
      const rid = nextId(state, 'reviewItem');
      state.reviewItems[rid] = {
        id: rid, kind: 'authorization-revoked-after-handover', personId, bookingId: b.id,
        departureId: d.id, guardianId: g, status: 'pending',
        note: '交接完成后才收到撤销授权：交接事实保留，需人工核实', createdAt: at,
      };
      reviewItems.push(state.reviewItems[rid]);
    }
  }
  return ok({ pickupVersion: b.pickupVersion, pickupAuthorized: b.pickupAuthorized, reviewItems });
}

// ---------- 待核事项 ----------

export function resolveReviewItem(state, id, body, now) {
  const item = state.reviewItems[id];
  if (!item) return err(404, '待核事项不存在');
  if (item.status !== 'pending') return err(409, '待核事项已处理');
  item.status = 'resolved';
  item.resolution = body.resolution || null;
  item.resolvedBy = body.staffId || null;
  item.resolvedAt = now;
  return ok({ reviewItem: item });
}

// ---------- 视图 ----------

export function bookingView(state, b) {
  const current = currentZoneSegment(b);
  return {
    id: b.id,
    applicationId: b.applicationId,
    personId: b.personId,
    service: b.service,
    level: b.level,
    status: b.status,
    zone: current?.zone ?? null,
    from: b.from,
    until: b.until,
    pickupVersion: b.pickupVersion,
    pickupAuthorized: [...b.pickupAuthorized],
    emergencyContacts: b.emergencyContacts,
    reconfirmReason: b.reconfirmReason,
    confirmedAt: b.confirmedAt,
    arrivedAt: b.arrivedAt,
    departedAt: b.departedAt,
  };
}

function applicationStatusOf(bookings) {
  const s = bookings.map((b) => b.status);
  if (s.every((x) => x === 'departed' || x === 'cancelled')) return 'completed';
  if (s.some((x) => x === 'arrived')) return 'in-service';
  if (s.some((x) => x === 'reconfirm-needed')) return 'reconfirm-needed';
  if (s.every((x) => x === 'confirmed')) return 'confirmed';
  if (s.some((x) => x === 'confirmed')) return 'partial';
  return 'pending';
}

export function applicationView(state, appId) {
  const app = state.applications[appId];
  const bookings = app.bookingIds.map((id) => bookingView(state, state.bookings[id]));
  return {
    id: app.id,
    familyId: app.familyId,
    from: app.from,
    until: app.until,
    together: app.together,
    status: applicationStatusOf(bookings),
    bookings,
  };
}

export function listApplicationsByFamily(state, familyId) {
  return Object.values(state.applications)
    .filter((a) => a.familyId === familyId)
    .map((a) => applicationView(state, a.id));
}

export function presenceView(state, personId) {
  const b = latestBooking(state, personId);
  if (!b) return null;
  const current = b.status === 'arrived' ? currentResponsibility(state, b.id) : null;
  return {
    personId,
    bookingId: b.id,
    status: b.status,
    onSite: b.status === 'arrived',
    zone: current?.zone ?? null,
    responsibleWorker: current?.worker ?? null,
    since: current?.from ?? null,
    pickupVersion: b.pickupVersion,
  };
}

export function responsibilityOf(state, personId) {
  return Object.values(state.responsibility)
    .filter((r) => r.personId === personId)
    .sort((a, b) => T(a.from) - T(b.from));
}

export function departuresOf(state, personId) {
  return Object.values(state.departures).filter((d) => d.personId === personId);
}

export function pickupChangesOf(state, personId) {
  return Object.values(state.pickupChanges).filter((c) => c.personId === personId);
}

export function gapsOf(state, status = null) {
  return Object.values(state.gaps).filter((g) => !status || g.status === status);
}

export function reviewItemsOf(state, status = null) {
  return Object.values(state.reviewItems).filter((i) => !status || i.status === status);
}

// 站点视角的分区覆盖：每段的在场人、配比名额与匹配到的工作人员、未满足项。
export function coverageView(state, catalog, zoneId, from, until) {
  if (!validTime(from) || !validTime(until) || T(from) >= T(until)) return null;
  const segments = [];
  for (const [s, e] of collectSegments(state, from, until)) {
    const presence = workerPresence(state, catalog, s, e);
    const peopleAll = occupyingPeople(state, s, e, OCCUPYING).map((x) => personView(x.booking, x.zone));
    const { failures, slots, assignment } = checkSegment(catalog, presence, peopleAll);
    segments.push({
      from: iso(s),
      until: iso(e),
      people: peopleAll.filter((p) => p.zone === zoneId).map((p) => p.personId),
      workersPresent: [...presence.entries()].filter(([, p]) => !p.absent && p.zones.has(zoneId)).map(([id]) => id),
      slots: slots.filter((sl) => sl.zone === zoneId)
        .map((sl) => ({ group: sl.group, qualification: sl.qual, worker: assignment?.get(sl.id) ?? null })),
      failures: failures.filter((f) => (f.zones || [f.zone]).includes(zoneId)),
    });
  }
  return { zone: zoneId, from, until, segments };
}
