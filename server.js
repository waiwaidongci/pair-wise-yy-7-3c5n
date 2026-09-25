import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTrial,
  addRound,
  addRepair,
  invalidateOnItemUpdate,
  listItemTrials,
  trialView,
  TrialError,
} from "./records.js";
import { deliveryGate } from "./judge.js";
import { trialsPage } from "./trials-page.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "model-rigging-calibration.json");
const port = Number(process.env.PORT || 3038);
const seed = {
  "items": [
    {
      "code": "MR-001",
      "shipType": "福船",
      "scale": "1:48",
      "mastCount": 3,
      "riggingMaterial": "蜡线",
      "owner": "周宁",
      "dueDate": "2026-06-28",
      "status": "校准中",
      "tasks": [
        {
          "id": "T-1",
          "position": "前桅侧支索",
          "tension": "偏松",
          "status": "调整中",
          "logs": [
            {
              "at": "2026-06-12",
              "note": "已缩短2mm"
            }
          ]
        }
      ],
      "logs": []
    }
  ]
};
const fields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["ballastSpec","配重配置","text"],["owner","负责人","text"],["dueDate","交付日期","date"]];
const stages = ["待检查","校准中","待修整","待复核","已交付"];
const statLabels = ["待检查","校准中","待修整","待复核","已交付"];
const extraFields = [["position","索具位置"],["tension","松紧状态"],["note","调整备注"]];

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function newId() { return "MR-" + Date.now(); }
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
  }
  return stats;
}
function latestTrial(db, item) {
  const list = listItemTrials(db, item.code);
  return list[0] || null;
}
function summarize(db, item) {
  const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  const trial = latestTrial(db, item);
  const gate = trial ? deliveryGate(item, trial) : deliveryGate(item, null);
  return { ...item, logCount, trialId: trial ? trial.id : null, trialState: trial ? trial.state : null, deliveryAllowed: gate.allowed, gateReason: gate.reason };
}
function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古船模型帆索校准</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:90px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古船模型帆索校准</h1><div class="meta">模型、帆索任务和校准记录串联 · <a href="/trials" style="color:var(--accent)">配重试航台 →</a></div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>新增模型</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存模型</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>新增帆索任务</h2><label>选择模型</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><button>提交记录</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel"><h2>创建模型后可拆分帆索任务，逐条记录松紧状态、调整备注和完成时间。</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    const fields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["ballastSpec","配重配置","text"],["owner","负责人","text"],["dueDate","交付日期","date"]];
    const stages = ["待检查","校准中","待修整","待复核","已交付"];
    const extraFields = [["position","索具位置"],["tension","松紧状态"],["note","调整备注"]];
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    let items = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
    }
    function render() {
      itemSelect.innerHTML = items.map(item => '<option value="'+(item.id || item.code)+'">'+(item.code || item.id)+' · '+(item.name || item.shipType || item.source || item.plateSize || '')+'</option>').join('');
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => {
        try {
          await api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value }) });
        } catch (e) { alert('无法更新状态：' + e.message); }
        await load();
      });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const id = btn.dataset.note; const note = prompt('记录备注'); if (note) { await api('/api/items/'+id+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } });
    }
    function cardHtml(item) {
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+(item[key] ?? '')+'</div>').join('');
      const tasks = (item.tasks || []).map(t => '<div class="meta">任务 '+t.position+' · '+t.status+' · '+t.tension+'</div>').join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+l.step+'：'+l.note+'</div>').join('');
      const gate = item.deliveryAllowed
        ? '<div style="color:#3f6b3a;font-weight:700">✓ 试航：'+(item.trialState||'')+'，可交付</div>'
        : '<div class="warn">⛔ '+item.gateReason+(item.trialId?'（'+item.trialId+'）':'')+'</div>';
      return '<article class="card"><h3>'+(item.code || item.id)+'</h3><span class="pill">'+item.status+'</span>'+main+'<div class="meta"><b>帆索</b> '+(item.riggingMaterial||'')+' · <b>配重</b> '+(item.ballastSpec||'')+'</div>'+gate+tasks+'<label>状态</label><select data-status="'+(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select><button class="secondary" data-note="'+(item.id || item.code)+'">追加备注</button><div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    async function load() { items = await api('/api/items'); render(); }
    createForm.onsubmit = async event => { event.preventDefault(); await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); await load(); };
    actionForm.onsubmit = async event => { event.preventDefault(); await api('/api/items/'+itemSelect.value+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(actionForm).entries())) }); actionForm.reset(); await load(); };
    document.querySelector('#statusFilter').onchange = render; document.querySelector('#search').oninput = render; document.querySelector('#reload').onclick = load;
    renderForms(); load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/trials") return html(res, trialsPage());
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, db.items.map(item => summarize(db, item)));
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      const item = { id: newId(), ...input, logs: [{ at: new Date().toISOString(), step: "建档", note: "创建模型" }] };
      item.tasks = [];
      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, item);
    }
    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const item = db.items.find(x => x.id === patch[1] || x.code === patch[1]);
      if (!item) return send(res, 404, { error: { code: "item_not_found", message: "模型不存在" } });
      const changes = await body(req);
      // 交付门禁：没有合格且未失效的整船静载结论，不能直接报交付。
      if (changes.status === "已交付") {
        const gate = deliveryGate(item, latestTrial(db, item));
        if (!gate.allowed) return send(res, 409, { error: { code: "delivery_blocked", message: gate.reason } });
      }
      // 配重或帆索材料改动 → 旧合格结论立即失效（判定规则在判定层）。
      const invalidated = invalidateOnItemUpdate(db, item, changes);
      const nextStatus = changes.status;
      Object.assign(item, changes);
      item.logs ||= [];
      if (nextStatus && nextStatus !== undefined) {
        item.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + item.status });
      }
      if (invalidated.length) {
        item.logs.push({ at: new Date().toISOString(), step: "材料改动", note: invalidated.map(t => t.id + " 旧结论失效").join("；") });
      }
      await saveDb(db);
      return send(res, 200, summarize(db, item));
    }
    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const item = db.items.find(x => x.id === log[1] || x.code === log[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
      await saveDb(db);
      return send(res, 201, item);
    }
    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const item = db.items.find(x => x.id === action[1] || x.code === action[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.tasks ||= [];
      item.tasks.push({ id: "T-" + Date.now(), position: input.position, tension: input.tension, status: "待检查", logs: [{ at: new Date().toISOString(), note: input.note || "新增帆索任务" }] });
      item.status = "校准中";
      item.logs.push({ at: new Date().toISOString(), step: "帆索", note: input.position + " · " + input.tension });
      await saveDb(db);
      return send(res, 201, item);
    }
    // ---- 配重试航台：开立 / 初测复测 / 修整（记录与判定逻辑均在独立模块）----
    const openTrial = url.pathname.match(/^\/api\/items\/([^/]+)\/trials$/);
    if (openTrial && req.method === "POST") {
      try {
        const item = db.items.find(x => x.id === openTrial[1] || x.code === openTrial[1]);
        if (!item) return send(res, 404, { error: { code: "item_not_found", message: "模型不存在" } });
        const trial = createTrial(db, item.code, await body(req));
        await saveDb(db);
        return send(res, 201, trialView(db, trial, item));
      } catch (error) {
        return send(res, error instanceof TrialError ? 409 : 500, { error: { code: error.code || "error", message: error.message } });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/trials") {
      const itemKey = url.searchParams.get("item");
      const list = itemKey ? listItemTrials(db, itemKey) : (db.trials || []);
      return send(res, 200, list.map(trial => {
        const item = db.items.find(x => x.id === trial.itemId || x.code === trial.itemCode);
        return item ? trialView(db, trial, item) : trial;
      }));
    }
    const trialAction = url.pathname.match(/^\/api\/trials\/([^/]+)\/(rounds|repairs)$/);
    if (trialAction && req.method === "POST") {
      try {
        const itemKey = url.searchParams.get("item");
        const item = db.items.find(x => x.id === itemKey || x.code === itemKey);
        if (!item) return send(res, 404, { error: { code: "item_not_found", message: "模型不存在" } });
        const payload = await body(req);
        const trial = trialAction[2] === "rounds"
          ? addRound(db, item.code, trialAction[1], payload)
          : addRepair(db, item.code, trialAction[1], payload);
        await saveDb(db);
        return send(res, 201, trialView(db, trial, item));
      } catch (error) {
        return send(res, error instanceof TrialError ? 409 : 500, { error: { code: error.code || "error", message: error.message } });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("古船模型帆索校准 listening on http://localhost:" + port));
