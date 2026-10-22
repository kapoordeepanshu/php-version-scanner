// GET /api/scan?url=https://example.com
// Fetches the target site and inspects response headers for PHP version fingerprints.
// Runs server-side (Vercel Serverless Function) to avoid browser CORS limits.

import dns from "node:dns/promises";
import net from "node:net";

const TIMEOUT_MS = 9000;
const UA =
  "Mozilla/5.0 (compatible; PHP-Version-Scanner/1.0; +https://github.com/kapoordeepanshu/php-version-scanner)";

// Block scans of private / internal addresses (SSRF guard)
function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    return (
      low === "::1" ||
      low.startsWith("fc") ||
      low.startsWith("fd") ||
      low.startsWith("fe80") ||
      low.startsWith("::ffff:127.") ||
      low.startsWith("::ffff:10.") ||
      low.startsWith("::ffff:192.168.")
    );
  }
  const p = ip.split(".").map(Number);
  return (
    p[0] === 127 ||
    p[0] === 10 ||
    p[0] === 0 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 169 && p[1] === 254)
  );
}

const CDN_SIGNATURES = [
  { name: "Cloudflare", test: (h) => h.has("cf-ray") || /cloudflare/i.test(h.get("server") || "") },
  { name: "Amazon CloudFront", test: (h) => h.has("x-amz-cf-id") || /cloudfront/i.test(h.get("via") || "") },
  { name: "Fastly", test: (h) => /fastly/i.test(h.get("x-served-by") || "") || h.has("fastly-debug-digest") },
  { name: "Akamai", test: (h) => /akamai/i.test(h.get("server") || "") || h.has("x-akamai-transformed") },
  { name: "Sucuri WAF", test: (h) => h.has("x-sucuri-id") || h.has("x-sucuri-cache") },
  { name: "Vercel", test: (h) => h.has("x-vercel-id") },
  { name: "Netlify", test: (h) => /netlify/i.test(h.get("server") || "") },
  { name: "Varnish Cache", test: (h) => /varnish/i.test(h.get("via") || "") || h.has("x-varnish") },
  { name: "Incapsula/Imperva", test: (h) => h.has("x-iinfo") || /incap/i.test(h.get("x-cdn") || "") },
];

function extractPhpVersion(value) {
  if (!value) return null;
  const m = /php\/?\s*(\d+\.\d+(?:\.\d+)?)/i.exec(value);
  return m ? m[1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  let raw = (req.query.url || "").trim();
  if (!raw) return res.status(400).json({ error: "Missing ?url= parameter" });
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;

  let target;
  try {
    target = new URL(raw);
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }
  if (!/^https?:$/.test(target.protocol)) {
    return res.status(400).json({ error: "Only http/https URLs are supported" });
  }

  // SSRF guard: refuse private hostnames/IPs
  try {
    const host = target.hostname;
    if (host === "localhost" || !host.includes(".") || isPrivateIp(host)) {
      return res.status(400).json({ error: "Private or local addresses cannot be scanned" });
    }
    if (!net.isIP(host)) {
      const { address } = await dns.lookup(host);
      if (isPrivateIp(address)) {
        return res.status(400).json({ error: "Hostname resolves to a private address" });
      }
    }
  } catch {
    return res.status(400).json({ error: "DNS lookup failed — host not found" });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(target.href, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": UA, Accept: "text/html,*/*" },
    });
    clearTimeout(timer);
    // We only need headers; drop the body stream.
    try { resp.body?.cancel?.(); } catch {}

    const h = resp.headers;
    const poweredBy = h.get("x-powered-by") || null;
    const server = h.get("server") || null;
    const setCookie = h.get("set-cookie") || "";

    const phpVersion =
      extractPhpVersion(poweredBy) || extractPhpVersion(server);

    const phpSessionCookie = /PHPSESSID/i.test(setCookie);
    const phpHintNoVersion =
      !phpVersion && (phpSessionCookie || /php/i.test(poweredBy || ""));

    const cdns = CDN_SIGNATURES.filter((c) => c.test(h)).map((c) => c.name);

    return res.status(200).json({
      url: raw,
      finalUrl: resp.url,
      httpStatus: resp.status,
      phpVersion,
      phpDetected: Boolean(phpVersion || phpHintNoVersion),
      versionHidden: phpHintNoVersion,
      phpSessionCookie,
      headers: { "x-powered-by": poweredBy, server },
      cdns,
    });
  } catch (err) {
    clearTimeout(timer);
    const reason =
      err.name === "AbortError"
        ? "Request timed out (site took longer than 9s to respond)"
        : "Could not reach the site (connection refused, TLS error, or host unreachable)";
    return res.status(200).json({ url: raw, unreachable: true, error: reason });
  }
}
