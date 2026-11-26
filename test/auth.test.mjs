import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { TokenManager } from '../src/feishu/auth.mts';

test('过期用户凭证并发读取只刷新一次，重启仍使用新凭证', async () => {
  let saved = { access: 'old', refresh: 'refresh1', expires: 0,
    refreshExpires: Date.now() + 60_000, authorized: Date.now(), scope: 'offline_access' };
  let refreshes = 0;
  const vault = {
    async load() { return saved; },
    async save(value) { saved = value; },
  };
  const tokenRequest = async (form) => {
    assert.equal(form.grant_type, 'refresh_token');
    assert.equal(form.refresh_token, 'refresh1');
    refreshes++;
    return { access_token: 'new', refresh_token: 'refresh2',
      expires_in: 3600, refresh_token_expires_in: 3600, scope: 'offline_access' };
  };
  const manager = () => new TokenManager({ appId: 'id', secret: 'secret' }, vault, tokenRequest);
  const active = manager();
  assert.deepEqual(await Promise.all([active.access('user'), active.access('user')]), ['new', 'new']);
  assert.equal(await manager().access('user'), 'new');
  assert.equal(saved.refresh, 'refresh2');
  assert.equal(refreshes, 1);
});

test('导入首次回调保留原始授权及到期时间，且不会覆盖已保存凭证', async () => {
  let saved;
  const original = Date.now() - 3_600_000;
  const manager = new TokenManager({ appId: 'id', secret: 'secret' }, {
    async load() { return saved; },
    async save(value) { saved = value; },
  });
  const response = { code: 0, access_token: 'opaque-token', refresh_token: 'refresh',
    expires_in: 7200, refresh_token_expires_in: 86400, scope: 'calendar:calendar offline_access' };
  await manager.importInitial(response, original);
  assert.equal(saved.authorized, original);
  assert.equal(saved.expires, original + 7_200_000);
  assert.equal(saved.refreshExpires, original + 86_400_000);
  await assert.rejects(manager.importInitial({ ...response, access_token: 'other' }, original), /已保存/);
  assert.equal(await manager.access('user'), 'opaque-token');
});

test('本地 OAuth 拒绝错误 state，并用原始 PKCE verifier 交换授权码', async (t) => {
  const probe = createServer((_req, response) => response.end('ok'));
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  const callback = new URL(`http://127.0.0.1:${port}/oauth/callback`);
  try {
    await (await fetch(callback)).text();
  } catch (error) {
    if (error.cause?.code !== 'EACCES') throw error;
    t.skip('当前沙箱禁止访问本机 TCP，须在普通 Windows 环境运行');
    return;
  } finally {
    probe.close();
    await once(probe, 'close');
  }
  let saved;
  let challenge;
  const manager = new TokenManager({ appId: 'id', secret: 'secret' }, {
    async load() { return saved; },
    async save(value) { saved = value; },
  }, async form => {
    assert.equal(form.code, 'authorized-code');
    assert.equal(form.redirect_uri, callback.href);
    assert.equal(createHash('sha256').update(form.code_verifier).digest('base64url'), challenge);
    return { access_token: 'access', refresh_token: 'refresh',
      expires_in: 3600, refresh_token_expires_in: 7200, scope: 'offline_access' };
  });
  await manager.authorize(callback, 'offline_access', async authorize => {
    challenge = authorize.searchParams.get('code_challenge');
    const bad = await fetch(new URL('?state=invalid&code=ignored', callback));
    assert.equal(bad.status, 400);
    const state = authorize.searchParams.get('state');
    const good = await fetch(new URL(`?state=${state}&code=authorized-code`, callback));
    assert.equal(good.status, 200);
  });
  assert.equal(await manager.access('user'), 'access');
});
