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
    cache: "no-store",
  });

  const raw = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`Search failed (${res.status}): ${raw.slice(0, 120)}`);

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Bad JSON from API: ${raw.slice(0, 120)}`);
  }
}

function showPickBox(show) {
  const pick = $("teacherPick");
  if (!pick) return;
  pick.style.display = show ? "block" : "none";
}

function renderTeacherList(list) {
  const pick = $("teacherPick");
  if (!pick) return;

  showPickBox(true);

  if (!Array.isArray(list) || list.length === 0) {
    pick.innerHTML = `<div class="list-item muted">No results.</div>`;
    return;
  }

  pick.innerHTML = list.map(t => `
    <button type="button" class="list-item" data-id="${t.id}" data-name="${escapeHtml(t.name)}" data-school="${escapeHtml(t.school)}">
      <strong>${escapeHtml(t.name)}</strong><span class="dim"> — ${escapeHtml(t.school)}</span>
    </button>
  `).join("");

  pick.querySelectorAll("button[data-id]").forEach(btn => {
    btn.addEventListener("click", () => {
      selectedTeacherId = btn.dataset.id;

      // show selection
      const picked = $("picked");
      if (picked) {
        picked.classList.remove("hidden");
        picked.textContent = `Picked: ${btn.dataset.name} (${btn.dataset.school})`;
      }

      // clear results and lock input to selected name
      const input = $("teacherSearch");
      if (input) input.value = btn.dataset.name;

      pick.innerHTML = "";
      showPickBox(false);

      const msg = $("msg");
      if (msg) msg.textContent = "";
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
    if (msg) msg.textContent = "Pick a teacher first (tap a name from the results).";
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

  let res;
  try {
    res = await fetch("/api/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
  } catch (e) {
    if (msg) msg.textContent = `Network error submitting: ${String(e)}`;
    return;
  }

  const bodyText = await res.text().catch(() => "");
  if (!res.ok) {
    if (msg) msg.textContent = `Submit failed (${res.status}): ${bodyText.slice(0, 200)}`;
    return;
  }

  if (msg) msg.textContent = "Submitted! (Pending moderation)";
  if ($("comment")) $("comment").value = "";
}

document.addEventListener("DOMContentLoaded", () => {
  const input = $("teacherSearch");
  const btn = $("submit");
  const pick = $("teacherPick");

  // Make the “dropdown” visible & tappable on iPhone even without perfect CSS
  if (pick) {
    pick.style.display = "none";
    pick.style.border = "1px solid #ddd";
    pick.style.borderRadius = "8px";
    pick.style.marginTop = "6px";
    pick.style.maxHeight = "240px";
    pick.style.overflowY = "auto";
    pick.style.background = "#fff";
  }

  let timer = null;

  input?.addEventListener("input", () => {
    const q = input.value.trim();

    // if they change text, teacher selection is no longer guaranteed
    selectedTeacherId = null;
    const picked = $("picked");
    if (picked) picked.classList.add("hidden");

    if (q.length === 0) {
      if (pick) pick.innerHTML = "";
      showPickBox(false);
      return;
    }

    if (pick) {
      showPickBox(true);
      pick.innerHTML = `<div class="list-item muted">Searching…</div>`;
    }

    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const list = await fetchTeachers(q);
        renderTeacherList(list);
      } catch (e) {
        if (pick) {
          showPickBox(true);
          pick.innerHTML = `<div class="list-item muted">${escapeHtml(e.message)}</div>`;
        }
      }
    }, 200);
  });

  btn?.addEventListener("click", submitReview);
});