// Tiny static server for the Phase 0 browser pages.
//
//   node serve.mjs [--port 8080] [--isolate] [--root DIR] [--quiet]
//
// Serves the spike folder (by default) on 127.0.0.1 only. --isolate adds the
// COOP/COEP headers that make a page cross-origin isolated, so we can compare
// runs with and without them. Each request is logged as one line on stdout:
//   <status> <method> <path>
// The first line printed is "listening http://127.0.0.1:PORT/", which
// lib/browser-emu.mjs waits for. Use --port 0 to pick a free port.
//
// It also exports startServer() for use from other scripts.

import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".jsdos": "application/octet-stream",
  ".zip": "application/octet-stream",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

export function startServer({ port = 8080, isolate = false, root = here, quiet = false, log } = {}) {
  const rootDir = resolve(root);
  const write = log ?? ((line) => { if (!quiet) process.stdout.write(line + "\n"); });

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { pathname = "/"; }
    if (pathname.endsWith("/")) pathname += "index.html";
    const file = normalize(join(rootDir, pathname));

    const headers = { "Cache-Control": "no-store" };
    if (isolate) {
      headers["Cross-Origin-Opener-Policy"] = "same-origin";
      headers["Cross-Origin-Embedder-Policy"] = "require-corp";
      headers["Cross-Origin-Resource-Policy"] = "same-origin";
    }

    const done = (status) => write(`${status} ${req.method} ${url.pathname}${url.search}`);

    if (file !== rootDir && !file.startsWith(rootDir + sep)) {
      res.writeHead(403, headers).end("forbidden");
      return done(403);
    }
    let st;
    try { st = statSync(file); } catch { st = null; }
    if (!st || !st.isFile()) {
      res.writeHead(404, { ...headers, "Content-Type": "text/plain" }).end("not found");
      return done(404);
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, headers).end();
      return done(405);
    }
    headers["Content-Type"] = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
    headers["Content-Length"] = st.size;
    res.writeHead(200, headers);
    if (req.method === "HEAD") { res.end(); return done(200); }
    createReadStream(file).pipe(res);
    done(200);
  });

  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const actual = server.address().port;
      write(`listening http://127.0.0.1:${actual}/${isolate ? " (COOP/COEP on)" : ""}`);
      resolvePromise({ server, port: actual, url: `http://127.0.0.1:${actual}/` });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = { port: 8080, isolate: false, root: here, quiet: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port") opt.port = Number(args[++i]);
    else if (a === "--isolate") opt.isolate = true;
    else if (a === "--root") opt.root = args[++i];
    else if (a === "--quiet") opt.quiet = true;
    else { console.error(`unknown option ${a}`); process.exit(2); }
  }
  const { server } = await startServer(opt);
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
