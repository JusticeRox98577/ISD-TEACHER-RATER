// index.js - Cloudflare Worker (D1 + simple moderation)
//
// REQUIRED BINDINGS:
// - env.DB (D1 database binding named "DB")
//
// REQUIRED SECRETS / VARIABLES:
// - env.ADMIN_TOKEN (set in Cloudflare dashboard, NOT in GitHub)
//
// Tables expected:
// teachers(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, school TEXT)
// reviews(id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id INTEGER, school TEXT,
//         overall INTEGER, difficulty INTEGER, clarity INTEGER, would_take_again INTEGER,
//         comment TEXT, status TEXT, created_at TEXT)

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

function requireAdmin(url, body, env) {
  // Allow token in query string OR JSON body (your admin page can use either)
  const tokenFromQuery = url.searchParams.get("token") || "";
  const tokenFromBody = (body && typeof body.token === "string") ? body.token : "";
  const token = tokenFromBody || tokenFromQuery;

  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 12) {
    // Safer: fail closed if you forgot to set it
    return { ok: false, status: 500, msg: "Server misconfigured: ADMIN_TOKEN not set" };
  }

  if (!token || token !== env.ADMIN_TOKEN) {
    return { ok: false, status: 401, msg: "Unauthorized" };
  }

  return { ok: true };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Always handle OPTIONS (CORS preflight)
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

    // HARD GUARD: prevent 1101 pages by catching everything
    try {
      // Health check
      if (url.pathname === "/api/health") return text("OK");

      // ---------------------------
      // Teachers: list / search
      // ---------------------------
      if (url.pathname === "/api/teachers" && request.method === "GET") {
        const q = cleanStr(url.searchParams.get("q") || "", 80);
        const like = `%${q}%`;

        const stmt = q
          ? env.DB.prepare(`
              SELECT id, name, school
              FROM teachers
              WHERE name LIKE ? OR school LIKE ?
              ORDER BY name
              LIMIT 50
            `).bind(like, like)
          : env.DB.prepare(`
              SELECT id, name, school
              FROM teachers
              ORDER BY name
              LIMIT 50
            `);

        const { results } = await stmt.all();
        return json(results);
      }

      // ---------------------------
      // Teacher summary (stats)
      // ---------------------------
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

      // ---------------------------
      // Reviews: list (approved only)
      // ---------------------------
      if (url.pathname === "/api/reviews" && request.method === "GET") {
        const teacherId = url.searchParams.get("teacher_id");
        if (!teacherId) return text("Missing teacher_id", 400);

        const { results } = await env.DB.prepare(`
          SELECT
            id,
            overall, difficulty, clarity, would_take_again,
            school, comment, created_at
          FROM reviews
          WHERE teacher_id = ? AND status='approved'
          ORDER BY created_at DESC
          LIMIT 50
        `).bind(teacherId).all();

        return json(results);
      }

      // ---------------------------
      // Reviews: submit (creates pending)
      // ---------------------------
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

        const exists = await env.DB.prepare(
          `SELECT 1 FROM teachers WHERE id = ?`
        ).bind(teacher_id).first();

        if (!exists) return text("Teacher not found", 404);

        const now = new Date().toISOString();
        await env.DB.prepare(`
          INSERT INTO reviews
            (teacher_id, school, overall, difficulty, clarity, would_take_again, comment, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        `).bind(
          teacher_id, school, overall, difficulty, clarity, would_take_again, comment, now
        ).run();

        return json({ ok: true, status: "pending" }, 201);
      }

      // ============================================================
      // ADMIN MODERATION (token protected)
      // ============================================================

      // List pending reviews (for admin page)
      if (url.pathname === "/api/admin/pending" && request.method === "GET") {
        const auth = requireAdmin(url, null, env);
        if (!auth.ok) return text(auth.msg, auth.status);

        const { results } = await env.DB.prepare(`
          SELECT
            r.id,
            r.teacher_id,
            t.name AS teacher_name,
            t.school AS teacher_school,
            r.school,
            r.overall,
            r.difficulty,
            r.clarity,
            r.would_take_again,
            r.comment,
            r.created_at
          FROM reviews r
          JOIN teachers t ON t.id = r.teacher_id
          WHERE r.status = 'pending'
          ORDER BY r.created_at DESC
          LIMIT 200
        `).all();

        return json({ ok: true, results });
      }

      // Approve a review
      if (url.pathname === "/api/admin/approve" && request.method === "POST") {
        let body;
        try { body = await request.json(); } catch { return text("Invalid JSON", 400); }

        const auth = requireAdmin(url, body, env);
        if (!auth.ok) return text(auth.msg, auth.status);

        const review_id = String(body.review_id ?? "").trim();
        if (!review_id) return text("Missing review_id", 400);

        const res = await env.DB.prepare(`
          UPDATE reviews
          SET status = 'approved'
          WHERE id = ? AND status = 'pending'
        `).bind(review_id).run();

        return json({ ok: true, changes: res.changes });
      }

      // Reject a review
      if (url.pathname === "/api/admin/reject" && request.method === "POST") {
        let body;
        try { body = await request.json(); } catch { return text("Invalid JSON", 400); }

        const auth = requireAdmin(url, body, env);
        if (!auth.ok) return text(auth.msg, auth.status);

        const review_id = String(body.review_id ?? "").trim();
        if (!review_id) return text("Missing review_id", 400);

        const res = await env.DB.prepare(`
          UPDATE reviews
          SET status = 'rejected'
          WHERE id = ? AND status = 'pending'
        `).bind(review_id).run();

        return json({ ok: true, changes: res.changes });
      }

      // Fallback
      return text("Not found", 404);
    } catch (err) {
      // This prevents the ugly Cloudflare 1101 page and gives you the real message
      return json(
        { ok: false, error: "Worker exception", message: String(err?.message || err) },
        500
      );
    }
  },
};