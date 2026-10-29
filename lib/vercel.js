const { handleApi } = require("./api");
const { sendJson } = require("./http");

function route(action) {
  return async function handler(req, res) {
    try {
      await handleApi(req, res, action);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: error.message || "Error interno." });
      } else {
        res.end();
      }
    }
  };
}

module.exports = { route };
