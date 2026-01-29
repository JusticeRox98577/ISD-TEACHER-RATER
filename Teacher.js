const API = "/api";
const el = (id) => document.getElementById(id);

function escapeHtml(s){ return (s ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function getParam(name){
  const u = new URL(location.href);
  return u.searchParams.get(name);
}

function reviewCard(r){
  const date = new Date(r.created_at).toLocaleDateString();
  const comment = r.comment ? `<p>${escapeHtml(r.comment)}</p>` : "";
  return `
    <div class="item">
      <span class="badge">⭐ ${r.overall}</span>
      <span class="badge">Clarity ${r.clarity}</span>
      <span class="badge">Difficulty ${r.difficulty}</span>
      <span class="badge">${r.would_take_again ? "Would take again" : "Would not take again"}</span>
      <span class="badge">${escapeHtml(r.school)}</span>
      <span class="badge">${date}</span>
      ${comment}
    </div>
  `;
}

(async function init(){
  const id = getParam("id");
  if (!id) {
    el("name").textContent = "Teacher not found";
    return;
  }

  const tRes = await fetch(`${API}/teacher?id=${encodeURIComponent(id)}`);
  if (!tRes.ok) {
    el("name").textContent = "Teacher not found";
    return;
  }
  const t = await tRes.json();
  el("name").textContent = t.name;
  el("rateLink").href = `/rate.html`;

  el("summary").innerHTML = `
    <span class="badge">${escapeHtml(t.school)}</span>
    <span class="badge">⭐ ${t.avg_overall?.toFixed?.(1) ?? "—"} (${t.review_count ?? 0})</span>
    <span class="badge">Clarity ${t.avg_clarity?.toFixed?.(1) ?? "—"}</span>
    <span class="badge">Difficulty ${t.avg_difficulty?.toFixed?.(1) ?? "—"}</span>
    <span class="badge">${t.would_take_again_pct != null ? `${Math.round(t.would_take_again_pct)}% would take again` : "—"}</span>
  `;

  const rRes = await fetch(`${API}/reviews?teacher_id=${encodeURIComponent(id)}`);
  const reviews = rRes.ok ? await rRes.json() : [];
  el("reviews").innerHTML = reviews.map(reviewCard).join("") || `<div class="item">No reviews yet.</div>`;
})();
