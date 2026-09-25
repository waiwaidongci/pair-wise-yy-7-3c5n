// 配重试航台 —— 记录层：试航单的登记、持久化与状态流转
// 判定口径统一调用 trial-rules.js，本模块只负责把单据落到 JSON 并追加事件流水。

import {
  ACTIVE_STATUS,
  HOLD_STATUS,
  PASS_STATUS,
  ACTIVE_STATUSES,
  normalizePlan,
  normalizeReadings,
  evaluateReadings,
  ensureCanStart,
  ensureCanSubmitReadings,
  ensureCanRepair,
  ensureCanRetest,
  signatureFor,
  sameWeights,
  invalidateTrial,
  isValidPass,
} from "./trial-rules.js";

const now = () => new Date().toISOString();
// 试航单统一按模型编号 code 关联（code 为空时才退回 id）
export const modelRef = model => model.code || model.id;
// 兼容历史数据：个别试航单曾按内部 id 关联
function refsOf(model) {
  return [model.code, model.id].filter(v => v);
}
const matchesModel = (trial, model) => refsOf(model).includes(trial.modelRef);

// 结论失效且模型已交付：撤回交付，待复测通过后恢复
function recallDelivered(model, reason) {
  if (model.status !== "已交付") return;
  model.status = "待复核";
  model.logs ||= [];
  model.logs.push({ at: now(), step: "撤回交付", note: reason });
}

function ensureCollection(db) {
  db.trials ||= [];
  return db.trials;
}

export function findModel(db, ref) {
  return db.items.find(m => m.id === ref || m.code === ref);
}

export function listTrials(db, model) {
  const trials = ensureCollection(db);
  const list = model ? trials.filter(t => matchesModel(t, model)) : trials.slice();
  return list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function findTrial(db, id) {
  return ensureCollection(db).find(t => t.id === id || t.no === id);
}

export function activeTrialFor(db, model) {
  return ensureCollection(db).find(t => matchesModel(t, model) && ACTIVE_STATUSES.includes(t.status));
}

function latestPassedFor(db, model) {
  return ensureCollection(db)
    .filter(t => matchesModel(t, model) && t.status === PASS_STATUS)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0] || null;
}

// 配重或索具材料改动会让旧结论失效
function invalidateObsolete(db, model, plan, reason) {
  const invalidated = [];
  for (const trial of ensureCollection(db)) {
    if (!matchesModel(trial, model) || trial.status !== PASS_STATUS) continue;
    const materialChanged = trial.signature.riggingMaterial !== (model.riggingMaterial || "");
    const weightsChanged = !sameWeights(trial.signature.weights, plan.weights);
    if (materialChanged || weightsChanged) {
      invalidateTrial(trial, reason);
      invalidated.push(trial);
    }
  }
  if (invalidated.length) recallDelivered(model, "试航配重或索具材料改动，旧结论失效，撤回交付待复测");
  return invalidated;
}

function nextNo(db, model) {
  const code = model.code || model.id;
  const count = ensureCollection(db).filter(t => matchesModel(t, model)).length;
  return `SY-${code}-${String(count + 1).padStart(2, "0")}`;
}

// 开工：每艘模型只留一份进行中的试航单
export function startTrial(db, model, input, saveDb) {
  const trials = ensureCollection(db);
  ensureCanStart(model, trials.filter(t => matchesModel(t, model) && ACTIVE_STATUSES.includes(t.status)), input.operator);
  const plan = normalizePlan(input);
  const operator = String(input.operator).trim();

  // 新试航单若换了配重，该模型既往通过结论立即失效
  const invalidated = invalidateObsolete(db, model, plan, "试航配重或索具材料改动，旧结论失效");

  const trial = {
    id: "SY-" + Date.now(),
    no: nextNo(db, model),
    modelRef: modelRef(model),
    modelCode: model.code || model.id,
    plan,
    operator,
    status: ACTIVE_STATUS,
    readings: null,
    verdict: null,
    measuredBy: null,
    repair: null,
    retests: [],
    signature: signatureFor(model, plan),
    createdAt: now(),
    updatedAt: now(),
    events: [{ at: now(), type: "开工", note: `操作工 ${operator}；三档配重 ${plan.weights["轻载"]}/${plan.weights["半载"]}/${plan.weights["满载"]}kg；保压 ${plan.holdMinutes} 分钟` }],
  };
  trials.unshift(trial);
  saveDb(db);
  return { trial, invalidated };
}

// 登记读数：三档桅杆偏移、卸重残余偏移，当场判定
export function submitReadings(db, trial, input, saveDb) {
  ensureCanSubmitReadings(trial);
  const readings = normalizeReadings(input);
  const verdict = evaluateReadings(readings);

  trial.readings = Object.fromEntries(
    ["轻载", "半载", "满载"].map(g => [g, { mastOffsetMm: readings[g].mastOffsetMm, residualOffsetMm: readings[g].residualOffsetMm }])
  );
  trial.measuredBy = readings.measuredBy;
  trial.verdict = verdict;
  trial.status = verdict.pass ? PASS_STATUS : HOLD_STATUS;
  trial.updatedAt = now();
  trial.events.push({
    at: now(),
    type: verdict.pass ? "初测通过" : "停待修整",
    note: verdict.pass
      ? `三档偏移与卸重回弹均达标，测量操作工 ${readings.measuredBy}`
      : "停待修整：" + verdict.checks.flatMap(c => c.messages).join("；"),
  });
  saveDb(db);
  return trial;
}

// 停待修整：登记修整人（不得为原操作工）与修整说明
export function registerRepair(db, trial, input, saveDb) {
  const repairer = ensureCanRepair(trial, input.repairer);
  const note = String(input.note ?? "").trim();
  if (!note) throw new Error("修整说明不能为空");
  trial.repair = { repairer, note, at: now() };
  trial.updatedAt = now();
  trial.events.push({ at: now(), type: "修整", note: `修整人 ${repairer}：${note}` });
  saveDb(db);
  return trial;
}

// 修整后复测：复测通过才恢复交付
export function submitRetest(db, trial, input, saveDb) {
  ensureCanRetest(trial);
  const readings = normalizeReadings(input);
  const verdict = evaluateReadings(readings);
  const record = { at: now(), measuredBy: readings.measuredBy, readings, verdict };
  trial.retests.push(record);
  trial.updatedAt = now();
  if (verdict.pass) {
    trial.readings = Object.fromEntries(
      ["轻载", "半载", "满载"].map(g => [g, { mastOffsetMm: readings[g].mastOffsetMm, residualOffsetMm: readings[g].residualOffsetMm }])
    );
    trial.measuredBy = readings.measuredBy;
    trial.verdict = verdict;
    trial.status = PASS_STATUS;
    trial.events.push({ at: now(), type: "复测通过", note: `复测达标，恢复交付；测量操作工 ${readings.measuredBy}` });
  } else {
    trial.events.push({ at: now(), type: "复测未过", note: "继续停待修整：" + verdict.checks.flatMap(c => c.messages).join("；") });
  }
  saveDb(db);
  return trial;
}

// 索具材料改动：该模型所有通过结论失效
export function invalidateForMaterialChange(db, model, oldMaterial, saveDb) {
  const nextMaterial = model.riggingMaterial || "";
  if (oldMaterial === nextMaterial) return [];
  const invalidated = ensureCollection(db)
    .filter(t => matchesModel(t, model) && t.status === PASS_STATUS)
    .map(t => invalidateTrial(t, `帆索材料由「${oldMaterial || "未填"}」改为「${nextMaterial || "未填"}」，旧结论失效`));
  if (invalidated.length) {
    recallDelivered(model, "帆索材料改动使试航结论失效，撤回交付待复测");
    saveDb(db);
  }
  return invalidated;
}

// 交付闸口：必须有有效通过结论。
// 配重改动会在开新试航单时把旧通过单置为「已失效」，索具材料改动由 PATCH 同步置失效，
// 因此这里只要最近的通过单仍为「试航通过」且索具材料与模型当前一致即可放行。
export function hasValidPass(db, model) {
  const latest = latestPassedFor(db, model);
  if (!latest) return { ok: false, reason: "尚无试航通过结论，需先完成整船静载试航", trial: null };
  if (!isValidPass(latest, model)) {
    return { ok: false, reason: `试航单 ${latest.no} 的结论已失效（索具材料或配重改动），需重新试航`, trial: latest };
  }
  return { ok: true, trial: latest };
}
