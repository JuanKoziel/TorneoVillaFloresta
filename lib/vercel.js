const { handleApi } = require("./api");
const { sendJson } = require("./http");

function route(action) {
  return async function handler(req, res) {
    try {
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
}

module.exports = { route };
