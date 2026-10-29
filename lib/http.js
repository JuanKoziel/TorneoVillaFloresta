function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const name = part.slice(0, i).trim();
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[name] = part.slice(i + 1).trim();
    }
  }
  return out;
}

function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) {
      try {
        return Promise.resolve(JSON.parse(req.body.toString("utf8")));
      } catch {
        return Promise.reject(new Error("JSON inválido"));
      }
    }
    if (typeof req.body === "string") {
      if (!req.body) return Promise.resolve({});
      try {
        return Promise.resolve(JSON.parse(req.body));
      } catch {
        return Promise.reject(new Error("JSON inválido"));
      }
    }
    if (typeof req.body === "object") return Promise.resolve(req.body);
  }

  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("Payload demasiado grande"));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("JSON inválido"));
      }
    });
    req.on("error", reject);
  });
}

function isSecure(req) {
  return req.headers["x-forwarded-proto"] === "https" || Boolean(req.socket && req.socket.encrypted);
}

function buildCookie(name, value, { maxAge, secure = false } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "HttpOnly", "SameSite=Lax", "Path=/"];
  if (typeof maxAge === "number") parts.push(`Max-Age=${maxAge}`);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

module.exports = { sendJson, parseCookies, readBody, isSecure, buildCookie };
