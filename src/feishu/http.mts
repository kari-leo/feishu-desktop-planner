export type Identity = 'tenant' | 'user';
export type Options = {
  method?: string;
  query?: Record<string, string | number | undefined>;
  body?: object;
};
export type Api = <T>(identity: Identity, path: string, options?: Options) => Promise<T>;

export class FeishuError extends Error {
  readonly status: number;
  readonly code: number;

  constructor(operation: string, status: number, code: number) {
    super(`${operation}失败（HTTP ${status}，飞书 ${code}）`);
    this.status = status;
    this.code = code;
  }
}

export async function request<T>(operation: string, url: URL | string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new Error(`${operation}失败，请检查网络连接`);
  }
  const body = await response.json().catch(() => null);
  const code = typeof body?.code === 'number' ? body.code : -1;
  if (!response.ok || code !== 0) throw new FeishuError(operation, response.status, code);
  return body;
}

type Access = (identity: Identity, rejectedToken?: string) => Promise<string>;

export function createApi(access: Access): Api {
  return async <T,>(identity: Identity, path: string, options: Options = {}): Promise<T> => {
    const url = new URL('https://open.feishu.cn/open-apis/' + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const send = (token: string) => request<{ data?: T }>(
      path.startsWith('calendar/') ? '日历请求' : 'Base 请求', url, {
        method: options.method ?? 'GET',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    const token = await access(identity);
    try { return (await send(token)).data as T; }
    catch (error) {
      if (!(error instanceof FeishuError) || ![401, 99991668, 99991677].some(
        number => number === error.status || number === error.code,
      )) throw error;
      return (await send(await access(identity, token))).data as T;
    }
  };
}
