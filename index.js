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

// Defensive: accept only realistic person names
function looksLikePersonName(fullName) {
  const name = normalizeName(fullName);
  if (!name) return false;

  if (name.length < 5 || name.length > 40) return false;
  if (!/^[A-Za-z .'-]+$/.test(name)) return false;

  const parts = name.split(" ").filter(Boolean);
  if (parts.length < 2 || parts.length > 3) return false;

  // reject common non-name words that often appear in directories
  const bad = [
    "Skyline", "High", "School", "Staff", "Directory", "Search",
    "Phone", "Email", "Locations", "Titles", "Home",
    "Issaquah", "District", "Washington"
  ];
  const lower = name.toLowerCase();
  for (const w of bad) {
    if (lower.includes(w.toLowerCase())) return false;
  }

  if (/[A-Z]{4,}/.test(name)) return false;
  return true;
}

// Build the "directory results" URL that the site uses.
// This is based on the URL you found in DevTools.
// We keep last name blank so it returns ALL staff, not just "a".
function buildSkylineDirectoryUrl() {
  const base = new URL("https://skyline.isd411.org/staff");
  base.searchParams.set("utf8", "✓");
  base.searchParams.set("const_search_group_ids", "289");
  base.searchParams.set("const_search_role_ids", "1");
  base.searchParams.set("const_search_keyword", "");
  base.searchParams.set("const_search_first_name", "");
  base.searchParams.set("const_search_last_name", "");
  return base.toString();
}

// Scrape ONE directory page: extract names and pagination links.
async function scrapeOneDirectoryPage(pageUrl) {
  const res = await fetch(pageUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; TeacherRaterBot/3.0)",
      "Accept": "text/html,application/xhtml+xml",
    },
  });

  if (!res.ok) throw new Error(`Directory fetch failed (${res.status})`);

  const names = new Set();
  const pageLinks = new Set();

  // Collect name text from likely name elements inside each card
  let nameBuf = "";
  class NameTextHandler {
    text(t) { nameBuf += t.text; }
    end() {
      const candidate = normalizeName(nameBuf);
      nameBuf = "";
      if (looksLikePersonName(candidate)) names.add(candidate);
    }
  }

  // Collect pagination hrefs (page 1, page 2, etc)
  class PaginationLinkHandler {
    element(el) {
      const href = el.getAttribute("href");
      if (!href) return;

      // only keep links that go to /staff with search params
      // (avoid nav/header links)
      if (href.includes("/staff") && href.includes("const_search_group_ids")) {
        pageLinks.add(href);
      }
    }
  }

  const rewriter = new HTMLRewriter()
    // Name selectors: Finalsite directories commonly use one of these
    .on(".fsConstituentItem h3", new NameTextHandler())
    .on(".fsConstituentItem .fsConstituentName", new NameTextHandler())
    .on(".fsConstituentItem .fsFullName", new NameTextHandler())

    // Pagination links often live in some pagination container; we’ll be broad:
    .on("a", new PaginationLinkHandler());

  // Consume the transformed response so handlers run
  await rewriter.transform(res).text();

  // Normalize pagination links to absolute URLs
  const absLinks = [...pageLinks].map((href) => new URL(href, pageUrl).toString());

  return { names: [...names], pageUrls: absLinks };
}

// Scrape all pages of the directory results
async function scrapeSkylineStaffDirectory() {
  const startUrl = buildSkylineDirectoryUrl();

  const seenPages = new Set();
  const toVisit = [startUrl];

  const allNames = new Set();
  const maxPages = 10; // safety cap (should be 2 for 179 staff)

  while (toVisit.length > 0 && seenPages.size < maxPages) {
    const url = toVisit.shift();
    if (!url || seenPages.has(url)) continue;
    seenPages.add(url);

    const { names, pageUrls } = await scrapeOneDirectoryPage(url);

    for (const n of names) allNames.add(n);

    // enqueue any new /staff pagination URLs
    for (const p of pageUrls) {
      if (!seenPages.has(p)) toVisit.push(p);
    }
  }

  return {
    source_url: startUrl,
    names: [...allNames],
    pages_visited: seenPages.size,
  };
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
  const skyline = await scrapeSkylineStaffDirectory();
  const school = "Skyline High School";

  let upserted = 0;

  for (const n of skyline.names) {
    if (!looksLikePersonName(n)) continue;
    await upsertTeacher(env, { name: n, school, source_url: skyline.source_url });
    upserted++;
  }

  return {
    ok: true,
    found: skyline.names.length,
    upserted,
    pages_visited: skyline.pages_visited,
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
