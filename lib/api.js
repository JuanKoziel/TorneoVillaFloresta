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

async function advanceWinner(sb, match) {
  if (!match || !match.next_match_id) return;
  const scoreA = match.score_a || 0;
  const scoreB = match.score_b || 0;
  if (scoreA === scoreB) return; // no advance on draw
  const winnerTeam = scoreA > scoreB ? match.team_a : match.team_b;
  const loserTeam = scoreA > scoreB ? match.team_b : match.team_a;
  const nextSlot = match.next_slot || (match.bracket_key && match.bracket_key.includes('C1') || match.bracket_key && match.bracket_key.includes('C2') ? 'A' : 'B');
  
  if (nextSlot === 'A') {
    await sb.from('matches').update({ team_a: winnerTeam }).eq('id', match.next_match_id);
  } else if (nextSlot === 'B') {
    await sb.from('matches').update({ team_b: winnerTeam }).eq('id', match.next_match_id);
  }
}

function normalizeMinute(value) {
  const text = String(value || "").trim().slice(0, 20);
  if (!text) return "10'";
  if (text.includes("'")) return text;
  return /^\d+(?:\+\d+)?$/.test(text) ? `${text}'` : text;
}

async function fetchState(sb) {
  const [matchesResult, pollResult] = await Promise.all([
    sb
      .from("matches")
      .select(
        "id, group_name, match_time, team_a, team_b, score_a, score_b, cup, phase, bracket_key, next_match_id, next_slot, is_playoff, match_events(id, team, minute, player, created_at)"
      )
      .order("id", { ascending: true }),
    sb.from("poll_options").select("id, team, votes, category").order("id", { ascending: true }),
  ]);

  throwIfError(matchesResult.error);
  throwIfError(pollResult.error);

  const matches = matchesResult.data || [];
  let pollOptions = pollResult.data || [];

  const matchTeams = [
    ...new Set(matches.flatMap((match) => [match.team_a, match.team_b])),
  ];
  const existingTeams = new Set(pollOptions.map((option) => option.team));
  const missingTeams = matchTeams.filter((team) => !existingTeams.has(team));
  if (missingTeams.length > 0) {
    const nextId = pollOptions.reduce((max, option) => Math.max(max, option.id), 0) + 1;
    const { error: insertError } = await sb.from("poll_options").insert(
      missingTeams.map((team, index) => ({ id: nextId + index, team, votes: 0, category: 'ORO' }))
    );
    if (insertError && insertError.code !== "23505") throwIfError(insertError);

    const { data: refreshedPoll, error: refreshError } = await sb
      .from("poll_options")
      .select("id, team, votes, category")
      .order("id", { ascending: true });
    throwIfError(refreshError);
    pollOptions = refreshedPoll || pollOptions;
  }

  return {
    matches: matches.map((match) => ({
      id: match.id,
      group: match.group_name,
      time: match.match_time,
      teamA: match.team_a,
      teamB: match.team_b,
      scoreA: match.score_a,
      scoreB: match.score_b,
      cup: match.cup,
      phase: match.phase,
      bracket_key: match.bracket_key,
      next_match_id: match.next_match_id,
      next_slot: match.next_slot,
      is_playoff: match.is_playoff,
      events: (match.match_events || [])
        .slice()
        .sort((a, b) => {
          const minuteA = String(a.minute || "").match(/\d+/);
          const minuteB = String(b.minute || "").match(/\d+/);
          const valueA = minuteA ? Number(minuteA[0]) : Number.MAX_SAFE_INTEGER;
          const valueB = minuteB ? Number(minuteB[0]) : Number.MAX_SAFE_INTEGER;
          if (valueA !== valueB) return valueA - valueB;
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
    poll: pollOptions.map((option) => ({
      id: option.id,
      team: option.team,
      votes: option.votes,
      category: option.category || 'ORO',
    })),
  };
}

async function fetchVoteChoice(sb, voterId) {
  if (!voterId) return { voted: false, votedOptionId: null, votedOro: false, votedPlata: false, votedOroOptionId: null, votedPlataOptionId: null };
  const fingerprint = voterFingerprint(voterId);
  const { data, error } = await sb
    .from("votes")
    .select("option_id, cup")
    .eq("voter_hash", fingerprint);
  throwIfError(error);
  
  const votes = data || [];
  const oroVote = votes.find(v => v.cup === 'ORO');
  const plataVote = votes.find(v => v.cup === 'PLATA');
  
  return { 
    voted: votes.length > 0, 
    votedOptionId: oroVote?.option_id || plataVote?.option_id || null,
    votedOro: Boolean(oroVote),
    votedPlata: Boolean(plataVote),
    votedOroOptionId: oroVote?.option_id || null,
    votedPlataOptionId: plataVote?.option_id || null,
  };
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
    const { optionId, cup } = await readBody(req);
    const voteCup = String(cup || "").toUpperCase();
    const numericOptionId = Number(optionId);
    if (!Number.isInteger(numericOptionId)) {
      return sendJson(res, 400, { error: "Opci�n inv�lida." });
    }
    if (voteCup !== "ORO" && voteCup !== "PLATA") {
      return sendJson(res, 400, { error: "Copa inv�lida." });
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
      p_cup: voteCup,
    });
    throwIfError(error);

    const result = data || {};
    if (result.status === "invalid") {
      return sendJson(res, 404, { error: "Opci�n inexistente." });
    }

    const headers = cookieHeader ? { "Set-Cookie": cookieHeader } : {};
    if (result.status === "already") {
      return respondWithState(req, res, {
        status: 409,
        voterId,
        payload: { error: "Ya votaste en esta copa." },
        headers,
      });
    }

    return respondWithState(req, res, { voterId, headers });
  }

  if (!isAdmin(req)) {
    return sendJson(res, 403, { error: "Solo el administrador puede editar los resultados." });
  }

  if (action === "reset-votes" && method === "POST") {
    const sb = getSupabase();
    const { error: votesError } = await sb
      .from("votes")
      .delete()
      .gte("created_at", "1970-01-01T00:00:00.000Z");
    throwIfError(votesError);

    const { error: pollError } = await sb
      .from("poll_options")
      .update({ votes: 0 })
      .gte("id", 0);
    throwIfError(pollError);

    return respondWithState(req, res);
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

    try {
      const { data: match } = await sb.from("matches").select("*").eq("id", numericMatchId).single();
      if (match && match.is_playoff && match.next_match_id) {
        await advanceWinner(sb, match);
      }
    } catch (e) {}

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
      p_minute: normalizeMinute(minute),
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
