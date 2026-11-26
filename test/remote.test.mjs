import assert from 'node:assert/strict';
import test from 'node:test';
import { FeishuRemote } from '../src/feishu/remote.mts';
import { FeishuError } from '../src/feishu/http.mts';

test('日历使用全天半开区间、持久幂等键和独立增量游标', async () => {
  const requests = [];
  const api = async (identity, path, options) => {
    requests.push({ identity, path, options });
    if (options.method === 'POST') return { event: {
      event_id: 'event1', ...options.body, end_time: { date: '2027-01-02' },
    } };
    return { items: [], has_more: false, sync_token: 'next' };
  };
  const remote = new FeishuRemote(api, {
    base: 'base', scheduleTable: 'schedule', todoTable: 'todo', calendar: 'calendar',
    zone: 'Asia/Shanghai',
  });
  const values = { title: '跨年', start: '2026-12-31', end: '2027-01-01', notes: '正文' };
  const event = await remote.createEvent('r1', values, 'key');
  assert.deepEqual(event, { id: 'event1', recordId: 'r1', deleted: false, ...values });
  assert.equal(requests[0].identity, 'user');
  assert.equal(requests[0].options.query.idempotency_key, 'key');
  assert.deepEqual(requests[0].options.body.end_time, { date: '2027-01-01' });
  assert.match(requests[0].options.body.description, /^正文\n\n\[计划管理器:[a-f0-9]{40}\]$/);
  assert.equal(requests[0].options.body.free_busy_status, 'free');
  assert.equal((await remote.listEvents('old')).cursor, 'next');
  assert.equal(requests[1].options.query.sync_token, 'old');
  assert.equal(requests[1].options.query.start_time, undefined);
  assert.equal(requests[1].options.query.end_time, undefined);
});

test('日程已删除时重复删除安全，活动日程的权限错误仍反馈', async () => {
  let status = 'cancelled';
  const api = async (_identity, _path, options) => {
    if (options?.method === 'DELETE') throw new FeishuError('日历请求', 403, 193003);
    return { event: { event_id: 'event1', status } };
  };
  const remote = new FeishuRemote(api, {
    base: 'base', scheduleTable: 'schedule', todoTable: 'todo', calendar: 'calendar',
    zone: 'Asia/Shanghai',
  });
  await remote.deleteEvent('event1');
  status = 'confirmed';
  await assert.rejects(remote.deleteEvent('event1'), error => error.code === 193003);
});

test('批量关联只写排期表的日历 ID 和日程 ID', async () => {
  const requests = [];
  const api = async (identity, path, options) => {
    if (path.endsWith('/fields')) return {
      items: [
        { field_name: '任务名称', type: 1 }, { field_name: '状态', type: 3 },
        { field_name: '任务开始日期', type: 5 }, { field_name: '任务截止日期', type: 5 },
        { field_name: '日程ID', type: 1 }, { field_name: '日历ID', type: 1 },
      ],
    };
    requests.push({ identity, path, ...options });
    return { records: options.body.records.map(({ record_id }) => ({ record_id })) };
  };
  const remote = new FeishuRemote(api, {
    base: 'base', scheduleTable: 'schedule', todoTable: 'todo', calendar: 'calendar',
    zone: 'Asia/Shanghai',
  });
  assert.equal(await remote.linkTasks([{ id: 'record1', eventId: 'event1' }, { id: 'record2', eventId: '' }]), true);
  assert.deepEqual(requests, [{
    identity: 'tenant', path: 'bitable/v1/apps/base/tables/schedule/records/batch_update', method: 'POST',
    body: { records: [
      { record_id: 'record1', fields: { 日程ID: 'event1', 日历ID: 'calendar' } },
      { record_id: 'record2', fields: { 日程ID: null, 日历ID: null } },
    ] },
  }]);
});

test('新建待办时将选择的优先级写入飞书单选字段', async () => {
  const api = async (identity, path, options) => {
    if (path.endsWith('/fields')) return { items: [
      { field_name: '待办事项', type: 1 }, { field_name: '计划日期', type: 5 },
      { field_name: '完成', type: 7 }, { field_name: '优先级', type: 3 },
    ] };
    assert.equal(identity, 'tenant');
    assert.equal(path, 'bitable/v1/apps/base/tables/todo/records');
    assert.equal(options.body.fields.优先级, '高');
    return { record: { record_id: 'record1', fields: options.body.fields } };
  };
  const remote = new FeishuRemote(api, {
    base: 'base', scheduleTable: 'schedule', todoTable: 'todo', calendar: 'calendar', zone: 'Asia/Shanghai',
  });
  assert.equal((await remote.createTodo({ title: '核对待办', date: '2026-11-25', done: false, priority: '高' },
    'existing-key')).priority, '高');
});
