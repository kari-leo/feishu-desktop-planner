import Lark from '@larksuiteoapi/node-sdk';

const quiet = { debug() {}, info() {}, warn() {}, error() {}, trace() {} };

type EventConfig = {
  appId: string; secret: string; base: string; scheduleTable: string; todoTable: string;
  calendar: string; websocket: boolean;
};

export function eventConnection(
  config: EventConfig, trigger: (id?: string) => void, log: (line: string) => void,
) {
  if (!config.websocket) return { stop() {} };
  const { appId, secret, base, scheduleTable, todoTable, calendar } = config;
  const client = new Lark.WSClient({
    appId, appSecret: secret, logger: quiet, handshakeTimeoutMs: 10_000,
    wsConfig: { pingTimeout: 15 },
    onReady() { log('飞书长连接已建立'); trigger(); },
    onReconnected() { log('飞书长连接已恢复'); trigger(); },
    onError() { log('飞书长连接不可用，按轮询间隔同步'); },
  });
  const dispatcher = new Lark.EventDispatcher({ logger: quiet }).register({
    'drive.file.bitable_record_changed_v1': async data => {
      if (data.file_token === base && (data.table_id === scheduleTable || data.table_id === todoTable)) {
        trigger(data.event_id ?? data.uuid);
      }
    },
    'calendar.calendar.event.changed_v4': async data => {
      if (data.calendar_id === calendar) trigger(data.event_id ?? data.uuid);
    },
  });
  client.start({ eventDispatcher: dispatcher }).catch(() => {
    log('飞书长连接不可用，按轮询间隔同步');
  });
  return { stop() { client.close({ force: true }); } };
}
