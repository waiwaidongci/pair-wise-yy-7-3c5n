// 配重试航台 —— 页面：试航单操作台（唯一的展示/交互业务代码）。
// 判定阈值与状态流转不在页面里重写，只调用 /api/trials* 接口并展示服务端结论。

import { TRIAL_RULES, TRIAL_STATE, TIER_LABELS } from "./judge.js";

export function trialsPage() {
  const rules = {
    tierCount: TRIAL_RULES.TIER_COUNT,
    maxOffset: TRIAL_RULES.MAX_MAST_OFFSET_MM,
    residualLimit: TRIAL_RULES.RESIDUAL_OFFSET_LIMIT_MM,
    states: TRIAL_STATE,
    tierLabels: TIER_LABELS,
  };
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古船模型配重试航台</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --hold:#8a6d1f; --ok:#3f6b3a; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } h3 { margin:0; font-size:17px; }
    main { display:grid; grid-template-columns:400px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 12px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; } button.warn { background:var(--warn); }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 9px; font-size:12px; }
    .pill.prog { color:var(--hold); border-color:var(--hold); } .pill.repair { color:#fff; background:var(--warn); border-color:var(--warn); }
    .pill.pass { color:#fff; background:var(--ok); border-color:var(--ok); } .pill.invalid { color:#fff; background:#8a3024; border-color:#8a3024; }
    .banner { background:#f6f1df; border:1px solid #d8c98a; border-radius:8px; padding:12px 14px; margin-bottom:14px; font-size:13px; line-height:1.7; }
    .banner b { color:var(--warn); }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(360px,1fr)); gap:12px; align-items:start; }
    .card { display:grid; gap:10px; } .card .gate { border-radius:6px; padding:8px 10px; font-size:13px; }
    .gate.blocked { background:#f7e9e5; border:1px solid #d9b3a7; color:var(--warn); font-weight:700; }
    .gate.allowed { background:#eaf3e6; border:1px solid #bcd0b2; color:var(--ok); font-weight:700; }
    table { width:100%; border-collapse:collapse; font-size:13px; } th,td { border:1px solid var(--line); padding:5px 7px; text-align:left; }
    .round { border-top:1px solid var(--line); padding-top:8px; } .bad { color:var(--warn); font-weight:700; } .good { color:var(--ok); font-weight:700; }
    .history { max-height:110px; overflow:auto; border-top:1px solid var(--line); padding-top:8px; }
    .tier-row { display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; }
    .error { color:var(--warn); font-weight:700; font-size:13px; white-space:pre-wrap; }
    a { color:var(--accent); }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header>
    <div><h1>古船模型配重试航台</h1><div class="meta">整船静载试航：三档配重 · 保压 · 桅杆偏移 · 卸重回弹</div></div>
    <div><a href="/">← 返回帆索校准台</a> <button id="reload" type="button" style="margin-left:10px">刷新</button></div>
  </header>
  <main>
    <section>
      <div class="banner">
        每艘模型只允许<b>一份进行中的试航单</b>。<br>
        三档配重逐档记录重量、保压时长、桅杆偏移，再记录卸重后残余偏移。<br>
        桅杆偏移<b>&gt; ${rules.maxOffset}mm</b>，或卸重后残余偏移<b>&gt; ${rules.residualLimit}mm</b>，立即停待修整；<b>修整人不得为原操作工</b>，复测通过才恢复交付。<br>
        配重或帆索材料一经改动，旧结论自动失效。
      </div>
      <form id="createForm">
        <h2>开立试航单</h2>
        <label>选择模型</label><select name="itemKey" id="itemSelect" required></select>
        <label>操作工</label><input name="operator" required placeholder="执行本次试航的操作工">
        <label>备注</label><input name="note" placeholder="可选">
        <div style="margin-top:12px"><button type="submit">开立</button></div>
        <div class="error" id="createError"></div>
      </form>
    </section>
    <section>
      <div class="panel" style="margin-bottom:12px"><h2>试航单</h2><div class="meta">按模型逐张流转：进行中 → 登记初测；不合格停待修整 → 换人修整 → 复测；合格前不能报交付。</div></div>
      <div class="grid" id="cards"></div>
    </section>
  </main>
  <script>
    const RULES = ${JSON.stringify(rules)};
    const $ = sel => document.querySelector(sel);
    const cardsEl = $('#cards');
    let trials = [];
    let items = [];
    const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    async function api(path, payload, method) {
      const res = await fetch(path, payload === undefined ? undefined : { method: method || 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
      const data = await res.json();
      if (!res.ok) throw new Error(data && data.error ? data.error.message || data.error : '请求失败');
      return data;
    }
    function stateClass(s) { return {'${TRIAL_STATE.IN_PROGRESS}':'prog','${TRIAL_STATE.NEEDS_REPAIR}':'repair','${TRIAL_STATE.PASSED}':'pass','${TRIAL_STATE.INVALID}':'invalid'}[s] || ''; }
    function renderSelect() {
      $('#itemSelect').innerHTML = '<option value="">请选择模型</option>' + items.map(item => {
        const open = trials.find(t => (t.itemId === item.id || t.itemCode === item.code) && (t.state === RULES.states.IN_PROGRESS || t.state === RULES.states.NEEDS_REPAIR));
        return '<option value="'+esc(item.code)+'"'+(open?' disabled':'')+'>'+esc(item.code)+' · '+esc(item.shipType)+(open?'（已有进行中试航单）':'')+'</option>';
      }).join('');
    }
    function roundBlock(trial, title, kindLabel) {
      const rows = RULES.tierLabels.map((label, i) =>
        '<div class="tier-row"><div><label>'+esc(label)+'重量 kg</label><input type="number" step="0.01" min="0" data-f="weightKg" data-tier="'+i+'"></div>'+
        '<div><label>保压 分钟</label><input type="number" step="1" min="0" data-f="holdMinutes" data-tier="'+i+'"></div>'+
        '<div><label>桅杆偏移 mm</label><input type="number" step="0.1" min="0" data-f="mastOffsetMm" data-tier="'+i+'"></div></div>').join('');
      return '<div class="round"><b>'+esc(title)+'</b>'+rows+
        '<label>卸重后残余偏移 mm（回弹判定，≤ '+RULES.residualLimit+'）</label><input type="number" step="0.1" min="0" data-f="residualOffsetMm">'+
        '<label>'+esc(kindLabel)+'操作工</label><input data-f="operator" placeholder="登记操作工">'+
        '<label>备注</label><input data-f="note"><div style="margin-top:10px"><button data-action="round">提交'+esc(kindLabel)+'判定</button></div></div>';
    }
    function roundHistory(trial) {
      return (trial.rounds || []).map(r => {
        const v = r.verdict || {};
        const tiers = r.tiers.map(t => '<tr><td>'+esc(t.label)+'</td><td>'+esc(t.weightKg)+'kg</td><td>'+esc(t.holdMinutes)+'min</td><td class="'+(Number(t.mastOffsetMm) > RULES.maxOffset ? 'bad':'')+'">'+esc(t.mastOffsetMm)+'mm</td></tr>').join('');
        const fails = (v.failures || []).map(f => '<div class="bad">✗ '+esc(f.message)+'</div>').join('');
        return '<div class="round"><b>第'+r.no+'轮 '+esc(r.kind)+'</b> <span class="meta">'+esc(r.at)+' · 操作工 '+esc(r.operator)+'</span>'+
          '<table><tr><th>档位</th><th>配重</th><th>保压</th><th>桅杆偏移</th></tr>'+tiers+'</table>'+
          '<div class="meta">最大偏移 '+esc(v.metrics && v.metrics.maxOffsetMm)+'mm；卸重残余 <span class="'+(Number(r.unload.residualOffsetMm) > RULES.residualLimit ? 'bad':'good')+'">'+esc(r.unload.residualOffsetMm)+'mm</span></div>'+
          (v.passed ? '<div class="good">✓ 判定合格</div>' : fails)+'</div>';
      }).join('');
    }
    function cardHtml(t) {
      let actions = '';
      if (t.state === RULES.states.IN_PROGRESS) actions = roundBlock(t, '登记初测', '初测');
      if (t.state === RULES.states.NEEDS_REPAIR) {
        const lastNo = (t.rounds.length ? t.rounds[t.rounds.length-1].no : 0);
        const repaired = (t.repairs || []).some(r => r.roundNo === lastNo);
        actions = '<div class="round"><b>登记修整（修整人不能是原操作工）</b>'+
          '<label>修整人</label><input data-f="repairer"'+(repaired?' disabled value="'+esc(t.repairs.filter(r=>r.roundNo===lastNo).slice(-1)[0].repairer)+'"':'')+'>'+
          '<label>修整内容</label><input data-f="repairNote"'+(repaired?' disabled':'')+'>'+
          '<div style="margin-top:10px"><button data-action="repair"'+(repaired?' disabled':'')+'>提交修整</button></div>'+
          (repaired ? roundBlock(t, '登记复测', '复测') : '<div class="meta" style="margin-top:8px">修整登记完成后才能复测。</div>')+'</div>';
      }
      const hist = (t.history || []).slice().reverse().map(h => '<div class="meta">'+esc(h.at)+' · '+esc(h.action)+(h.by?' · '+esc(h.by):'')+(h.note?'：'+esc(h.note):'')+'</div>').join('');
      const snapshot = (t.rounds || []).length ? t.rounds[t.rounds.length-1].snapshot : null;
      return '<article class="card" data-trial="'+esc(t.id)+'" data-item="'+esc(t.itemCode)+'">'+
        '<div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><h3>'+esc(t.itemCode)+' · '+esc(t.shipType||'')+'</h3><span class="pill '+stateClass(t.state)+'">'+esc(t.state)+'</span></div>'+
        '<div class="meta">试航单 '+esc(t.id)+' · 开立人 '+esc(t.openedBy)+' · 模型状态 '+esc(t.itemStatus)+'</div>'+
        (snapshot ? '<div class="meta">结论依据：帆索「'+esc(snapshot.riggingMaterial)+'」、配重「'+esc(snapshot.ballastSpec)+'」'+(t.latestRoundStale?' <span class="bad">（已被改动）</span>':'')+'</div>' : '')+
        (t.state === RULES.states.INVALID ? '<div class="gate blocked">'+esc(t.invalidReason||'旧结论失效')+'</div>' : '')+
        '<div class="gate '+(t.deliveryAllowed?'allowed':'blocked')+'">'+(t.deliveryAllowed?'✓ ':'⛔ ')+esc(t.gateReason)+'</div>'+
        roundHistory(t)+actions+
        '<div class="history meta">'+(hist||'暂无流转记录')+'</div>'+
        '<div class="error" data-error></div>'+
        '</article>';
    }
    function payloadFrom(card, fields) {
      const out = {};
      for (const f of fields) {
        const el = card.querySelector('[data-f="'+f+'"]');
        out[f] = el ? el.value.trim() : '';
      }
      return out;
    }
    cardsEl.onclick = async ev => {
      const btn = ev.target.closest('button[data-action]');
      if (!btn) return;
      const card = btn.closest('.card');
      const errEl = card.querySelector('[data-error]');
      errEl.textContent = '';
      try {
        const trialId = card.dataset.trial, itemKey = card.dataset.item;
        if (btn.dataset.action === 'round') {
          const tiers = [...Array(RULES.tierCount).keys()].map(i => ({
            weightKg: card.querySelector('[data-f="weightKg"][data-tier="'+i+'"]').value,
            holdMinutes: card.querySelector('[data-f="holdMinutes"][data-tier="'+i+'"]').value,
            mastOffsetMm: card.querySelector('[data-f="mastOffsetMm"][data-tier="'+i+'"]').value,
          }));
          await api('/api/trials/'+encodeURIComponent(trialId)+'/rounds?item='+encodeURIComponent(itemKey), { operator: payloadFrom(card,['operator']).operator, note: payloadFrom(card,['note']).note, tiers, unload: { residualOffsetMm: payloadFrom(card,['residualOffsetMm']).residualOffsetMm } });
        } else if (btn.dataset.action === 'repair') {
          const p = payloadFrom(card, ['repairer','repairNote']);
          await api('/api/trials/'+encodeURIComponent(trialId)+'/repairs?item='+encodeURIComponent(itemKey), { repairer: p.repairer, note: p.repairNote });
        }
        await load();
      } catch (e) { errEl.textContent = e.message; }
    };
    $('#createForm').onsubmit = async ev => {
      ev.preventDefault();
      const errEl = $('#createError'); errEl.textContent = '';
      try {
        const fd = Object.fromEntries(new FormData(ev.target).entries());
        await api('/api/items/'+encodeURIComponent(fd.itemKey)+'/trials', { operator: fd.operator, note: fd.note });
        ev.target.reset();
        await load();
      } catch (e) { errEl.textContent = e.message; }
    };
    async function load() {
      [items, trials] = await Promise.all([api('/api/items'), api('/api/trials')]);
      renderSelect();
      cardsEl.innerHTML = trials.length ? trials.map(cardHtml).join('') : '<div class="meta">暂无试航单</div>';
    }
    $('#reload').onclick = load;
    load();
  </script>
</body>
</html>`;
}
