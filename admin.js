// admin.js
function $(id) {
  return document.getElementById(id);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[c]));
}

async function loadPending() {
  const token = $("token").value.trim();
  const msg = $("msg");
  const list = $("list");

  msg.textContent = "";
  list.innerHTML = "";

  if (!token) {
    msg.textContent = "Enter admin token.";
    return;
  }

  try {
    const res = await fetch(`/api/admin/pending?token=${encodeURIComponent(token)}`);
    const data = await res.json();

    if (!res.ok || !data.ok) {
      msg.textContent = "Auth failed or server error.";
      return;
    }

    const rows = data.results;

    if (!rows || rows.length === 0) {
      list.innerHTML = `<div class="dim">No pending reviews.</div>`;
      return;
    }

    list.innerHTML = rows.map(r => `
      <div class="card" style="margin-top:12px;">
        <div style="font-weight:700;">
          ${esc(r.teacher_name)} 
          <span class="dim">(${esc(r.teacher_school)})</span>
        </div>

        <div class="dim" style="margin-top:6px;">
          Overall: ${esc(r.overall)} |
          Clarity: ${esc(r.clarity)} |
          Difficulty: ${esc(r.difficulty)} |
          Take again: ${r.would_take_again ? "Yes" : "No"}
        </div>

        <div style="margin-top:8px; white-space:pre-wrap;">
          ${esc(r.comment)}
        </div>

        <div class="dim" style="margin-top:8px;">
          ${esc(r.created_at)} — ID ${esc(r.id)}
        </div>

        <div style="display:flex; gap:10px; margin-top:10px;">
          <button class="btn" onclick="moderate('${r.id}', 'approve')">Approve</button>
          <button class="btn" style="background:#6b7280"
            onclick="moderate('${r.id}', 'reject')">Reject</button>
        </div>
      </div>
    `).join("");

  } catch (err) {
    msg.textContent = "Error: " + err.message;
  }
}

async function moderate(id, action) {
  const token = $("token").value.trim();
  const msg = $("msg");

  if (!token) {
    msg.textContent = "Missing admin token.";
    return;
  }

  const res = await fetch(`/api/admin/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, review_id: id }),
  });

  if (!res.ok) {
    msg.textContent = `${action} failed.`;
    return;
  }

  loadPending();
}

document.addEventListener("DOMContentLoaded", () => {
  $("load")?.addEventListener("click", loadPending);
});