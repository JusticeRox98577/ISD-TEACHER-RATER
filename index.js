// index.js (Cloudflare Worker + D1)
// Supports:
// - Public API: /api/health, /api/teachers, /api/teacher, /api/reviews (GET/POST)
// - Admin moderation: /api/admin/pending, /api/admin/approve, /api/admin/reject
// - Manual scrape: /api/admin/scrape
// - Auto scrape (Cron): scheduled()

/* ----------------------------- Small helpers ----------------------------- */

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      ...extraHeaders,
    },
  });
}

function text(msg, status = 200, extraHeaders = {}) {
  return new Response(msg, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
  });
}

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
  // Set ADMIN_TOKEN in Cloudflare Worker -> Settings -> Variables
  const expected = String(env.ADMIN_TOKEN || "").trim();
  if (!expected) return false; // fail closed if not set
  return String(token || "").trim() === expected;
}

/* ------------------------------- Scraping ------------------------------- */
/**
 * Skyline staff page may be server-rendered or JS-rendered.
 * This HTML scrape is generic; if it returns junk/0, we’ll switch to the JSON endpoint Skyline uses.
 */
async function scrapeSkylineStaffHTML() {
  const url = "https://skyline.isd411.org/staff";
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; TeacherRaterBot/1.0)",
      "Accept": "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`Skyline fetch failed (${res.status})`);

  const html = await res.text();

  // Strip scripts/styles/tags -> plain-ish text
  const textOnly = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const names = new Set();

  // Pattern A: "Last, First"
  for (const m of textOnly.matchAll(/\b([A-Z][a-zA-Z'’-]+),\s+([A-Z][a-zA-Z'’-]+)\b/g)) {
    names.add(normalizeName(`${m[2]} ${m[1]}`));
  }

  // Pattern B: "First Last" (guarded a bit)
  for (const m of textOnly.matchAll(/\b([A-Z][a-zA-Z'’-]{2,})\s+([A-Z][a-zA-Z'’-]{2,})\b/g)) {
    const full = normalizeName(`${m[1]} ${m[2]}`);
    if (full.length > 40) continue;
    if (full.toLowerCase().includes("skyline")) continue;
    names.add(full);
  }

  return { source_url: url, names: [...names].filter(Boolean) };
}

async function upsertTeacher(env, { name, school, source_url }) {
  const now = new Date().toISOString();

  // Requires unique index on (name, school). See SQL in my earlier message.
  await env.DB.prepare(`
    INSERT INTO teachers (name, school, source_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(name, school) DO UPDATE SET
      source_url=excluded.source_url,
      updated_at=excluded.updated_at
  `)
    .bind(name, school, source_url || "", now, now)
    .run();
}

async function runScrapeAll(env) {
  const skyline = await scrapeSkylineStaffHTML();
  const school = "Skyline High School";

  let upserted = 0;
  for (const n of skyline.names) {
    if (!n) continue;
    const parts = n.split(" ").filter(Boolean);
    if (parts.length < 2) continue; // skip single tokens
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

/* ------------------------------ Admin: D1 ------------------------------ */

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
  `)
    .bind(lim)
    .all();

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
  `)
    .bind(status, id)
    .run();

  // D1 returns meta changes in different shapes; be defensive
  const changed =
    out?.meta?.changes ?? out?.changes ?? out?.success ? 1 : 0;

  return { ok: true, updated: changed };
}

/* ------------------------------- The Worker ------------------------------ */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response("", {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // Health
    if (url.pathname === "/api/health") return text("OK");

    /* --------------------------- Public endpoints -------------------------- */

    // List/search teachers
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

    // Teacher summary + stats
    if (url.pathname === "/api/teacher" && request.method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return text("Missing id", 400);

      const teacher = await env.DB.prepare(
        `SELECT id, name, school FROM teachers WHERE id = ?`
      )
        .bind(id)
        .first();

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
      `)
        .bind(id)
        .first();

      return json({ ...teacher, ...stats });
    }

    // Get approved reviews for a teacher
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
      `)
        .bind(teacherId)
        .all();

      return json(results || []);
    }

    // Submit a review (creates pending)
    if (url.pathname === "/api/reviews" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return text("Invalid JSON", 400);
      }

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
        .bind(teacher_id)
        .first();
      if (!exists) return text("Teacher not found", 404);

      const now = new Date().toISOString();
      await env.DB.prepare(`
        INSERT INTO reviews
          (teacher_id, school, overall, difficulty, clarity, would_take_again, comment, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `)
        .bind(
          teacher_id,
          school,
          overall,
          difficulty,
          clarity,
          would_take_again,
          comment,
          now
        )
        .run();

      return json({ ok: true, status: "pending" }, 201);
    }

    /* ---------------------------- Admin endpoints -------------------------- */

    // Admin: list pending
    if (url.pathname === "/api/admin/pending" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (!requireAdminToken(env, body.token)) return text("Unauthorized", 401);

      const limit = body.limit ?? 50;
      const rows = await getPendingReviews(env, limit);
      return json({ ok: true, rows });
    }

    // Admin: approve
    if (url.pathname === "/api/admin/approve" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (!requireAdminToken(env, body.token)) return text("Unauthorized", 401);

      const out = await setReviewStatus(env, body.id, "approved");
      return json(out, out.ok ? 200 : 400);
    }

    // Admin: reject
    if (url.pathname === "/api/admin/reject" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (!requireAdminToken(env, body.token)) return text("Unauthorized", 401);

      const out = await setReviewStatus(env, body.id, "rejected");
      return json(out, out.ok ? 200 : 400);
    }

    // Admin: manual scrape trigger
    if (url.pathname === "/api/admin/scrape" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
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

  // Auto scrape (Cron Trigger)
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