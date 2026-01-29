// src/index.js — Cloudflare Worker (module syntax)
// Required bindings:
// - env.DB (D1 Database)
// - env.ADMIN_TOKEN (string)

// -------------------- CORS + response helpers --------------------
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function text(msg, status = 200, extraHeaders = {}) {
  return new Response(String(msg), {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// -------------------- small utilities --------------------
function clampInt(n, min, max) {
  const x = Number.parseInt(n, 10);
  if (Number.isNaN(x)) return null;
  return Math.min(max, Math.max(min, x));
}

function cleanStr(s, maxLen) {
  if (typeof s !== "string") return "";
  return s.trim().slice(0, maxLen);
}

function normalizeName(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function requireAdminToken(env, token) {
  const expected = String(env.ADMIN_TOKEN || "").trim();
  if (!expected) return false;
  return String(token || "").trim() === expected;
}

// -------------------- scraping --------------------
// Defensive: accept only realistic people names
function looksLikePersonName(fullName) {
  const name = normalizeName(fullName);
  if (!name) return false;

  // basic length checks
  if (name.length < 5 || name.length > 40) return false;

  // allow letters/spaces/apostrophe/hyphen/period only
  if (!/^[A-Za-z .'-]+$/.test(name)) return false;

  // reject many-word junk
  const parts = name.split(" ").filter(Boolean);
  if (parts.length < 2 || parts.length > 3) return false;

  // reject common page words
  const bad = [
    "Skyline", "High", "School", "Staff", "Directory", "Search",
    "Phone", "Email", "Locations", "Titles", "Home",
    "Issaquah", "District", "Washington"
  ];
  const lower = name.toLowerCase();
  for (const w of bad) {
    if (lower.includes(w.toLowerCase())) return false;
  }

  // reject ALL CAPS sequences (often headings)
  if (/[A-Z]{4,}/.test(name)) return false;

  return true;
}

/**
 * Extract names from the staff directory HTML using HTMLRewriter
 * so we only capture the actual name elements inside each staff card.
 *
 * We try multiple selectors because the exact markup can change:
 * - .fsConstituentItem h3
 * - .fsConstituentItem .fsFullName
 * - .fsConstituentItem .fsConstituentName
 */
async function scrapeSkylineStaffHTML() {
  const url = "https://skyline.isd411.org/staff";

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; TeacherRaterBot/2.0)",
      "Accept": "text/html,application/xhtml+xml",
    },
  });

  if (!res.ok) throw new Error(`Skyline fetch failed (${res.status})`);

  const names = new Set();
  let currentText = "";

  // Handler that collects text of a matched element
  class NameTextHandler {
    text(t) {
      currentText += t.text;
    }
    end() {
      const candidate = normalizeName(currentText);
      currentText = "";
      if (looksLikePersonName(candidate)) {
        names.add(candidate);
      }
    }
  }

  const rewriter = new HTMLRewriter()
    .on(".fsConstituentItem h3", new NameTextHandler())
    .on(".fsConstituentItem .fsFullName", new NameTextHandler())
    .on(".fsConstituentItem .fsConstituentName", new NameTextHandler());

  // Consume rewritten stream so handlers run
  await rewriter.transform(res).text();

  return { source_url: url, names: [...names] };
}

// -------------------- DB writes --------------------
async function upsertTeacher(env, { name, school, source_url }) {
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO teachers (name, school, source_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(name, school) DO UPDATE SET
      source_url=excluded.source_url,
      updated_at=excluded.updated_at
  `).bind(name, school, source_url || "", now, now).run();
}

async function runScrapeAll(env) {
  const skyline = await scrapeSkylineStaffHTML();
  const school = "Skyline High School";

  let upserted = 0;

  for (const n of skyline.names) {
    if (!looksLikePersonName(n)) continue;
    await upsertTeacher(env, { name: n, school, source_url: skyline.source_url });
    upserted++;
  }

  return {
    ok: true,
    skyline_count_found: skyline.names.length,
    upserted,
    school,
    source_url: skyline.source_url,
  };
}

// -------------------- Reviews + moderation --------------------
async function getPendingReviews(env, limit = 50) {
  const lim = clampInt(limit, 1, 200) ?? 50;

  const { results } = await env.DB.prepare(`
    SELECT
      r.id,
      r.teacher_id,
      t.name AS teacher_name,
      r.school,
      r.overall,
      r.clarity,
      r.difficulty,
      r.would_take_again,
      r.comment,
      r.status,
      r.created_at
    FROM reviews r
    LEFT JOIN teachers t ON t.id = r.teacher_id
    WHERE r.status='pending'
    ORDER BY r.created_at DESC
    LIMIT ?
  `).bind(lim).all();

  return results || [];
}

async function setReviewStatus(env, reviewId, status) {
  const id = clampInt(reviewId, 1, 1_000_000_000);
  if (id === null) return { ok: false, error: "Invalid review id" };

  if (status !== "approved" && status !== "rejected") {
    return { ok: false, error: "Invalid status" };
  }

  const out = await env.DB.prepare(`
    UPDATE reviews
    SET status = ?
    WHERE id = ? AND status='pending'
  `).bind(status, id).run();

  const changes =
    (out && out.meta && typeof out.meta.changes === "number" ? out.meta.changes : null) ??
    (typeof out.changes === "number" ? out.changes : null) ??
    0;

  return { ok: true, updated: changes };
}

// "Top rated" endpoint helper
async function getTopTeachers(env, limit = 10) {
  const lim = clampInt(limit, 1, 50) ?? 10;

  const { results } = await env.DB.prepare(`
    SELECT
      t.id,
      t.name,
      t.school,
      COUNT(r.id) AS review_count,
      ROUND(AVG(r.overall), 2) AS avg_overall
    FROM teachers t
    JOIN reviews r ON r.teacher_id = t.id
    WHERE r.status = 'approved'
    GROUP BY t.id, t.name, t.school
    HAVING COUNT(r.id) >= 1
    ORDER BY avg_overall DESC, review_count DESC, t.name ASC
    LIMIT ?
  `).bind(lim).all();

  return results || [];
}

// -------------------- Worker entrypoints --------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response("", { status: 204, headers: { ...CORS_HEADERS } });
    }

    if (url.pathname === "/api/health") return text("OK");

    // ---------------- Public APIs ----------------

    if (url.pathname === "/api/teachers" && request.method === "GET") {
      const q = cleanStr(url.searchParams.get("q") || "", 80);
      const like = `%${q}%`;

      const stmt = q
        ? env.DB.prepare(`
            SELECT id, name, school
            FROM teachers
            WHERE name LIKE ? OR school LIKE ?
            ORDER BY name
            LIMIT 100
          `).bind(like, like)
        : env.DB.prepare(`
            SELECT id, name, school
            FROM teachers
            ORDER BY name
            LIMIT 100
          `);

      const { results } = await stmt.all();
      return json(results || []);
    }

    if (url.pathname === "/api/teacher" && request.method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return text("Missing id", 400);

      const teacher = await env.DB.prepare(
        `SELECT id, name, school FROM teachers WHERE id = ?`
      ).bind(id).first();

      if (!teacher) return text("Not found", 404);

      const stats = await env.DB.prepare(`
        SELECT
          COUNT(*) AS review_count,
          AVG(overall) AS avg_overall,
          AVG(clarity) AS avg_clarity,
          AVG(difficulty) AS avg_difficulty,
          AVG(would_take_again) * 100.0 AS would_take_again_pct
        FROM reviews
        WHERE teacher_id = ? AND status='approved'
      `).bind(id).first();

      return json({ ...teacher, ...stats });
    }

    if (url.pathname === "/api/reviews" && request.method === "GET") {
      const teacherId = url.searchParams.get("teacher_id");
      if (!teacherId) return text("Missing teacher_id", 400);

      const { results } = await env.DB.prepare(`
        SELECT
          overall, difficulty, clarity, would_take_again,
          school, comment, created_at
        FROM reviews
        WHERE teacher_id = ? AND status='approved'
        ORDER BY created_at DESC
        LIMIT 50
      `).bind(teacherId).all();

      return json(results || []);
    }

    if (url.pathname === "/api/reviews" && request.method === "POST") {
      const body = (await readJson(request)) || {};

      const teacher_id = String(body.teacher_id ?? "").trim();
      const school = cleanStr(body.school ?? "", 120);
      const overall = clampInt(body.overall, 1, 5);
      const difficulty = clampInt(body.difficulty, 1, 5);
      const clarity = clampInt(body.clarity, 1, 5);
      const would_take_again = body.would_take_again ? 1 : 0;
      const comment = cleanStr(body.comment ?? "", 800);

      if (!teacher_id) return text("Missing teacher_id", 400);
      if (!school) return text("Missing school", 400);
      if (overall === null || difficulty === null || clarity === null) {
        return text("Ratings must be 1-5", 400);
      }

      const exists = await env.DB.prepare(`SELECT 1 FROM teachers WHERE id = ?`)
        .bind(teacher_id).first();

      if (!exists) return text("Teacher not found", 404);

      const now = new Date().toISOString();

      await env.DB.prepare(`
        INSERT INTO reviews
          (teacher_id, school, overall, difficulty, clarity, would_take_again, comment, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).bind(
        teacher_id,
        school,
        overall,
        difficulty,
        clarity,
        would_take_again,
        comment,
        now
      ).run();

      return json({ ok: true, status: "pending" }, 201);
    }

    // Top rated teachers (for homepage “Top Rated”)
    if (url.pathname === "/api/top" && request.method === "GET") {
      const limit = url.searchParams.get("limit") ?? "10";
      const rows = await getTopTeachers(env, limit);
      return json({ ok: true, rows });
    }

    // ---------------- Admin APIs ----------------

    if (url.pathname === "/api/admin/pending" && request.method === "POST") {
      const body = (await readJson(request)) || {};
      if (!requireAdminToken(env, body.token)) return text("Unauthorized", 401);

      const rows = await getPendingReviews(env, body.limit ?? 50);
      return json({ ok: true, rows });
    }

    if (url.pathname === "/api/admin/approve" && request.method === "POST") {
      const body = (await readJson(request)) || {};
      if (!requireAdminToken(env, body.token)) return text("Unauthorized", 401);

      const out = await setReviewStatus(env, body.id, "approved");
      return json(out, out.ok ? 200 : 400);
    }

    if (url.pathname === "/api/admin/reject" && request.method === "POST") {
      const body = (await readJson(request)) || {};
      if (!requireAdminToken(env, body.token)) return text("Unauthorized", 401);

      const out = await setReviewStatus(env, body.id, "rejected");
      return json(out, out.ok ? 200 : 400);
    }

    if (url.pathname === "/api/admin/scrape" && request.method === "POST") {
      const body = (await readJson(request)) || {};
      if (!requireAdminToken(env, body.token)) return text("Unauthorized", 401);

      try {
        const result = await runScrapeAll(env);
        return json(result);
      } catch (e) {
        return json({ ok: false, error: e?.message || String(e) }, 500);
      }
    }

    return text("Not found", 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          await runScrapeAll(env);
        } catch (e) {
          console.log("Scheduled scrape error:", e?.message || e);
        }
      })()
    );
  },
};
