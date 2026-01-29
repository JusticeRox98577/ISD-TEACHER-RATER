// rate.js
let selectedTeacherId = null;

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[c]));
}

async function fetchTeachers(q) {
  const res = await fetch(`/api/teachers?q=${encodeURIComponent(q)}`, {
    headers: { "Accept": "application/json" },
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`API /api/teachers failed (${res.status}) ${t}`);
  }
  return res.json();
}

function renderTeacherList(list) {
  const pick = $("teacherPick");
  if (!pick) return;

  if (!Array.isArray(list) || list.length === 0) {
    pick.innerHTML = `<div class="list-item muted">No results.</div>`;
    return;
  }

  pick.innerHTML = list.map(t => `
    <button type="button" class="list-item" data-id="${t.id}" data-name="${escapeHtml(t.name)}" data-school="${escapeHtml(t.school)}">
      <strong>${escapeHtml(t.name)}</strong><span class="dim"> — ${escapeHtml(t.school)}</span>
    </button>
  `).join("");

  // Click-to-select
  pick.querySelectorAll("button[data-id]").forEach(btn => {
    btn.addEventListener("click", () => {
      selectedTeacherId = btn.dataset.id;

      // show selection
      const picked = $("picked");
      if (picked) {
        picked.classList.remove("hidden");
        picked.innerHTML = `Picked: <strong>${btn.dataset.name}</strong> <span class="dim">(${btn.dataset.school})</span>`;
      }

      // clear list after picking
      pick.innerHTML = "";
      const input = $("teacherSearch");
      if (input) input.value = btn.dataset.name;
    });
  });
}

async function submitReview() {
  const msg = $("msg");
  if (msg) msg.textContent = "";

  const school = $("school")?.value || "";
  const overall = Number($("overall")?.value || 0);
  const difficulty = Number($("difficulty")?.value || 0);
  const clarity = Number($("clarity")?.value || 0);
  const wouldTakeAgain = $("wouldTakeAgain")?.value === "1";
  const comment = $("comment")?.value || "";

  if (!selectedTeacherId) {
    if (msg) msg.textContent = "Pick a teacher first.";
    return;
  }

  const payload = {
    teacher_id: selectedTeacherId,
    school,
    overall,
    difficulty,
    clarity,
    would_take_again: wouldTakeAgain,
    comment,
  };

  const res = await fetch("/api/reviews", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) {
    if (msg) msg.textContent = `Submit failed (${res.status}): ${text}`;
    return;
  }

  if (msg) msg.textContent = "Submitted! (Pending moderation)";
  $("comment").value = "";
}

document.addEventListener("DOMContentLoaded", () => {
  const input = $("teacherSearch");
  const btn = $("submit");

  // live search
  let timer = null;
  input?.addEventListener("input", () => {
    const q = input.value.trim();

    // require at least 1 char (you can change to 2 if you want)
    if (q.length === 0) {
      $("teacherPick").innerHTML = "";
      return;
    }

    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const list = await fetchTeachers(q);
        renderTeacherList(list);
      } catch (e) {
        $("teacherPick").innerHTML = `<div class="list-item muted">${escapeHtml(e.message)}</div>`;
      }
    }, 150);
  });

  btn?.addEventListener("click", submitReview);
});