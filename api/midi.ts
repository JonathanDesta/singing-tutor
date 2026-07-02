import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * Proxy for BitMidi (free MIDI library) so the app can search and import
 * songs without the user downloading files by hand. Browsers can't call
 * bitmidi.com directly (CORS), and proxying only an exact host + path shape
 * keeps this from being an open proxy.
 */

const ALLOWED_ORIGINS = [
  "https://jonathandesta.github.io",
  "http://localhost:5173",
];

// BitMidi sits behind bot protection that 403s anonymous datacenter requests;
// present as a normal browser.
const UPSTREAM_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://bitmidi.com/",
};

function corsOrigin(req: VercelRequest): string | null {
  const origin = req.headers.origin;
  if (!origin) return null;
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  if (origin === `https://${req.headers.host}`) return origin;
  return "deny";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = corsOrigin(req);
  if (origin === "deny") {
    res.status(403).json({ error: "origin not allowed" });
    return;
  }
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ error: "GET only" });
    return;
  }

  const q = typeof req.query.q === "string" ? req.query.q : null;
  const file = typeof req.query.file === "string" ? req.query.file : null;

  try {
    if (q) {
      const r = await fetch(
        `https://bitmidi.com/api/midi/search?q=${encodeURIComponent(q.slice(0, 80))}&page=0`,
        { headers: UPSTREAM_HEADERS },
      );
      if (!r.ok) throw new Error(`search upstream ${r.status}`);
      const data = (await r.json()) as {
        result?: { results?: { name?: string; downloadUrl?: string; views?: number }[] };
      };
      const results = (data.result?.results ?? [])
        .filter((m) => m.name && m.downloadUrl)
        .slice(0, 12)
        .map((m) => ({ name: m.name, downloadUrl: m.downloadUrl, views: m.views ?? 0 }));
      res.status(200).json({ results });
      return;
    }

    if (file) {
      if (!/^\/uploads\/[\w.-]+\.midi?$/i.test(file)) {
        res.status(400).json({ error: "bad file path" });
        return;
      }
      const r = await fetch(`https://bitmidi.com${file}`, {
        headers: { ...UPSTREAM_HEADERS, Accept: "audio/midi, */*" },
      });
      if (!r.ok) throw new Error(`file upstream ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 2_000_000) {
        res.status(413).json({ error: "file too large" });
        return;
      }
      res.setHeader("Content-Type", "audio/midi");
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.status(200).send(buf);
      return;
    }

    res.status(400).json({ error: "q or file required" });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "midi proxy failed" });
  }
}
