// 配重试航台 —— 页面（唯一的界面代码）
// 判定阈值与状态文案从 /api/trial-rules 读取，不在页面复制业务口径。

export function trialPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古船模型配重试航台</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --hold:#8a6d1f; --ok:#3f7a4f; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } h3 { margin:0; font-size:16px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:56px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; }
    .meta { color:var(--muted); font-size:13px; } .warn { color:var(--warn); font-weight:700; } .ok { color:var(--ok); font-weight:700; } .hold { color:var(--hold); font-weight:700; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(330px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .chips { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px; } .chip { background:#fff; border:1px solid var(--line); border-radius:999px; padding:6px 12px; font-size:13px; }
    .gears { display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; } .gears label { margin-top:6px; }
    .events { border-top:1px solid var(--line); padding-top:8px; max-height:120px; overflow:auto; font-size:12px; color:var(--muted); display:grid; gap:3px; }
    .reasons { border-left:3px solid var(--warn); background:#f8efec; border-radius:4px; padding:8px 10px; font-size:13px; }
    a { color:var(--accent); }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header>
    <div><h1>配重试航台</h1><div class="meta">整船静载：三档配重 · 保压时长 · 桅杆偏移 · 操作工；偏移超 2mm 或卸重回弹不达标即停待修整</div></div>
    <div style="display:flex;gap:10px"><a href="/"><button type="button" class="secondary">返回帆索校准</button></a><button id="reload" type="button">刷新</button></div>
  </header>
  <main>
    <section>
      <form id="startForm">
        <h2>开立试航单</h2>
        <label>选择模型</label><select name="modelRef" id="modelSelect" required></select>
        <div class="gears">
          <label>轻载配重(kg)</label><label>半载配重(kg)</label><label>满载配重(kg)</label>
          <input name="w1" type="number" step="0.1" min="0" required>
          <input name="w2" type="number" step="0.1" min="0" required>
          <input name="w3" type="number" step="0.1" min="0" required>
        </div>
        <label>保压时长(分钟)</label><input name="holdMinutes" type="number" step="1" min="1" required>
        <label>操作工</label><input name="operator" required>
        <div class="meta" style="margin-top:8px">每艘模型只允许一份进行中的试航单；配重或索具材料改动会使旧结论失效。</div>
        <div style="margin-top:12px"><button>开工试航</button></div>
      </form>
      <div class="panel" style="margin-top:14px">
        <h2>判定口径</h2>
        <div class="meta" id="rulesHint">加载中…</div>
      </div>
    </section>
    <section>
      <div class="chips" id="chips"></div>
      <div class="panel"><h2>试航单</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    let models = [], trials = [], rules = null;
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers: { 'Content-Type': 'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }
    const fmt = n => (Math.round(Number(n) * 100) / 100).toString();
    const gearFields = (name) => ['轻载', '半载', '满载'].map(g =>
      '<div><label>' + g + '桅杆偏移(mm)</label><input name="' + g + '_mast" type="number" step="0.1" min="0" required>'
      + '<label>' + g + '卸重残余(mm)</label><input name="' + g + '_res" type="number" step="0.1" min="0" required></div>').join('');
    function readingsPayload(form) {
      const payload = { measuredBy: form.measuredBy.value };
      for (const g of ['轻载', '半载', '满载']) payload[g] = { mastOffsetMm: form[g + '_mast'].value, residualOffsetMm: form[g + '_res'].value };
      return payload;
    }
    function reasonHtml(trial) {
      const checks = trial.verdict && trial.verdict.checks || [];
      const msgs = checks.flatMap(c => c.messages || []);
      if (!msgs.length) return '';
      return '<div class="reasons"><b class="warn">停待修整原因：</b><br>' + msgs.join('<br>') + '</div>';
    }
    function actionCard(trial) {
      if (trial.status === '进行中') {
        return '<form data-action="readings" data-trial="' + trial.id + '">'
          + '<h3>登记初测读数</h3><div class="gears">' + gearFields() + '</div>'
          + '<label>测量操作工</label><input name="measuredBy" required>'
          + '<div class="meta" style="margin-top:6px">任一档偏移 &gt; ' + rules.MAST_OFFSET_LIMIT_MM + 'mm 或卸重残余 &gt; ' + rules.RESIDUAL_OFFSET_LIMIT_MM + 'mm，立即停待修整。</div>'
          + '<div style="margin-top:10px"><button>提交判定</button></div></form>';
      }
      if (trial.status === '停待修整') {
        let html = reasonHtml(trial);
        html += '<form data-action="repair" data-trial="' + trial.id + '">'
          + '<h3>登记修整</h3>'
          + '<label>修整人（不得为原操作工 ' + trial.operator + '）</label><input name="repairer" required>'
          + '<label>修整说明</label><textarea name="note" required></textarea>'
          + '<div style="margin-top:10px"><button>提交修整</button></div></form>';
        if (trial.repair) {
          html += '<form data-action="retest" data-trial="' + trial.id + '" style="margin-top:10px;border-top:1px solid var(--line);padding-top:10px">'
            + '<h3>修整后复测</h3><div class="gears">' + gearFields() + '</div>'
            + '<label>测量操作工</label><input name="measuredBy" required>'
            + '<div class="meta" style="margin-top:6px">复测通过才恢复交付；复测不过继续停待修整。</div>'
            + '<div style="margin-top:10px"><button>提交复测</button></div></form>';
        }
        return html;
      }
      if (trial.status === '试航通过') return '<div class="ok">试航通过，可恢复交付。</div>';
      return '<div class="warn">结论已失效：配重或索具材料已改动，需重新试航。</div>';
    }
    function cardHtml(trial) {
      const p = trial.plan;
      const events = (trial.events || []).slice().reverse().map(e => '<div>' + e.at.slice(0, 19).replace('T', ' ') + ' · ' + e.type + '：' + e.note + '</div>').join('');
      const retests = (trial.retests || []).map((r, i) => '<div class="meta">第' + (i + 1) + '次复测：' + (r.verdict.pass ? '通过' : '未过') + ' · 测量 ' + r.measuredBy + '</div>').join('');
      const sig = trial.signature;
      return '<article class="card"><h3>' + trial.no + ' · ' + trial.modelCode + '</h3>'
        + '<span class="pill">' + trial.status + '</span>'
        + '<div class="meta">操作工 ' + trial.operator + '；配重 ' + fmt(p.weights['轻载']) + '/' + fmt(p.weights['半载']) + '/' + fmt(p.weights['满载']) + 'kg；保压 ' + p.holdMinutes + ' 分钟</div>'
        + '<div class="meta">结论绑定：索具「' + sig.riggingMaterial + '」+ 上述三档配重</div>'
        + (trial.repair ? '<div class="meta">修整人 ' + trial.repair.repairer + '：' + trial.repair.note + '</div>' : '')
        + retests + actionCard(trial)
        + '<div class="events">' + (events || '暂无事件') + '</div></article>';
    }
    function renderChips() {
      const stateClass = { '进行中': 'hold', '停待修整': 'warn', '试航通过': 'ok', '结论失效': 'warn', '未试航': '' };
      document.querySelector('#chips').innerHTML = models.map(m => {
        const t = m.trial || {};
        const label = (m.code || m.id) + ' · ' + (m.shipType || '') + '：' + (t.state || '未试航') + (t.no ? '（' + t.no + '）' : '');
        return '<span class="chip ' + (stateClass[t.state] || '') + '">' + label + '</span>';
      }).join('');
    }
    function render() {
      document.querySelector('#cards').innerHTML = trials.map(cardHtml).join('');
    }
    async function load() {
      [models, trials, rules] = await Promise.all([api('/api/items'), api('/api/trials'), api('/api/trial-rules')]);
      document.querySelector('#modelSelect').innerHTML = models.map(m => '<option value="' + (m.id || m.code) + '">' + (m.code || m.id) + ' · ' + (m.shipType || '') + '</option>').join('');
      document.querySelector('#rulesHint').innerHTML = '三档（轻载/半载/满载）全部合格才通过：<br>保压桅杆偏移 ≤ ' + rules.MAST_OFFSET_LIMIT_MM + 'mm；卸重后残余偏移 ≤ ' + rules.RESIDUAL_OFFSET_LIMIT_MM + 'mm（回弹达标）。<br>不合格即停待修整，修整人须与原操作工不同，复测通过才恢复交付。';
      renderChips();
      render();
    }
    document.querySelector('#startForm').onsubmit = async ev => {
      ev.preventDefault();
      const f = ev.target;
      try {
        await api('/api/models/' + encodeURIComponent(f.modelRef.value) + '/trials', {
          method: 'POST',
          body: JSON.stringify({
            weights: { '轻载': f.w1.value, '半载': f.w2.value, '满载': f.w3.value },
            holdMinutes: f.holdMinutes.value,
            operator: f.operator.value,
          }),
        });
        f.reset();
        await load();
      } catch (e) { alert(e.message); }
    };
    document.body.addEventListener('submit', async ev => {
      const form = ev.target.closest('form[data-action]');
      if (!form) return;
      ev.preventDefault();
      const id = form.dataset.trial;
      let payload;
      if (form.dataset.action === 'repair') payload = { repairer: form.repairer.value, note: form.note.value };
      else payload = readingsPayload(form);
      try {
        await api('/api/trials/' + encodeURIComponent(id) + '/' + form.dataset.action, { method: 'POST', body: JSON.stringify(payload) });
        await load();
      } catch (e) { alert(e.message); }
    });
    document.querySelector('#reload').onclick = load;
    load();
  </script>
</body>
</html>`;
}
