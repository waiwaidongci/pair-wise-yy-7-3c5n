// 配重试航台 —— 记录：试航单及全流程记录的唯一出入口。
// 判定规则不写在这里，统一委托 judge.js；页面只通过这里读写。

import {
  TRIAL_RULES,
  TRIAL_STATE,
  TIER_LABELS,
  judgeRound,
  checkRepairer,
  materialSnapshot,
  snapshotStale,
  deliveryGate,
} from "./judge.js";

export class TrialError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const nowIso = () => new Date().toISOString();
const newTrialId = () => "TR-" + Date.now() + "-" + Math.floor(Math.random() * 900 + 100);

function findItem(db, key) {
  return db.items.find((x) => x.id === key || x.code === key);
}

// 每艘模型最多只有一份“进行中”（进行中 / 待修整）的试航单。
export function listItemTrials(db, itemKey) {
  return (db.trials || []).filter((t) => t.itemId === itemKey || t.itemCode === itemKey);
}

function openTrial(db, item) {
  return listItemTrials(db, item.code).find(
    (t) => t.state === TRIAL_STATE.IN_PROGRESS || t.state === TRIAL_STATE.NEEDS_REPAIR,
  );
}

function assertOperator(operator, label = "操作工") {
  const name = String(operator || "").trim();
  if (!name) throw new TrialError("operator_required", `必须登记${label}`);
  return name;
}

function parseTiers(input) {
  if (!Array.isArray(input) || input.length !== TRIAL_RULES.TIER_COUNT) {
    throw new TrialError("tiers_required", `必须登记三档配重（轻载/标准/重载）`);
  }
  return input.map((raw, index) => {
    const tier = raw || {};
    const weightKg = Number(tier.weightKg);
    const holdMinutes = Number(tier.holdMinutes);
    const mastOffsetMm = Number(tier.mastOffsetMm);
    if (!Number.isFinite(weightKg) || weightKg <= 0) {
      throw new TrialError("invalid_tier", `${TIER_LABELS[index]}配重重量须为大于 0 的数字`);
    }
    if (!Number.isFinite(holdMinutes) || holdMinutes <= 0) {
      throw new TrialError("invalid_tier", `${TIER_LABELS[index]}保压时长须为大于 0 的分钟数`);
    }
    if (!Number.isFinite(mastOffsetMm) || mastOffsetMm < 0) {
      throw new TrialError("invalid_tier", `${TIER_LABELS[index]}桅杆偏移须为不小于 0 的毫米数`);
    }
    return {
      tier: index + 1,
      label: TIER_LABELS[index],
      weightKg,
      holdMinutes,
      mastOffsetMm,
    };
  });
}

function parseUnload(input) {
  const residualOffsetMm = Number(input && input.residualOffsetMm);
  if (!Number.isFinite(residualOffsetMm) || residualOffsetMm < 0) {
    throw new TrialError("invalid_unload", "卸重后残余偏移须为不小于 0 的毫米数");
  }
  return { residualOffsetMm };
}

function pushItemLog(item, step, note) {
  item.logs ||= [];
  item.logs.push({ at: nowIso(), step, note });
}

// 开立试航单（不填测量数据；测量在“登记轮次”时提交）。
export function createTrial(db, itemKey, payload) {
  const item = findItem(db, itemKey);
  if (!item) throw new TrialError("item_not_found", "模型不存在");
  const operator = assertOperator(payload && payload.operator);
  const existing = openTrial(db, item);
  if (existing) {
    throw new TrialError("trial_already_open", `该模型已有一份进行中的试航单（${existing.id}，${existing.state}），不能重复开立`);
  }
  db.trials ||= [];
  const trial = {
    id: newTrialId(),
    itemId: item.id,
    itemCode: item.code,
    shipType: item.shipType,
    state: TRIAL_STATE.IN_PROGRESS,
    openedAt: nowIso(),
    openedBy: operator,
    rounds: [],
    repairs: [],
    history: [{ at: nowIso(), action: "开立试航单", by: operator, note: (payload && payload.note) || "" }],
  };
  db.trials.unshift(trial);
  pushItemLog(item, "试航", `开立试航单 ${trial.id}，操作工 ${operator}`);
  return trial;
}

function getTrial(db, item, trialId) {
  const trial = (db.trials || []).find(
    (t) => t.id === trialId && (t.itemId === item.id || t.itemCode === item.code),
  );
  if (!trial) throw new TrialError("trial_not_found", "试航单不存在");
  return trial;
}

// 登记一轮测量（初测 / 复测），直接给出判定。
export function addRound(db, itemKey, trialId, payload) {
  const item = findItem(db, itemKey);
  if (!item) throw new TrialError("item_not_found", "模型不存在");
  const trial = getTrial(db, item, trialId);
  // 先做输入校验，再做状态校验，保证错误信息对得上操作人的实际问题。
  const operator = assertOperator(payload && payload.operator);
  const tiers = parseTiers(payload && payload.tiers);
  const unload = parseUnload(payload && payload.unload);

  if (trial.state === TRIAL_STATE.PASSED) throw new TrialError("trial_finished", "试航已合格，无需再测");
  if (trial.state === TRIAL_STATE.INVALID) throw new TrialError("trial_invalid", "试航单已失效，请重新开立");

  const isRetest = trial.rounds.length > 0;
  if (trial.state === TRIAL_STATE.NEEDS_REPAIR) {
    const lastFailure = trial.repairs.filter((r) => r.roundNo === trial.rounds.length).pop();
    if (!lastFailure) {
      throw new TrialError("repair_required", "上轮判定停待修整，必须先由非原操作工登记修整后才能复测");
    }
  }

  const round = {
    no: trial.rounds.length + 1,
    kind: isRetest ? "复测" : "初测",
    at: nowIso(),
    operator,
    tiers,
    unload,
    snapshot: materialSnapshot(item),
    note: String((payload && payload.note) || ""),
  };
  const verdict = judgeRound(round);
  round.verdict = verdict;
  trial.rounds.push(round);

  if (verdict.passed) {
    trial.state = TRIAL_STATE.PASSED;
    trial.passedAt = round.at;
    pushItemLog(item, "试航", `${trial.id} 第${round.no}轮${round.kind}合格（操作工 ${operator}），恢复交付`);
    trial.history.push({ at: round.at, action: `${round.kind}合格`, by: operator, note: verdict.reason || "" });
    if (item.status === "待修整") item.status = "待复核";
  } else {
    trial.state = TRIAL_STATE.NEEDS_REPAIR;
    const reason = verdict.failures.map((f) => f.message).join("；");
    pushItemLog(item, "试航停待", `${trial.id} 第${round.no}轮${round.kind}不合格（操作工 ${operator}）：${reason}`);
    trial.history.push({ at: round.at, action: `${round.kind}不合格，停待修整`, by: operator, note: reason });
    item.status = "待修整";
  }
  return trial;
}

// 登记修整；修整人不能是原操作工。
export function addRepair(db, itemKey, trialId, payload) {
  const item = findItem(db, itemKey);
  if (!item) throw new TrialError("item_not_found", "模型不存在");
  const trial = getTrial(db, item, trialId);
  const repairer = assertOperator(payload && payload.repairer, "修整人");
  const note = String((payload && payload.note) || "").trim();
  if (!note) throw new TrialError("repair_note_required", "必须填写修整内容");
  if (trial.state !== TRIAL_STATE.NEEDS_REPAIR) {
    throw new TrialError("repair_not_needed", `当前试航单状态为「${trial.state}」，不能登记修整`);
  }
  const failedRound = trial.rounds[trial.rounds.length - 1];
  const guard = checkRepairer(failedRound, repairer);
  if (!guard.allowed) throw new TrialError("repairer_must_differ", guard.reason);

  const repair = {
    at: nowIso(),
    roundNo: failedRound.no,
    repairer,
    note,
  };
  trial.repairs.push(repair);
  pushItemLog(item, "试航修整", `${trial.id} 由 ${repairer} 修整（原操作工 ${failedRound.operator}）：${note}`);
  trial.history.push({ at: repair.at, action: "登记修整", by: repairer, note });
  return trial;
}

// 配重或帆索材料改动 → 旧合格结论立即失效。
export function invalidateOnItemUpdate(db, item, changes) {
  const before = materialSnapshot(item);
  const after = {
    riggingMaterial:
      changes.riggingMaterial !== undefined ? String(changes.riggingMaterial ?? "").trim() : before.riggingMaterial,
    ballastSpec: changes.ballastSpec !== undefined ? String(changes.ballastSpec ?? "").trim() : before.ballastSpec,
  };
  const changed = [];
  if (after.riggingMaterial !== before.riggingMaterial) changed.push("帆索材料");
  if (after.ballastSpec !== before.ballastSpec) changed.push("配重");
  if (changed.length === 0) return [];

  const invalidated = [];
  for (const trial of db.trials || []) {
    if ((trial.itemId !== item.id && trial.itemCode !== item.code) || trial.state !== TRIAL_STATE.PASSED) continue;
    trial.state = TRIAL_STATE.INVALID;
    trial.invalidatedAt = nowIso();
    trial.invalidReason = `${changed.join("、")}改动，旧试航结论失效，须重新试航`;
    trial.history.push({ at: trial.invalidatedAt, action: "结论失效", by: "系统", note: trial.invalidReason });
    pushItemLog(item, "试航失效", `${trial.id} ${trial.invalidReason}`);
    invalidated.push(trial);
  }
  return invalidated;
}

// 页面/接口读取用：带判定门禁的试航单视图。
export function trialView(db, trial, item) {
  const gate = deliveryGate(item, trial);
  const latestRound = trial.rounds[trial.rounds.length - 1] || null;
  return {
    ...trial,
    itemStatus: item.status,
    materialCurrent: materialSnapshot(item),
    latestRoundStale: latestRound ? snapshotStale(item, latestRound.snapshot) : false,
    deliveryAllowed: gate.allowed,
    gateReason: gate.reason,
  };
}
