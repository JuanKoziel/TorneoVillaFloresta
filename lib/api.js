const { sendJson, readBody, isSecure, buildCookie } = require("./http");
const {
  SESSION_TTL_SECONDS,
  VOTER_TTL_SECONDS,
  passwordMatches,
  createAdminToken,
  isAdmin,
  getVoterId,
  newVoterId,
  voterFingerprint,
} = require("./auth");
const { getSupabase } = require("./supabase");

function throwIfError(error) {
  if (error) throw new Error(error.message || "Error de base de datos.");
}

async function fetchState(sb) {
  const [matchesResult, pollResult] = await Promise.all([
    sb
      .from("matches")
      .select(
        "id, group_name, match_time, team_a, team_b, score_a, score_b, match_events(id, team, minute, player, created_at)"
      )
      .order("id", { ascending: true }),
    sb.from("poll_options").select("id, team, votes").order("id", { ascending: true }),
  ]);

  throwIfError(matchesResult.error);
  throwIfError(pollResult.error);

  return {
    matches: (matchesResult.data || []).map((match) => ({
      id: match.id,
      group: match.group_name,
      time: match.match_time,
      teamA: match.team_a,
      teamB: match.team_b,
      scoreA: match.score_a,
      scoreB: match.score_b,
      events: (match.match_events || [])
        .slice()
        .sort((a, b) => {
          const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
          const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
          return dateA - dateB || a.id - b.id;
        })
        .map((event) => ({
          id: event.id,
          team: event.team,
          minute: event.minute,
          player: event.player,
        })),
    })),
    poll: (pollResult.data || []).map((option) => ({
      id: option.id,
      team: option.team,
      votes: option.votes,
    })),
  };
}

async function fetchVoteChoice(sb, voterId) {
  if (!voterId) return { voted: false, votedOptionId: null };
  const fingerprint = voterFingerprint(voterId);
  const { data, error } = await sb
    .from("votes")
    .select("option_id")
    .eq("voter_hash", fingerprint)
    .maybeSingle();
  throwIfError(error);
  return data
    ? { voted: true, votedOptionId: data.option_id }
    : { voted: false, votedOptionId: null };
}

async function respondWithState(req, res, { status = 200, voterId, payload = {}, headers = {} } = {}) {
  const sb = getSupabase();
  const effectiveVoterId = voterId || getVoterId(req);
  const [state, choice] = await Promise.all([
    fetchState(sb),
    fetchVoteChoice(sb, effectiveVoterId),
  ]);
  return sendJson(res, status, { ...state, ...choice, ...payload }, headers);
}

function voterCookie(req, voterId) {
  return buildCookie("voter", voterId, {
    maxAge: VOTER_TTL_SECONDS,
    secure: isSecure(req),
  });
}

function adminCookie(req, token) {
  return buildCookie("admin", token, {
    maxAge: SESSION_TTL_SECONDS,
    secure: isSecure(req),
  });
}

async function handleApi(req, res, action) {
  const method = req.method;

  if (action === "data" && method === "GET") {
    return respondWithState(req, res);
  }

  if (action === "me" && method === "GET") {
    return sendJson(res, 200, { admin: isAdmin(req) });
  }

  if (action === "login" && method === "POST") {
    const { password } = await readBody(req);
    if (!passwordMatches(password)) {
      return sendJson(res, 401, { error: "Contraseña incorrecta." });
    }
    const token = createAdminToken();
    return sendJson(
      res,
      200,
      { admin: true },
      { "Set-Cookie": adminCookie(req, token) }
    );
  }

  if (action === "logout" && method === "POST") {
    return sendJson(
      res,
      200,
      { admin: false },
      { "Set-Cookie": buildCookie("admin", "", { maxAge: 0, secure: isSecure(req) }) }
    );
  }

  if (action === "vote" && method === "POST") {
    const { optionId } = await readBody(req);
    const numericOptionId = Number(optionId);
    if (!Number.isInteger(numericOptionId)) {
      return sendJson(res, 400, { error: "Opción inválida." });
    }

    let voterId = getVoterId(req);
    let cookieHeader = null;
    if (!voterId) {
      voterId = newVoterId();
      cookieHeader = voterCookie(req, voterId);
    }

    const sb = getSupabase();
    const { data, error } = await sb.rpc("vote_for_option", {
      p_voter_hash: voterFingerprint(voterId),
      p_option_id: numericOptionId,
    });
    throwIfError(error);

    const result = data || {};
    if (result.status === "invalid") {
      return sendJson(res, 404, { error: "Opción inexistente." });
    }

    const headers = cookieHeader ? { "Set-Cookie": cookieHeader } : {};
    if (result.status === "already") {
      return respondWithState(req, res, {
        status: 409,
        voterId,
        payload: { error: "Ya registraste tu voto." },
        headers,
      });
    }

    return respondWithState(req, res, { voterId, headers });
  }

  if (!isAdmin(req)) {
    return sendJson(res, 403, { error: "Solo el administrador puede editar los resultados." });
  }

  if (action === "score" && method === "POST") {
    const { matchId, team, delta } = await readBody(req);
    const numericMatchId = Number(matchId);
    const numericDelta = Number(delta);
    if (!Number.isInteger(numericMatchId) || !Number.isInteger(numericDelta)) {
      return sendJson(res, 400, { error: "Datos inválidos." });
    }
    if (team !== "A" && team !== "B") {
      return sendJson(res, 400, { error: "Equipo inválido." });
    }

    const sb = getSupabase();
    const { error } = await sb.rpc("adjust_score", {
      p_match_id: numericMatchId,
      p_team: team,
      p_delta: numericDelta,
    });
    throwIfError(error);
    return respondWithState(req, res);
  }

  if (action === "goal" && method === "POST") {
    const { matchId, team, minute, player } = await readBody(req);
    const numericMatchId = Number(matchId);
    if (!Number.isInteger(numericMatchId) || !team) {
      return sendJson(res, 400, { error: "Datos inválidos." });
    }

    const sb = getSupabase();
    const { error } = await sb.rpc("register_goal", {
      p_match_id: numericMatchId,
      p_team: String(team),
      p_minute: String(minute || "10'").slice(0, 20),
      p_player: String(player || "Camiseta #9").slice(0, 60),
    });
    if (error) {
      if (error.message && error.message.includes("invalid_team")) {
        return sendJson(res, 400, { error: "Equipo inválido." });
      }
      if (error.message && error.message.includes("match_not_found")) {
        return sendJson(res, 404, { error: "Partido inexistente." });
      }
      throwIfError(error);
    }
    return respondWithState(req, res);
  }

  if (action === "delete-event" && method === "POST") {
    const { eventId } = await readBody(req);
    const numericEventId = Number(eventId);
    if (!Number.isInteger(numericEventId)) {
      return sendJson(res, 400, { error: "Gol inválido." });
    }

    const sb = getSupabase();
    const { data: event, error: eventError } = await sb
      .from("match_events")
      .select("id, match_id, team")
      .eq("id", numericEventId)
      .maybeSingle();
    throwIfError(eventError);
    if (!event) {
      return sendJson(res, 404, { error: "Gol inexistente." });
    }

    const { data: match, error: matchError } = await sb
      .from("matches")
      .select("id, team_a, team_b, score_a, score_b")
      .eq("id", event.match_id)
      .maybeSingle();
    throwIfError(matchError);

    const { error: deleteError } = await sb
      .from("match_events")
      .delete()
      .eq("id", numericEventId);
    throwIfError(deleteError);

    if (match) {
      let update = null;
      if (event.team === match.team_a) {
        update = { score_a: Math.max(0, match.score_a - 1) };
      } else if (event.team === match.team_b) {
        update = { score_b: Math.max(0, match.score_b - 1) };
      }
      if (update) {
        const { error: updateError } = await sb
          .from("matches")
          .update(update)
          .eq("id", match.id);
        throwIfError(updateError);
      }
    }

    return respondWithState(req, res);
  }

  return sendJson(res, 404, { error: "Acción no encontrada." });
}

module.exports = { handleApi };
