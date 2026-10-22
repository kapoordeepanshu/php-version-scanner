// GET /api/releases
// Proxies php.net active-release data so the frontend always shows current
// latest patch versions. Falls back to a pinned snapshot (Oct 2026) if php.net
// is unreachable. Cached at the edge for 12h.

const FALLBACK = {
  source: "snapshot-2026-10",
  branches: {
    // PHP2Shell emergency releases, 2026-10-21
    "8.2": { latest: "8.2.35" },
    "8.3": { latest: "8.3.36" },
    "8.4": { latest: "8.4.27" },
    "8.5": { latest: "8.5.12" },
  },
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=43200, stale-while-revalidate=86400");

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const resp = await fetch("https://www.php.net/releases/active.php", {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error("php.net responded " + resp.status);
    const data = await resp.json();

    // Shape: { "8": { "8.2": { version: "8.2.x", ... }, ... } }
    const branches = {};
    for (const major of Object.values(data)) {
      for (const [branch, info] of Object.entries(major)) {
        if (info && info.version) branches[branch] = { latest: info.version };
      }
    }
    if (Object.keys(branches).length === 0) throw new Error("empty payload");
    return res.status(200).json({ source: "php.net", branches });
  } catch {
    return res.status(200).json(FALLBACK);
  }
}
