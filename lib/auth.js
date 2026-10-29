const crypto = require("crypto");
const { parseCookies } = require("./http");

const SESSION_TTL_SECONDS = 8 * 60 * 60;
const VOTER_TTL_SECONDS = 365 * 24 * 60 * 60;

function authSecret() {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("Falta configurar AUTH_SECRET (mínimo 16 caracteres).");
  }
  return secret;
}

function sign(value) {
  return crypto.createHmac("sha256", authSecret()).update(value).digest("base64url");
}

function safeEqualBuffers(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function passwordMatches(input) {
  const expected = process.env.ADMIN_PASSWORD || "";
  if (!expected) return false;
  const hashInput = crypto.createHash("sha256").update(String(input || "")).digest();
  const hashExpected = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(hashInput, hashExpected);
}

function createAdminToken() {
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  return `${expires}.${sign(String(expires))}`;
}

function verifyAdminToken(token) {
  if (!token || typeof token !== "string") return false;
  const separator = token.indexOf(".");
  if (separator === -1) return false;
  const expires = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!/^\d+$/.test(expires)) return false;
  if (Number(expires) < Math.floor(Date.now() / 1000)) return false;
  return safeEqualBuffers(signature, sign(expires));
}

function isAdmin(req) {
  return verifyAdminToken(parseCookies(req).admin);
}

function getVoterId(req) {
  const voter = parseCookies(req).voter;
  return voter || null;
}

function newVoterId() {
  return crypto.randomBytes(24).toString("hex");
}

function voterFingerprint(voterId) {
  return crypto.createHash("sha256").update(String(voterId)).digest("hex");
}

module.exports = {
  SESSION_TTL_SECONDS,
  VOTER_TTL_SECONDS,
  passwordMatches,
  createAdminToken,
  verifyAdminToken,
  isAdmin,
  getVoterId,
  newVoterId,
  voterFingerprint,
};
