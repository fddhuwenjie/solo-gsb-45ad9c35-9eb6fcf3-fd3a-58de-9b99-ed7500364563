'use strict';

// 回归测试共享夹具：与 README 示例「支付链路中断」同构的最小因果图。
//   配置开关(n-config) ─┐
//                       ├─→ 空指针异常(n-null, ALL) ─→ 服务中断(n-outage) ─→ 订单损失(n-loss)
//   错误版本发布(n-code) ─┘
function sampleGraph() {
  return {
    version_id: 1,
    nodes: [
      { id: 'n-code', type: 'event', title: '错误版本发布',
        earliest_time: '2026-09-20T02:00:00Z', latest_time: '2026-09-20T02:05:00Z',
        pos_x: 80, pos_y: 80, trigger_mode: 'ANY' },
      { id: 'n-config', type: 'event', title: '配置开关失效',
        earliest_time: '2026-09-20T02:01:00Z', latest_time: null,
        pos_x: 80, pos_y: 200, trigger_mode: 'ANY' },
      { id: 'n-null', type: 'event', title: '空指针异常',
        earliest_time: null, latest_time: '2026-09-20T02:10:00Z',
        pos_x: 320, pos_y: 140, trigger_mode: 'ALL' },
      { id: 'n-outage', type: 'event', title: '服务中断',
        pos_x: 560, pos_y: 140 },
      { id: 'n-loss', type: 'event', title: '订单损失',
        pos_x: 800, pos_y: 140 },
      { id: 'e-sre', type: 'evidence', title: 'SRE 值班记录',
        reliability: 0.9, source_group: '值班记录', pos_x: 560, pos_y: 280 },
    ],
    edges: [
      { id: 'e1', source_id: 'n-code', target_id: 'n-null', kind: 'causes' },
      { id: 'e2', source_id: 'n-config', target_id: 'n-null', kind: 'causes' },
      { id: 'e3', source_id: 'n-null', target_id: 'n-outage', kind: 'causes' },
      { id: 'e4', source_id: 'n-outage', target_id: 'n-loss', kind: 'causes' },
      { id: 'e5', source_id: 'e-sre', target_id: 'n-outage', kind: 'supports' },
    ],
  };
}

module.exports = { sampleGraph };
