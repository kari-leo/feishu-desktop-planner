import assert from 'node:assert/strict';
import test from 'node:test';
import { changeRange, monthWeeks, weekBars } from '../src/desktop/ui/calendar-model.mts';
import { taskCommand } from '../src/desktop/commands.mts';

test('月历将跨年任务分周裁切，交叠的任务各占一行', () => {
  const weeks = monthWeeks('2026-12-01');
  const last = weeks.find(week => week.includes('2026-12-31'));
  assert.deepEqual(last, ['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31',
    '2027-01-01', '2027-01-02', '2027-01-03']);
  const task = { id: 'a', title: '长任务', notes: '', start: '2026-12-26', end: '2027-01-02' };
  const shorter = { ...task, id: 'b', title: '相交', start: '2026-12-31', end: '2026-12-31' };
  const bars = weekBars([task, shorter], last);
  assert.deepEqual(bars.map(({left,right,lane}) => [left,right,lane]), [[0,5,0],[3,3,1]]);
});

test('拖拽排期保持天数，拖动边缘时日期不会颠倒', () => {
  const task = { start: '2026-12-31', end: '2027-01-02' };
  assert.deepEqual(changeRange(task, '2026-12-31','2027-01-02','move'),
    {start:'2027-01-02', end:'2027-01-04'});
  assert.deepEqual(changeRange(task, '2026-12-31','2027-01-03','start'),
    {start:'2027-01-02', end:'2027-01-02'});
  assert.throws(() => taskCommand({kind:'update',id:'recA', values:{end:'2027-02-29'}}), /有效日期/);
  assert.throws(() => taskCommand({kind:'update',id:'recA', values:{eventId:'event'}}), /字段不可编辑/);
});
