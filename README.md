# sre-capacity-reservation-auction
在租户、优先级和故障余量间竞配预留容量

## 概述

容量预留分配器（Node.js >= 24.16.0）。输入资源池、故障域、租户最低保障、
申请量、优先级、权重、预留时长和历史使用率，输出每个租户的保证量、
弹性容量和拒绝原因。

## 分配模型

每次变更（申请 / 撤销 / 到期）后整体重算，保证容量守恒：

1. **故障域迁移余量**：每个故障域默认按 N+1 预留余量（域内最大资源池的
   容量），用于跨故障域迁移，任何分配不得占用。也可用
   `headroom: { mode: 'explicit', reserve: { 域: 容量 } }` 显式指定。
2. **保障阶段**：按优先级从高到低，为每个租户预留
   `min(minGuarantee, 需求量)`。高优先级租户的保障量先被满足，
   核心服务在故障时始终保有可恢复资源。
3. **弹性阶段**：剩余可用容量按有效权重做加权最大最小公平分配。
   有效权重 = `weight * (0.5 + 0.5 * 历史利用率)`。

**权重仅用于内部公平分配**：权重只在弹性阶段决定租户间如何分享剩余
容量，不影响保障量、不参与优先级排序，高权重租户无法挤占其他租户的
最低保障。

## 关键约束

- 公平份额按**租户**计算而非按申请计算，拆分申请不能绕过总量限制。
- 释放（`release`）或到期（`tick` 推进时钟）后，容量回收到原资源池，
   可被其他租户重新分配。
- 相同 request id 重复提交会被拒绝（`DUPLICATE_REQUEST`），不计入需求。

## 使用示例

```js
import { CapacityAllocator } from './src/allocator.js';

const alloc = new CapacityAllocator({
  pools: [
    { id: 'a1', failureDomain: 'A', capacity: 100 },
    { id: 'a2', failureDomain: 'A', capacity: 100 },
  ],
});

alloc.addTenant({ id: 'core', priority: 10, minGuarantee: 80, weight: 1 });
alloc.request({ id: 'r1', tenantId: 'core', amount: 100, duration: 3600 });

console.log(alloc.tenantReport('core'));
// { guaranteed: 80, elastic: 20, totalAllocated: 100, requests: [...] }
console.log(alloc.plan()); // 资源池、故障域、租户与拒绝记录全量视图
```

## 输出

`tenantReport(id)` / `plan()` 中每个租户包含：

- `guaranteed`：保证量（保障阶段预留）。
- `elastic`：弹性容量（加权公平分配）。
- `guaranteeShortfall`：保障缺口。
- `requests[]`：每个申请的状态（`fulfilled` / `partial` / `rejected`）
  及拒绝原因（`INSUFFICIENT_CAPACITY`、`FAILURE_DOMAIN_HEADROOM`、
  `DUPLICATE_REQUEST`、`UNKNOWN_TENANT`、`INVALID_REQUEST`）。

## 测试

```sh
node --test
```

覆盖资源争抢、故障域约束、优先级保护、撤销、到期释放、重复申请与
拆分申请总量限制。
