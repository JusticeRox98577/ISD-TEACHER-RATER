function $(id){ return document.getElementById(id); }
function esc(s){ return String(s ?? "").replace(/[&<>"']/g,c=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[c])); }

async function api(path, token, opts = {}) {
  const url = `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    cache: "no-store",
    ...opts,
    headers: {
      ...(opts.headers || {}),
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
  });
  const text = await res.text().catch(()=> "");
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0,200)}`);
  return text ? JSON.parse(text) : null;
}

function renderPending(rows) {
  const list = $("list");
  if (!list) return;

  if (!rows || rows.length === 0) {
    list.innerHTML = `<p class="muted">No pending reviews 🎉</p>`;
    return;
  }

  list.innerHTML = rows.map(r => `
    <div class="card" style="margin-top:12px;">
      <div style="font-weight:700;">${esc(r.teacher_name || "Unknown teacher")} <span class="dim">(${esc(r.school)})</span></div>
      <div class="dim" style="margin-top:6px;">
        Overall: ${esc(r.overall)} | Clarity: ${esc(r.clarity)} | Difficulty: ${esc(r.difficulty)} | Take again: ${r.would_take_again ? "Yes" : "No"}
      </div>
      <div style="margin-top:8px; white-space:pre-wrap;">${esc(r.comment || "")}</div>
      <div class="dim" style="margin-top:8px;">${esc(r.created_at)} — ID: ${esc(r.id)}</div>

      <div style="display:flex; gap:10px; margin-top:10px;">
        <button class="btn" data-act="approve" data-id="${esc(r.id)}">Approve</button>
        <button class="btn" data-act="reject" data-id="${esc(r.id)}" style="background:#6b7280;">Reject</button>
      </div>
    </div>
  `).join("");
}

async function loadPending() {
  const token = $("token")?.value?.trim();
  const msg = $("msg");
  if (!token) { if (msg) msg.textContent = "Paste your admin token first."; return; }

  if (msg) msg.textContent = "Loading…";
  try {
    const rows = await api("/api/admin/pending", token, { method: "GET" });
    renderPending(rows);
    if (msg) msg.textContent = `Loaded ${rows.length} pending review(s).`;
  } catch (e) {
    if (msg) msg.textContent = `Error: ${String(e.message || e)}`;
  }
}

async function act(action, id) {
  const token = $("token")?.value?.trim();
  const msg = $("msg");
  if (!token) { if (msg) msg.textContent = "Paste your admin token first."; return; }

  try {
    await api(`/api/admin/${action}`, token, {
      method: "POST",
      body: JSON.stringify({ id }),
    });
    if (msg) msg.textContent = `${action} ✅`;
    await loadPending();
  } catch (e) {
    if (msg) msg.textContent = `Error: ${String(e.message || e)}`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  $("load")?.addEventListener("click", loadPending);

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const action = btn.dataset.act;
    const id = btn.dataset.id;
    act(action, id);
  });
});