const http = require("http");
const fs = require("fs");
const path = require("path");
const { handleApi } = require("./lib/api");
const { sendJson } = require("./lib/http");

const PORT = Number(process.env.PORT) || 3000;
const INDEX_FILE = path.join(__dirname, "index.html");

function serveIndex(res) {
  fs.readFile(INDEX_FILE, (error, content) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("No encontrado");
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  try {
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const action = url.pathname.replace(/^\/api\/?/, "");
      return await handleApi(req, res, action);
    }

    if ((req.method === "GET" || req.method === "HEAD") && (url.pathname === "/" || url.pathname === "/index.html")) {
      return serveIndex(res);
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("No encontrado");
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      const message = process.env.NODE_ENV === "production" ? "Error interno." : error.message;
      sendJson(res, 500, { error: message });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, () => {
  console.log(`Copa Villa Floresta 2026 en http://localhost:${PORT}`);
  console.log(`Supabase: ${process.env.SUPABASE_URL ? "configurado" : "FALTA SUPABASE_URL"}`);
  console.log(`Admin: ${process.env.ADMIN_PASSWORD ? "configurado" : "FALTA ADMIN_PASSWORD"}`);
  console.log(`Auth: ${process.env.AUTH_SECRET ? "configurado" : "FALTA AUTH_SECRET"}`);
});
