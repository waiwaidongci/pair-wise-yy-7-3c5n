// 配重试航台 —— 判定：所有合格/不合格的业务规则只集中在这一处。
// 记录层（records.js）和页面层（trials-page.js）都不得自行改写这些阈值与结论。

export const TRIAL_RULES = {
  TIER_COUNT: 3, // 三档配重：轻载 / 标准 / 重载
  // 桅杆偏移“超两毫米”即不合格（2.0mm 整不算超）。
  MAX_MAST_OFFSET_MM: 2,
  // 卸重后残余偏移上限：残余 ≤ 0.5mm 才视为回弹达标。
  RESIDUAL_OFFSET_LIMIT_MM: 0.5,
};

export const TRIAL_STATE = {
  IN_PROGRESS: "进行中",
  NEEDS_REPAIR: "待修整",
  PASSED: "合格",
  INVALID: "失效",
};

export const TIER_LABELS = ["一档（轻载）", "二档（标准）", "三档（重载）"];

// 判定一轮试航（初测或复测同一套规则）。
export function judgeRound(round) {
  const failures = [];
  round.tiers.forEach((tier, index) => {
    if (Number(tier.mastOffsetMm) > TRIAL_RULES.MAX_MAST_OFFSET_MM) {
      failures.push({
        code: "mast_offset_over_limit",
        message: `${TIER_LABELS[index]}桅杆偏移 ${tier.mastOffsetMm}mm，超过 ${TRIAL_RULES.MAX_MAST_OFFSET_MM}mm 红线`,
      });
    }
  });
  const residualOffsetMm = Number(round.unload.residualOffsetMm);
  if (residualOffsetMm > TRIAL_RULES.RESIDUAL_OFFSET_LIMIT_MM) {
    failures.push({
      code: "rebound_not_recovered",
      message: `卸重后残余偏移 ${residualOffsetMm}mm，回弹不达标（上限 ${TRIAL_RULES.RESIDUAL_OFFSET_LIMIT_MM}mm）`,
    });
  }
  const maxOffsetMm = Math.max(...round.tiers.map((t) => Number(t.mastOffsetMm)));
  return {
    passed: failures.length === 0,
    failures,
    metrics: { maxOffsetMm, residualOffsetMm },
  };
}

// 修整人不能是原操作工（即跑出不合格结论那一轮的操作工）。
export function checkRepairer(failedRound, repairer) {
  const name = String(repairer || "").trim();
  if (!name) return { allowed: false, reason: "必须登记修整人" };
  if (failedRound && name === failedRound.operator) {
    return { allowed: false, reason: `修整人不能是原操作工（${failedRound.operator}），须换人修整` };
  }
  return { allowed: true };
}

// 结论成立时所依据的模型配置快照：配重配置 + 帆索材料。
export function materialSnapshot(item) {
  return {
    riggingMaterial: String(item.riggingMaterial ?? "").trim(),
    ballastSpec: String(item.ballastSpec ?? "").trim(),
  };
}

export function snapshotStale(item, snapshot) {
  if (!snapshot) return true;
  const current = materialSnapshot(item);
  return current.riggingMaterial !== snapshot.riggingMaterial || current.ballastSpec !== snapshot.ballastSpec;
}

// 交付门禁：没有合格且未失效的试航结论，一律不能报交付。
export function deliveryGate(item, trial) {
  if (!trial) return { allowed: false, reason: "未做整船静载试航，不能直接报交付" };
  if (trial.state === TRIAL_STATE.INVALID) {
    return { allowed: false, reason: trial.invalidReason || "配重或索具材料已改动，旧结论失效，须重新试航" };
  }
  if (trial.state === TRIAL_STATE.IN_PROGRESS) {
    return { allowed: false, reason: "试航单仍在进行中，尚未得出结论" };
  }
  if (trial.state === TRIAL_STATE.NEEDS_REPAIR) {
    return { allowed: false, reason: "试航不合格已停待修整，须复测通过后方可交付" };
  }
  const latestRound = trial.rounds[trial.rounds.length - 1];
  if (latestRound && snapshotStale(item, latestRound.snapshot)) {
    return { allowed: false, reason: "配重或索具材料已改动，旧结论失效，须重新试航" };
  }
  return { allowed: true, reason: "试航合格，可进入交付" };
}
