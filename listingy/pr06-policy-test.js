'use strict';
// Політика ролей D0, записана вручну окремо від profile.js і policy.js:
// зміна правила без зміни цієї таблиці зупиняє тест
const test = require('node:test');
const assert = require('node:assert/strict');
const { securityOptions, PROFILE_D0 } = require('./profile');
const { makeSecure, routesOf } = require('./auth-kit');

const PINNED = {                             // ролі за абеткою
  'self:read': ['admin', 'operator', 'viewer'],
  'push:write': ['admin', 'operator', 'viewer'],
  'device:read': ['admin', 'operator', 'viewer'],
  'telemetry:read': ['admin', 'operator', 'viewer'],
  'stream:read': ['admin', 'operator', 'viewer'],
  'settings:read': ['admin', 'operator', 'viewer'],
  'settings:write': ['admin', 'operator'],
  'command:create': ['admin', 'operator'],
  'command:read': ['admin', 'operator'],
  'device:claim': ['admin'],
  'audit:read': ['admin'],
  'ingest:write': [],
};
const CHANGED = ['device:claim'];            // змінені порівняно з базовою
const USERS = { viewer: 'viewer', operator: 'agro', admin: 'root' };
const policyOf = () => securityOptions(PROFILE_D0).auth.policy;

test('політика збігається із зафіксованою таблицею', () => {
  const sorted = Object.fromEntries(Object.entries(policyOf())
    .map(([action, roles]) => [action, [...roles].sort()]));
  assert.deepEqual(sorted, PINNED);
});

test('guard виконує змінені дії для кожної ролі', async () => {
  const s = await makeSecure({ policy: policyOf() });
  const routes = routesOf(s.app)
    .filter((r) => r.action && !r.key.endsWith('/stream'));
  const session = {};
  for (const [role, name] of Object.entries(USERS)) {
    session[role] = await s.as(name);
  }
  for (const action of CHANGED) {
    const route = routes.find((r) => r.action === action);
    assert.ok(route, `немає маршруту для дії ${action}`);
    const [method, ...rest] = route.key.split(' ');
    const url = `/api/v1${rest.join(' ').replace(/\{(\w+)\}/g, 'gh1-s01')}`;
    for (const role of Object.keys(USERS)) {
      const r = await session[role][method](url).send({});
      const denied = r.status === 403
        && /\/forbidden$/.test(r.body?.type ?? '');
      assert.equal(denied, !PINNED[action].includes(role),
        `${action} для ${role}: ${r.status} ${r.body?.type}`);
    }
  }
});
