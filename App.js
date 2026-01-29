const API = "/api";

const el = (id) => document.getElementById(id);

function teacherCard(t) {
  return `
    <div class="item">
      <a href="/teacher.html?id=${encodeURIComponent(t.id)}"><strong>${escapeHtml(t.name)}</strong></a><br/>
      <span class="badge">${escapeHtml(t.school)}</span>
      <span class="badge">⭐ ${t.avg_overall?.toFixed?.(1) ?? "—"} (${t.review_count ?? 0})</span>
    </div>
  `;
}

function escapeHtml(s){ return (s ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function searchTeachers(q) {
  const r = await fetch(`${API}/teachers?q=${encodeURIComponent(q)}`);
  if (!r.ok) return [];
  return await r.json();
}

async function getTop() {
  const r = await fetch(`${API}/top`);
  if (!r.ok) return [];
  return await r.json();
}

(async function init(){
  el("year").textContent = new Date().getFullYear();

  const q = el("q");
  const results = el("results");

  async function run(){
    const list = await searchTeachers(q.value.trim());
    results.innerHTML = list.map(teacherCard).join("") || `<div class="item">No results.</div>`;
  }

  q.addEventListener("input", () => {
    window.clearTimeout(window.__t);
    window.__t = window.setTimeout(run, 200);
  });

  await run();

  const top = await getTop();
  el("top").innerHTML = top.map(teacherCard).join("") || `<div class="item">No data yet.</div>`;
})();
