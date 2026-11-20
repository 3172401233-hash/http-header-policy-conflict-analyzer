const EPSILON = 1e-9;

export const RejectionReason = Object.freeze({
  DUPLICATE_REQUEST: 'DUPLICATE_REQUEST',
  UNKNOWN_TENANT: 'UNKNOWN_TENANT',
  INVALID_REQUEST: 'INVALID_REQUEST',
  INSUFFICIENT_CAPACITY: 'INSUFFICIENT_CAPACITY',
  FAILURE_DOMAIN_HEADROOM: 'FAILURE_DOMAIN_HEADROOM',
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 容量预留分配器。
 *
 * 分配顺序（每次变更后整体重算，保证守恒与可撤销）：
 * 1. 保障阶段：按优先级从高到低，为每个租户预留 min(minGuarantee, 需求量)。
 * 2. 弹性阶段：剩余可用容量按“有效权重”做加权最大最小公平分配。
 *    有效权重 = weight * (0.5 + 0.5 * 历史利用率)，权重仅用于内部公平分配，
 *    不影响保障量与优先级。
 *
 * 故障域余量：每个故障域预留 N+1 余量（域内最大资源池容量），
 * 用于跨故障域迁移，任何分配不得占用该余量。
 */
export class CapacityAllocator {
  constructor({ pools, headroom = { mode: 'n+1' } }) {
    if (!Array.isArray(pools) || pools.length === 0) {
      throw new Error('at least one resource pool is required');
    }
    this.pools = pools.map((p) => ({ ...p, used: 0 }));
    this.headroom = headroom;
    this.tenants = new Map();
    this.requests = new Map();
    this.rejected = [];
    this.now = 0;
    this._tenantReports = new Map();
    this._recompute();
  }

  addTenant({ id, minGuarantee = 0, priority = 0, weight = 1, historicalUtilization = null }) {
    if (this.tenants.has(id)) throw new Error(`tenant already exists: ${id}`);
    this.tenants.set(id, {
      id,
      minGuarantee,
      priority,
      weight,
      historicalUtilization,
    });
    this._recompute();
    return this.tenantReport(id);
  }

  request({ id, tenantId, amount, duration = Infinity, submittedAt = null }) {
    const reject = (reason) => {
      this.rejected.push({ requestId: id ?? null, tenantId: tenantId ?? null, reason });
      return { requestId: id ?? null, status: 'rejected', reason };
    };
    if (id == null || typeof amount !== 'number' || !(amount > 0) || !(duration > 0)) {
      return reject(RejectionReason.INVALID_REQUEST);
    }
    if (this.requests.has(id)) return reject(RejectionReason.DUPLICATE_REQUEST);
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return reject(RejectionReason.UNKNOWN_TENANT);

    this.requests.set(id, {
      id,
      tenantId,
      amount,
      duration,
      submittedAt: submittedAt ?? this.now,
      sequence: this.requests.size,
    });
    this._recompute();
    return this._requestStatus(id);
  }

  release(requestId) {
    if (!this.requests.has(requestId)) {
      return { requestId, status: 'not_found' };
    }
    this.requests.delete(requestId);
    this._recompute();
    return { requestId, status: 'released' };
  }

  /** 推进时钟，到期申请自动释放，容量回收到原资源池。 */
  tick(now) {
    this.now = now;
    for (const [id, req] of [...this.requests]) {
      if (req.submittedAt + req.duration <= now) this.requests.delete(id);
    }
    this._recompute();
  }

  tenantReport(tenantId) {
    return this._tenantReports.get(tenantId) ?? null;
  }

  plan() {
    return {
      pools: this.pools.map((p) => ({
        id: p.id,
        failureDomain: p.failureDomain,
        capacity: p.capacity,
        used: p.used,
        free: p.capacity - p.used,
      })),
      domains: this._domains().map((d) => ({
        failureDomain: d,
        capacity: this._domainCapacity(d),
        reservedHeadroom: this._domainReserve(d),
        usable: this._domainUsable(d),
        used: this._domainUsed(d),
      })),
      tenants: [...this._tenantReports.values()],
      rejected: [...this.rejected],
    };
  }

  // ---- 内部实现 ----

  _domains() {
    return [...new Set(this.pools.map((p) => p.failureDomain))];
  }

  _domainCapacity(domain) {
    return this.pools
      .filter((p) => p.failureDomain === domain)
      .reduce((sum, p) => sum + p.capacity, 0);
  }

  _domainUsed(domain) {
    return this.pools
      .filter((p) => p.failureDomain === domain)
      .reduce((sum, p) => sum + p.used, 0);
  }

  _domainReserve(domain) {
    if (this.headroom.mode === 'explicit') {
      return this.headroom.reserve?.[domain] ?? 0;
    }
    const caps = this.pools
      .filter((p) => p.failureDomain === domain)
      .map((p) => p.capacity);
    // N+1：预留域内最大资源池的容量，作为跨故障域迁移余量。
    return caps.length >= 2 ? Math.max(...caps) : 0;
  }

  _domainUsable(domain) {
    return this._domainCapacity(domain) - this._domainReserve(domain);
  }

  _poolFree(pool) {
    const domainFree = this._domainUsable(pool.failureDomain) - this._domainUsed(pool.failureDomain);
    return Math.max(0, Math.min(pool.capacity - pool.used, domainFree));
  }

  _totalFree() {
    let total = 0;
    for (const domain of this._domains()) {
      const poolFree = this.pools
        .filter((p) => p.failureDomain === domain)
        .reduce((sum, p) => sum + (p.capacity - p.used), 0);
      const domainFree = this._domainUsable(domain) - this._domainUsed(domain);
      total += Math.max(0, Math.min(poolFree, domainFree));
    }
    return total;
  }

  /** 将 amount 放入资源池（允许拆分），返回实际放置量并记账。 */
  _place(amount) {
    let remaining = amount;
    const candidates = this.pools
      .filter((p) => this._poolFree(p) > EPSILON)
      .sort((a, b) => this._poolFree(b) - this._poolFree(a));
    for (const pool of candidates) {
      if (remaining <= EPSILON) break;
      const take = Math.min(remaining, this._poolFree(pool));
      pool.used += take;
      remaining -= take;
    }
    return amount - Math.max(0, remaining);
  }

  _effectiveWeight(tenant) {
    const utilization = tenant.historicalUtilization == null
      ? 1
      : clamp(tenant.historicalUtilization, 0, 1);
    return tenant.weight * (0.5 + 0.5 * utilization);
  }

  /** 加权最大最小公平分配：demands 为 Map<tenantId, demand>。 */
  _fairShare(capacity, demands, weightOf) {
    const allocation = new Map([...demands.keys()].map((id) => [id, 0]));
    const active = new Map(demands);
    let remaining = capacity;
    while (remaining > EPSILON && active.size > 0) {
      const totalWeight = [...active.keys()].reduce((s, id) => s + weightOf(id), 0);
      if (totalWeight <= EPSILON) break;
      const roundCapacity = remaining;
      let progressed = false;
      for (const [id, demand] of [...active]) {
        const share = (roundCapacity * weightOf(id)) / totalWeight;
        const grant = Math.min(share, demand);
        allocation.set(id, allocation.get(id) + grant);
        remaining -= grant;
        if (grant >= demand - EPSILON) active.delete(id);
        else active.set(id, demand - grant);
        progressed = true;
      }
      if (!progressed) break;
    }
    return allocation;
  }

  _recompute() {
    for (const pool of this.pools) pool.used = 0;

    const tenantDemand = new Map();
    for (const req of this.requests.values()) {
      tenantDemand.set(req.tenantId, (tenantDemand.get(req.tenantId) ?? 0) + req.amount);
    }

    const guaranteed = new Map();
    const elastic = new Map();
    const guaranteeShortfall = new Map();

    // 阶段一：保障量，按优先级保护（高优先级先预留）。
    const byPriority = [...this.tenants.values()]
      .filter((t) => tenantDemand.has(t.id))
      .sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1));
    for (const tenant of byPriority) {
      const demand = tenantDemand.get(tenant.id);
      const target = Math.min(tenant.minGuarantee, demand);
      const placed = this._place(target);
      guaranteed.set(tenant.id, placed);
      if (placed < target - EPSILON) {
        guaranteeShortfall.set(tenant.id, target - placed);
      }
    }

    // 阶段二：弹性容量，按有效权重公平分配（权重仅用于内部公平分配）。
    const elasticDemand = new Map();
    for (const [tenantId, demand] of tenantDemand) {
      const rest = demand - (guaranteed.get(tenantId) ?? 0);
      if (rest > EPSILON) elasticDemand.set(tenantId, rest);
    }
    const shares = this._fairShare(this._totalFree(), elasticDemand, (id) =>
      this._effectiveWeight(this.tenants.get(id)),
    );
    const unplaced = new Map();
    for (const [tenantId, share] of shares) {
      if (share <= EPSILON) {
        elastic.set(tenantId, 0);
        continue;
      }
      const placed = this._place(share);
      elastic.set(tenantId, placed);
      if (placed < share - EPSILON) unplaced.set(tenantId, share - placed);
    }

    // 汇总到请求级：按提交顺序先填保障、再填弹性。
    this._tenantReports = new Map();
    for (const tenant of this.tenants.values()) {
      let guaranteeLeft = guaranteed.get(tenant.id) ?? 0;
      let elasticLeft = elastic.get(tenant.id) ?? 0;
      const requests = [...this.requests.values()]
        .filter((r) => r.tenantId === tenant.id)
        .sort((a, b) => a.sequence - b.sequence)
        .map((req) => {
          let allocated = 0;
          const fromGuarantee = Math.min(guaranteeLeft, req.amount);
          guaranteeLeft -= fromGuarantee;
          allocated += fromGuarantee;
          const fromElastic = Math.min(elasticLeft, req.amount - allocated);
          elasticLeft -= fromElastic;
          allocated += fromElastic;

          let status = 'fulfilled';
          let reason = null;
          if (allocated <= EPSILON) {
            status = 'rejected';
            reason = this._shortageReason(tenant.id, guaranteeShortfall, unplaced);
          } else if (allocated < req.amount - EPSILON) {
            status = 'partial';
            reason = this._shortageReason(tenant.id, guaranteeShortfall, unplaced);
          }
          return {
            requestId: req.id,
            requested: req.amount,
            allocated,
            guaranteedPortion: fromGuarantee,
            elasticPortion: fromElastic,
            status,
            reason,
          };
        });

      this._tenantReports.set(tenant.id, {
        tenantId: tenant.id,
        demand: tenantDemand.get(tenant.id) ?? 0,
        guaranteed: guaranteed.get(tenant.id) ?? 0,
        elastic: elastic.get(tenant.id) ?? 0,
        totalAllocated: (guaranteed.get(tenant.id) ?? 0) + (elastic.get(tenant.id) ?? 0),
        guaranteeShortfall: guaranteeShortfall.get(tenant.id) ?? 0,
        requests,
      });
    }
  }

  _shortageReason(tenantId, guaranteeShortfall, unplaced) {
    if ((unplaced.get(tenantId) ?? 0) > EPSILON) {
      return RejectionReason.FAILURE_DOMAIN_HEADROOM;
    }
    return RejectionReason.INSUFFICIENT_CAPACITY;
  }

  _requestStatus(requestId) {
    for (const report of this._tenantReports.values()) {
      const entry = report.requests.find((r) => r.requestId === requestId);
      if (entry) return entry;
    }
    return { requestId, status: 'rejected', reason: RejectionReason.INVALID_REQUEST };
  }
}
