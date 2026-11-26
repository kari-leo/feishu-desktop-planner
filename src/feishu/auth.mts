import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { FeishuError, request } from './http.mts';
import type { Identity } from './http.mts';

export type UserGrant = {
  access: string; refresh: string; expires: number; refreshExpires: number; authorized: number; scope: string;
};
export type Vault = { load(): Promise<UserGrant | undefined>; save(value: UserGrant): Promise<void> };
type App = { appId: string; secret: string };
type TokenResponse = {
  access_token: string; refresh_token: string; expires_in: number;
  refresh_token_expires_in: number; scope?: string;
};
type TokenRequest = (form: Record<string, string>) => Promise<TokenResponse>;

const day = 86_400_000;
const buffer = 45_000;

export class AuthorizationRequired extends Error {
  constructor() { super('飞书用户授权不可用，请运行 npm run planner -- authorize 重新授权'); }
}

export class TokenManager {
  #vault: Vault;
  #app: App;
  #exchange: TokenRequest;
  #user?: UserGrant;
  #pendingUser?: Promise<string>;
  #tenant?: { access: string; expires: number };
  #pendingTenant?: Promise<string>;

  constructor(app: App, vault: Vault, exchange: TokenRequest = exchangeToken) {
    this.#app = app;
    this.#vault = vault;
    this.#exchange = exchange;
  }

  access = (identity: Identity, rejectedToken?: string): Promise<string> => {
    if (identity === 'tenant') {
      const cached = this.#tenant;
      if (cached && cached.access !== rejectedToken && cached.expires > Date.now() + buffer) {
        return Promise.resolve(cached.access);
      }
      this.#pendingTenant ??= this.#getTenant().finally(() => { this.#pendingTenant = undefined; });
      return this.#pendingTenant;
    }
    this.#pendingUser ??= this.#getUser(rejectedToken).finally(() => { this.#pendingUser = undefined; });
    return this.#pendingUser;
  };

  async #getTenant() {
    const data = await request<{ tenant_access_token: string; expire: number }>('应用授权',
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app_id: this.#app.appId, app_secret: this.#app.secret }),
      });
    if (!data.tenant_access_token || !data.expire) throw new Error('飞书返回的应用凭证不完整');
    this.#tenant = { access: data.tenant_access_token, expires: Date.now() + data.expire * 1000 };
    return this.#tenant.access;
  }

  async #getUser(rejectedToken?: string) {
    this.#user ??= await this.#vault.load();
    const grant = this.#user;
    const now = Date.now();
    if (!grant || now >= grant.authorized + 365 * day) throw new AuthorizationRequired();
    if (grant.access !== rejectedToken && now + buffer < grant.expires) return grant.access;
    if (now >= grant.refreshExpires) throw new AuthorizationRequired();

    let data: TokenResponse;
    try {
      data = await this.#token({ grant_type: 'refresh_token', refresh_token: grant.refresh });
    } catch (error) {
      if (error instanceof FeishuError && [20010, 20024, 20026, 20037, 20038, 20064].includes(error.code)) {
        throw new AuthorizationRequired();
      }
      throw error;
    }
    return (await this.#save(data, grant.authorized, grant.scope)).access;
  }

  async #save(data: TokenResponse, authorized: number, previousScope = '', issued = Date.now()) {
    if (typeof data.access_token !== 'string' || !data.access_token
      || typeof data.refresh_token !== 'string' || !data.refresh_token
      || !Number.isFinite(data.expires_in) || !(data.expires_in > 0)
      || !Number.isFinite(data.refresh_token_expires_in) || !(data.refresh_token_expires_in > 0)) {
      throw new Error('飞书返回的用户凭证不完整，请确认授权包含 offline_access');
    }
    const grant = {
      access: data.access_token, refresh: data.refresh_token,
      expires: issued + data.expires_in * 1000, refreshExpires: issued + data.refresh_token_expires_in * 1000,
      authorized, scope: data.scope ?? previousScope,
    };
    await this.#vault.save(grant);
    this.#user = grant;
    return grant;
  }

  #token(form: Record<string, string>) {
    return this.#exchange({ ...form, client_id: this.#app.appId, client_secret: this.#app.secret });
  }

  async importInitial(data: TokenResponse & { code: number }, received: number) {
    if (this.#user || await this.#vault.load()) throw new Error('已保存飞书授权，请通过 authorize 更新');
    if (data?.code !== 0 || !Number.isFinite(received) || received > Date.now() + buffer) {
      throw new Error('首次飞书回调数据或接收时间无效');
    }
    const issued = Math.min(received, issueTime(data.access_token) ?? received,
      issueTime(data.refresh_token) ?? received, Date.now());
    if (Date.now() >= issued + Math.min(365 * day, data.refresh_token_expires_in * 1000)) {
      throw new AuthorizationRequired();
    }
    await this.#save(data, issued, '', issued);
  }

  async authorize(redirect: URL, scopes: string, open: (url: URL) => void | Promise<void>) {
    if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1'
      || !redirect.port || redirect.username || redirect.password || redirect.search || redirect.hash) {
      throw new Error('OAuth 回调须为带端口的 127.0.0.1 本地 HTTP 地址');
    }
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    const url = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
    url.search = new URLSearchParams({
      response_type: 'code', client_id: this.#app.appId, redirect_uri: redirect.href,
      scope: scopes, state, code_challenge_method: 'S256', prompt: 'consent',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    }).toString();
    const code = await receiveCode(redirect, state, () => open(url));
    await this.#save(await this.#token({
      grant_type: 'authorization_code', code, redirect_uri: redirect.href, code_verifier: verifier,
    }), Date.now());
  }
}

function issueTime(token: unknown): number | undefined {
  // The timestamp only shortens an imported lifetime. Feishu validates the token on each API call.
  if (typeof token !== 'string' || token.split('.').length !== 3) return undefined;
  try {
    const claim = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(claim.iat) && claim.iat > 0 ? claim.iat * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function exchangeToken(form: Record<string, string>) {
  return request<TokenResponse>('用户 OAuth', 'https://accounts.feishu.cn/oauth/v3/token', {
    method: 'POST', body: new URLSearchParams(form),
  });
}

function receiveCode(redirect: URL, state: string, open: () => void | Promise<void>) {
  return new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      const [path, query] = (req.url ?? '').split('?', 2);
      if (req.method !== 'GET' || req.headers.host !== redirect.host || path !== redirect.pathname) {
        res.writeHead(404).end('页面不存在');
        return;
      }
      const params = new URLSearchParams(query);
      if (params.get('state') !== state) {
        res.writeHead(400).end('授权状态校验失败');
        return;
      }
      const code = params.get('code');
      res.end(code ? '已收到授权回调，请返回终端确认结果。' : '飞书授权未完成。');
      finish(code ? undefined : new Error('飞书授权未完成'), code);
    });
    const timer = setTimeout(() => finish(new Error('等待飞书授权超时')), 180_000);
    function finish(error?: Error, code?: string | null) {
      clearTimeout(timer);
      server.close();
      if (error) reject(error);
      else if (code) resolve(code);
    }
    server.on('error', () => finish(new Error('无法监听本地 OAuth 回调端口')));
    server.listen(Number(redirect.port), redirect.hostname, () => {
      Promise.resolve().then(open).catch(() => finish(new Error('无法打开系统浏览器')));
    });
  });
}
