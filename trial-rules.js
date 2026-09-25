// 配重试航台 —— 判定规则（业务口径的唯一出处）
// 记录层（trial-store.js）与页面（trial-page.js）都不得另立判定标准。

export const GEARS = ["轻载", "半载", "满载"];

// 保压状态下桅杆偏移上限：超过 2mm 即不合格
export const MAST_OFFSET_LIMIT_MM = 2;
// 卸重后回弹达标线：残余偏移不超过 0.5mm
export const RESIDUAL_OFFSET_LIMIT_MM = 0.5;

export const ACTIVE_STATUS = "进行中";
export const HOLD_STATUS = "停待修整";
export const PASS_STATUS = "试航通过";
export const INVALID_STATUS = "已失效";
// 只有“进行中 / 停待修整”占用每艘模型唯一的在制试航单名额
export const ACTIVE_STATUSES = [ACTIVE_STATUS, HOLD_STATUS];

export class TrialError extends Error {
  constructor(message) {
    super(message);
    this.name = "TrialError";
    this.statusCode = 400;
  }
}

function toNumber(value, label, { min = 0 } = {}) {
  const n = typeof value === "string" ? Number(value.trim()) : Number(value);
  if (value === "" || value === null || value === undefined || Number.isNaN(n)) {
    throw new TrialError(label + "必须是数字");
  }
  if (n < min) throw new TrialError(label + "不能小于" + min);
  return n;
}

function requireText(value, label) {
  const s = String(value ?? "").trim();
  if (!s) throw new TrialError(label + "不能为空");
  return s;
}

// 登记三档配重（kg）与保压时长（分钟）
export function normalizePlan(input = {}) {
  const w = input.weights || {};
  const weights = {};
  for (const gear of GEARS) weights[gear] = toNumber(w[gear], gear + "配重(kg)");
  if (weights["轻载"] > weights["半载"] || weights["半载"] > weights["满载"]) {
    throw new TrialError("三档配重应满足 轻载 ≤ 半载 ≤ 满载");
  }
  const holdMinutes = toNumber(input.holdMinutes, "保压时长(分钟)", { min: 1 });
  return { weights, holdMinutes };
}

// 登记三档各自的桅杆偏移（保压中）与卸重后残余偏移
export function normalizeReadings(input = {}) {
  const measuredBy = requireText(input.measuredBy, "测量操作工");
  const readings = {};
  for (const gear of GEARS) {
    const r = input[gear] || {};
    readings[gear] = {
      mastOffsetMm: toNumber(r.mastOffsetMm, gear + "桅杆偏移(mm)"),
      residualOffsetMm: toNumber(r.residualOffsetMm, gear + "卸重残余偏移(mm)"),
    };
  }
  return { ...readings, measuredBy };
}

// 单档判定：偏移超 2mm 或卸重回弹不达标即失败
export function evaluateGear(gear, reading) {
  const mastOk = reading.mastOffsetMm <= MAST_OFFSET_LIMIT_MM;
  const reboundOk = reading.residualOffsetMm <= RESIDUAL_OFFSET_LIMIT_MM;
  const messages = [];
  if (!mastOk) messages.push(`${gear}桅杆偏移 ${reading.mastOffsetMm}mm 超过 ${MAST_OFFSET_LIMIT_MM}mm`);
  if (!reboundOk) messages.push(`${gear}卸重后残余偏移 ${reading.residualOffsetMm}mm，回弹不达标（≤${RESIDUAL_OFFSET_LIMIT_MM}mm）`);
  return { gear, ...reading, mastOk, reboundOk, ok: mastOk && reboundOk, messages };
}

// 整船判定：三档全部合格才算通过
export function evaluateReadings(readings) {
  const checks = GEARS.map(gear => evaluateGear(gear, readings[gear]));
  const pass = checks.every(c => c.ok);
  return { pass, checks };
}

export function failureReasons(verdict) {
  if (!verdict || verdict.pass) return [];
  return verdict.checks.flatMap(c => c.messages);
}

// 每艘模型只留一份进行中的试航单
export function ensureCanStart(model, activeTrials, operator) {
  if (!model) throw new TrialError("模型不存在");
  requireText(operator, "操作工");
  const active = (activeTrials || [])[0];
  if (active) {
    throw new TrialError(`该模型已有进行中的试航单 ${active.no}（${active.status}），需先关闭或复测`);
  }
}

export function ensureCanSubmitReadings(trial) {
  if (!trial) throw new TrialError("试航单不存在");
  if (trial.status !== ACTIVE_STATUS) {
    throw new TrialError(`试航单 ${trial.no} 当前为「${trial.status}」，不能登记读数`);
  }
}

// 停待修整后才登记修整，且修整人不能是原操作工
export function ensureCanRepair(trial, repairer) {
  if (!trial) throw new TrialError("试航单不存在");
  const name = requireText(repairer, "修整人");
  if (trial.status !== HOLD_STATUS) {
    throw new TrialError(`试航单 ${trial.no} 当前为「${trial.status}」，无需登记修整`);
  }
  if (name === trial.operator) {
    throw new TrialError("修整人不能是原操作工（" + name + "），须换人修整");
  }
  return name;
}

// 复测前必须已有修整记录
export function ensureCanRetest(trial) {
  if (!trial) throw new TrialError("试航单不存在");
  if (trial.status !== HOLD_STATUS) {
    throw new TrialError(`试航单 ${trial.no} 当前为「${trial.status}」，不能复测`);
  }
  if (!trial.repair) throw new TrialError("尚未登记修整，不能复测");
}

// 结论只对“试航时的索具材料 + 三档配重”这一组合负责
export function signatureFor(model, plan) {
  return { riggingMaterial: model.riggingMaterial || "", weights: { ...plan.weights } };
}

export function sameWeights(a = {}, b = {}) {
  return GEARS.every(g => Number(a[g]) === Number(b[g]));
}

export function invalidateTrial(trial, reason) {
  trial.status = INVALID_STATUS;
  trial.events ||= [];
  trial.events.push({ at: new Date().toISOString(), type: "失效", note: reason });
  return trial;
}

export function isPassed(trial) {
  return !!trial && trial.status === PASS_STATUS;
}

// 通过结论仍然有效：未被标记失效，且索具材料与模型当前一致
export function isValidPass(trial, model) {
  return isPassed(trial)
    && !!model
    && trial.signature.riggingMaterial === (model.riggingMaterial || "");
}
