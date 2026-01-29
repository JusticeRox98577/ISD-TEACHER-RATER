// admin.js
function $(id){ return document.getElementById(id); }

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) {
    // Worker sometimes returns plain text (like "Unauthorized")
    // so prefer JSON error, then raw text
    throw new Error(data?.error || (typeof data?.raw === "string" ? data.raw : `HTTP ${res.status}`));
  }
  return data;
}

function esc(s){ return String(s ?? "").replace(/[&<>"']/g, c => ({
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
}[c])); }

async function loadPending() {
  const msg = $("msg");
  const list = $("list");
  msg.textContent = "";
  list.innerHTML = "";

  const token = $("token").value;

  const data = await api("/api/admin/pending", { token });

  const rows = data.rows || data; // supports either {rows:[...]} or [...]
  if (!Array.isArray(rows) || rows.length === 0) {
    list.innerHTML = `<div class="dim">No pending reviews.</div>`;
    return;
  }

  list.innerHTML = rows.map(r => `
    <div class="card" style="margin-top:12px;">
      <div style="font-weight:700;">${esc(r.teacher_name || "Unknown teacher")}
        <span class="dim">(${esc(r.school)})</span>
      </div>
      <div class="dim" style="margin-top:6px;">
        Overall: ${esc(r.overall)} | Clarity: ${esc(r.clarity)} | Difficulty: ${esc(r.difficulty)} |
        Take again: ${r.would_take_again ? "Yes" : "No"}
      </div>
      <div style="margin-top:8px; white-space:pre-wrap;">${esc(r.comment || "")}</div>
      <div class="dim" style="margin-top:8px;">${esc(r.created_at)} — ID: ${esc(r.id)}</div>

      <div style="display:flex; gap:10px; margin-top:10px;">
        <button class="btn" data-act="approve" data-id="${esc(r.id)}">Approve</button>
        <button class="btn" data-act="reject" data-id="${esc(r.id)}">Reject</button>
      </div>
    </div>
  `).join("");
}

// Handle approve/reject clicks
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;

  const token = $("token").value;
  const id = btn.dataset.id;
  const act = btn.dataset.act;

  try {
    const endpoint = act === "approve" ? "/api/admin/approve" : "/api/admin/reject";
    await api(endpoint, { token, id });
    await loadPending();
  } catch (err) {
    $("msg").textContent = "Error: " + err.message;
  }
});

document.addEventListener("DOMContentLoaded", () => {
  // Load pending reviews
  $("load")?.addEventListener("click", async () => {
    try {
      await loadPending();
    } catch (err) {
      $("msg").textContent = "Error: " + err.message;
    }
  });

  // Manual scrape button
  $("scrape")?.addEventListener("click", async () => {
    const msg = $("msg");
    try {
      msg.textContent = "Running scrape…";
      const token = $("token").value;

      const result = await api("/api/admin/scrape", { token });

      msg.textContent =
        `Scrape done ✅ Teachers upserted: ${result.upserted ?? "?"} ` +
        `(found: ${result.skyline_count_found ?? "?"})`;
    } catch (err) {
      msg.textContent = "Error: " + err.message;
    }
  });
});
