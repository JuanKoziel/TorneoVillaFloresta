const { handleApi } = require("../lib/api");
const { sendJson } = require("../lib/http");

module.exports = async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  let action = req.query && req.query.action ? String(req.query.action) : "";
  if (!action) action = url.pathname.replace(/^\/api\/?/, "");

  try {
    if (!action) {
      return sendJson(res, 404, { error: "Acción no encontrada." });
    }
    await handleApi(req, res, action);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      const message = process.env.NODE_ENV === "production" ? "Error interno." : error.message;
      sendJson(res, 500, { error: message });
    } else {
      res.end();
    }
  }
};
