import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CapacityAllocator, RejectionReason } from '../src/allocator.js';

function makeAllocator(overrides = {}) {
  return new CapacityAllocator({
    pools: [
      { id: 'a1', failureDomain: 'A', capacity: 100 },
      { id: 'a2', failureDomain: 'A', capacity: 100 },
      { id: 'b1', failureDomain: 'B', capacity: 60 },
      { id: 'b2', failureDomain: 'B', capacity: 60 },
    ],
    ...overrides,
  });
}
// 域 A：容量 200，N+1 余量 100，可用 100
// 域 B：容量 120，N+1 余量 60，可用 60
// 全局可用 160

test('资源争抢：弹性容量按权重公平分配，拆分申请不能绕过总量限制', () => {
  const alloc = makeAllocator();
  alloc.addTenant({ id: 't1', weight: 3 });
  alloc.addTenant({ id: 't2', weight: 1 });

  // t1 拆成 10 份小申请，t2 只提 1 份；公平份额按租户计算，拆分不得获益。
  for (let i = 0; i < 10; i += 1) {
    alloc.request({ id: `t1-r${i}`, tenantId: 't1', amount: 20, duration: 100 });
  }
  alloc.request({ id: 't2-r0', tenantId: 't2', amount: 100, duration: 100 });

  const t1 = alloc.tenantReport('t1');
  const t2 = alloc.tenantReport('t2');
  assert.equal(t1.demand, 200);
  assert.equal(t2.demand, 100);
  // 权重 3:1 → 120 : 40
  assert.equal(t1.elastic, 120);
  assert.equal(t2.elastic, 40);
  assert.equal(t1.totalAllocated + t2.totalAllocated, 160);

  // 拆分后请求级分配之和等于租户总量，且不超过申请总量。
  const sumAllocated = t1.requests.reduce((s, r) => s + r.allocated, 0);
  assert.ok(Math.abs(sumAllocated - t1.totalAllocated) < 1e-9);
  assert.ok(t1.totalAllocated <= t1.demand);
  for (const r of t1.requests) assert.ok(r.allocated <= r.requested);
});

test('故障域约束：N+1 迁移余量不可被占用', () => {
  const alloc = makeAllocator();
  alloc.addTenant({ id: 't1', weight: 1 });
  const res = alloc.request({ id: 'r1', tenantId: 't1', amount: 500, duration: 100 });

  assert.equal(res.status, 'partial');
  assert.equal(res.allocated, 160);
  assert.equal(res.reason, RejectionReason.INSUFFICIENT_CAPACITY);

  for (const domain of alloc.plan().domains) {
    assert.ok(domain.used <= domain.usable, `domain ${domain.failureDomain} 侵占了迁移余量`);
    assert.ok(domain.reservedHeadroom > 0);
  }
});

test('故障域约束：显式余量配置生效', () => {
  const alloc = new CapacityAllocator({
    pools: [{ id: 'p1', failureDomain: 'A', capacity: 100 }],
    headroom: { mode: 'explicit', reserve: { A: 40 } },
  });
  alloc.addTenant({ id: 't1' });
  const res = alloc.request({ id: 'r1', tenantId: 't1', amount: 100, duration: 10 });
  assert.equal(res.allocated, 60);
  assert.equal(alloc.plan().domains[0].reservedHeadroom, 40);
});

test('优先级保护：高优先级租户的保障量先被满足', () => {
  const alloc = new CapacityAllocator({
    pools: [
      { id: 'a1', failureDomain: 'A', capacity: 100 },
      { id: 'a2', failureDomain: 'A', capacity: 100 },
    ],
  }); // 可用 100
  alloc.addTenant({ id: 'core', priority: 10, minGuarantee: 80, weight: 1 });
  alloc.addTenant({ id: 'batch', priority: 1, minGuarantee: 50, weight: 100 });

  alloc.request({ id: 'core-r', tenantId: 'core', amount: 100, duration: 100 });
  alloc.request({ id: 'batch-r', tenantId: 'batch', amount: 100, duration: 100 });

  const core = alloc.tenantReport('core');
  const batch = alloc.tenantReport('batch');
  assert.equal(core.guaranteed, 80);
  assert.equal(core.guaranteeShortfall, 0);
  // batch 权重再高也无法挤占 core 的保障量，只能拿到剩余 20
  assert.equal(batch.guaranteed, 20);
  assert.equal(batch.guaranteeShortfall, 30);
  assert.equal(batch.elastic, 0);
  assert.equal(batch.requests[0].status, 'partial');
  assert.equal(batch.requests[0].reason, RejectionReason.INSUFFICIENT_CAPACITY);
});

test('撤销：释放的容量回收到原资源池并可被他人使用', () => {
  const alloc = new CapacityAllocator({
    pools: [
      { id: 'a1', failureDomain: 'A', capacity: 100 },
      { id: 'a2', failureDomain: 'A', capacity: 100 },
    ],
  }); // 可用 100
  alloc.addTenant({ id: 't1' });
  alloc.addTenant({ id: 't2' });

  alloc.request({ id: 'r1', tenantId: 't1', amount: 60, duration: 100 });
  alloc.request({ id: 'r2', tenantId: 't2', amount: 60, duration: 100 });
  // 权重相同 → 100 可用容量公平分配为 50/50
  assert.equal(alloc.tenantReport('t1').totalAllocated, 50);
  assert.equal(alloc.tenantReport('t2').totalAllocated, 50);

  const usedBefore = alloc.pools.map((p) => [p.id, p.used]);
  const result = alloc.release('r1');
  assert.equal(result.status, 'released');

  // r1 的 60 全部回收，t2 补齐到 60，全局占用回到 60
  assert.equal(alloc.tenantReport('t1').totalAllocated, 0);
  assert.equal(alloc.tenantReport('t2').totalAllocated, 60);
  const totalUsed = alloc.pools.reduce((s, p) => s + p.used, 0);
  assert.equal(totalUsed, 60);
  for (const [id, used] of usedBefore) {
    const pool = alloc.pools.find((p) => p.id === id);
    assert.ok(pool.used <= used, `pool ${id} 的容量没有回收`);
  }
  // 重复撤销
  assert.equal(alloc.release('r1').status, 'not_found');
});

test('到期释放：duration 到期后容量自动回收', () => {
  const alloc = makeAllocator();
  alloc.addTenant({ id: 't1' });
  alloc.request({ id: 'r1', tenantId: 't1', amount: 100, duration: 10 });
  assert.equal(alloc.tenantReport('t1').totalAllocated, 100);

  alloc.tick(5);
  assert.equal(alloc.tenantReport('t1').totalAllocated, 100);
  alloc.tick(10);
  assert.equal(alloc.tenantReport('t1').totalAllocated, 0);
  assert.equal(alloc.pools.reduce((s, p) => s + p.used, 0), 0);
});

test('重复申请：相同 request id 被拒绝且不计入需求', () => {
  const alloc = makeAllocator();
  alloc.addTenant({ id: 't1' });
  const first = alloc.request({ id: 'r1', tenantId: 't1', amount: 50, duration: 100 });
  const dup = alloc.request({ id: 'r1', tenantId: 't1', amount: 50, duration: 100 });

  assert.equal(first.status, 'fulfilled');
  assert.equal(dup.status, 'rejected');
  assert.equal(dup.reason, RejectionReason.DUPLICATE_REQUEST);
  assert.equal(alloc.tenantReport('t1').demand, 50);
  assert.equal(alloc.tenantReport('t1').totalAllocated, 50);
  assert.ok(alloc.plan().rejected.some((r) => r.reason === RejectionReason.DUPLICATE_REQUEST));
});

test('非法申请与未知租户被拒绝并记录原因', () => {
  const alloc = makeAllocator();
  alloc.addTenant({ id: 't1' });
  assert.equal(alloc.request({ id: 'bad', tenantId: 't1', amount: 0, duration: 1 }).reason,
    RejectionReason.INVALID_REQUEST);
  assert.equal(alloc.request({ id: 'x', tenantId: 'ghost', amount: 1, duration: 1 }).reason,
    RejectionReason.UNKNOWN_TENANT);
});

test('历史使用率影响弹性权重，但不影响保障量', () => {
  const alloc = makeAllocator(); // 可用 160
  alloc.addTenant({ id: 'hot', weight: 1, historicalUtilization: 1 });
  alloc.addTenant({ id: 'cold', weight: 1, historicalUtilization: 0 });
  alloc.request({ id: 'hot-r', tenantId: 'hot', amount: 160, duration: 100 });
  alloc.request({ id: 'cold-r', tenantId: 'cold', amount: 160, duration: 100 });

  const hot = alloc.tenantReport('hot');
  const cold = alloc.tenantReport('cold');
  // 有效权重 1 : 0.5 → 弹性 2:1
  assert.ok(hot.elastic > cold.elastic);
  assert.ok(Math.abs(hot.elastic - cold.elastic * 2) < 1e-6);
  assert.equal(hot.totalAllocated + cold.totalAllocated, 160);
});
