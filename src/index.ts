export interface Env {
  DB: D1Database;
  ADMIN_TOKEN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  OAUTH_REDIRECT_URI: string;
  CALENDAR_A_ID: string;
  CALENDAR_B_ID: string;
  SYNC_DAYS: string;
  ENABLE_DELETE_SYNC: string;
}

type Side = "a" | "b";
type TriggerType = "manual" | "cron";

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

interface StoredToken {
  access_token: string;
  refresh_token: string | null;
  expires_at: number;
}

interface CalendarDateTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

interface CalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: CalendarDateTime;
  end?: CalendarDateTime;
  updated?: string;
}

interface EventsListResponse {
  items?: CalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

interface EventPair {
  pair_id: string;
  calendar_a_event_id: string | null;
  calendar_b_event_id: string | null;
  last_synced_hash_a: string | null;
  last_synced_hash_b: string | null;
  last_synced_updated_a: string | null;
  last_synced_updated_b: string | null;
  status: string;
}

interface PairMaps {
  byA: Map<string, EventPair>;
  byB: Map<string, EventPair>;
  byId: Map<string, EventPair>;
}

interface SyncStats {
  createdA: number;
  createdB: number;
  updatedA: number;
  updatedB: number;
  deletedA: number;
  deletedB: number;
  recordedDeletes: number;
  skipped: number;
  conflicts: number;
  fullSyncs: number;
  incrementalSyncs: number;
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const TOKEN_ROW_ID = "google";
const LOCK_NAME = "calendar-sync";
const LOCK_TTL_MS = 9 * 60 * 1000;

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8"
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/oauth/start") {
        return oauthStart(request, env);
      }

      if (request.method === "GET" && url.pathname === "/oauth/callback") {
        return oauthCallback(request, env);
      }

      if (url.pathname === "/sync" && request.method === "POST") {
        requireAdmin(request, env);
        const result = await runSync(env, "manual");
        return json(result, result.ok ? 200 : 409);
      }

      if (url.pathname === "/sync/status" && request.method === "GET") {
        requireAdmin(request, env);
        return json(await getStatus(env));
      }

      return json({ ok: false, error: "not_found" }, 404);
    } catch (error) {
      log("error", "request_failed", { path: url.pathname, error: errorMessage(error) });
      const status = error instanceof HttpError ? error.status : 500;
      return json({ ok: false, error: errorMessage(error) }, status);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runSync(env, "cron"));
  }
};

async function oauthStart(request: Request, env: Env): Promise<Response> {
  const state = await createState(env);
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", env.OAUTH_REDIRECT_URI || new URL("/oauth/callback", request.url).toString());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "https://www.googleapis.com/auth/calendar.events");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return Response.redirect(url.toString(), 302);
}

async function oauthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) throw new HttpError(400, `oauth_error:${error}`);
  if (!code || !state || !(await verifyState(env, state))) {
    throw new HttpError(400, "invalid_oauth_callback");
  }

  const token = await fetchToken({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: env.OAUTH_REDIRECT_URI || new URL("/oauth/callback", request.url).toString()
  });

  await saveToken(env, token);
  return html("OAuth completed. You can close this tab and run POST /sync.");
}

async function runSync(env: Env, triggerType: TriggerType): Promise<{ ok: boolean; message: string; stats?: SyncStats }> {
  const runId = crypto.randomUUID();
  const startedAt = nowIso();
  const owner = `${triggerType}:${runId}`;
  const stats = emptyStats();

  await env.DB.prepare(
    "INSERT INTO sync_runs (id, trigger_type, status, started_at, stats_json) VALUES (?, ?, 'running', ?, ?)"
  ).bind(runId, triggerType, startedAt, JSON.stringify(stats)).run();

  const lock = await acquireLock(env, owner);
  if (!lock) {
    await finishRun(env, runId, "skipped", "sync_already_running", stats);
    return { ok: false, message: "sync_already_running", stats };
  }

  try {
    const accessToken = await getAccessToken(env);
    const config = getConfig(env);
    const range = syncRange(config.syncDays);

    const [aChanges, bChanges] = await Promise.all([
      listChangedEvents(env, accessToken, config.calendarAId, range, stats),
      listChangedEvents(env, accessToken, config.calendarBId, range, stats)
    ]);

    const pairMaps = await loadPairMaps(env);
    await pairExistingMatchingEvents(env, aChanges.events, bChanges.events, stats, pairMaps);
    const touched = await collectTouchedPairs(env, accessToken, config, aChanges.events, bChanges.events, stats, pairMaps);
    const eventMapA = eventMapById(aChanges.events);
    const eventMapB = eventMapById(bChanges.events);

    for (const pair of touched) {
      await reconcilePair(
        env,
        accessToken,
        config,
        pair,
        stats,
        aChanges.fullSync && pair.calendar_a_event_id ? eventMapA.get(pair.calendar_a_event_id) ?? null : undefined,
        bChanges.fullSync && pair.calendar_b_event_id ? eventMapB.get(pair.calendar_b_event_id) ?? null : undefined
      );
    }

    await saveSyncToken(env, config.calendarAId, aChanges.nextSyncToken, aChanges.fullSync);
    await saveSyncToken(env, config.calendarBId, bChanges.nextSyncToken, bChanges.fullSync);

    await finishRun(env, runId, "success", "ok", stats);
    log("info", "sync_completed", { runId, triggerType, stats });
    return { ok: true, message: "ok", stats };
  } catch (error) {
    await finishRun(env, runId, "failed", errorMessage(error), stats);
    log("error", "sync_failed", { runId, triggerType, error: errorMessage(error), stats });
    throw error;
  } finally {
    await releaseLock(env, owner);
  }
}

async function collectTouchedPairs(
  env: Env,
  accessToken: string,
  config: ReturnType<typeof getConfig>,
  aEvents: CalendarEvent[],
  bEvents: CalendarEvent[],
  stats: SyncStats,
  pairMaps: PairMaps
): Promise<EventPair[]> {
  const pairs = new Map<string, EventPair>();

  for (const event of aEvents) {
    const pair = await findOrCreatePairForChangedEvent(env, accessToken, config, "a", event, stats, pairMaps);
    if (pair) pairs.set(pair.pair_id, pair);
  }

  for (const event of bEvents) {
    const pair = await findOrCreatePairForChangedEvent(env, accessToken, config, "b", event, stats, pairMaps);
    if (pair) pairs.set(pair.pair_id, pair);
  }

  return [...pairs.values()];
}

async function pairExistingMatchingEvents(
  env: Env,
  aEvents: CalendarEvent[],
  bEvents: CalendarEvent[],
  stats: SyncStats,
  pairMaps: PairMaps
): Promise<void> {
  const availableB = new Map<string, CalendarEvent[]>();

  for (const event of bEvents) {
    if (event.status === "cancelled" || pairMaps.byB.has(event.id)) continue;
    const key = eventMatchKey(event);
    const bucket = availableB.get(key) ?? [];
    bucket.push(event);
    availableB.set(key, bucket);
  }

  for (const eventA of aEvents) {
    if (eventA.status === "cancelled" || pairMaps.byA.has(eventA.id)) continue;
    const key = eventMatchKey(eventA);
    const bucket = availableB.get(key);
    const eventB = bucket?.shift();
    if (!eventB) continue;
    if (bucket && bucket.length === 0) availableB.delete(key);

    const now = nowIso();
    const pair: EventPair = {
      pair_id: crypto.randomUUID(),
      calendar_a_event_id: eventA.id,
      calendar_b_event_id: eventB.id,
      last_synced_hash_a: await eventHash(eventA),
      last_synced_hash_b: await eventHash(eventB),
      last_synced_updated_a: eventA.updated ?? null,
      last_synced_updated_b: eventB.updated ?? null,
      status: "active"
    };

    await env.DB.prepare(
      `INSERT INTO event_pairs (
        pair_id, calendar_a_event_id, calendar_b_event_id,
        last_synced_hash_a, last_synced_hash_b,
        last_synced_updated_a, last_synced_updated_b,
        status, last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
    ).bind(
      pair.pair_id,
      pair.calendar_a_event_id,
      pair.calendar_b_event_id,
      pair.last_synced_hash_a,
      pair.last_synced_hash_b,
      pair.last_synced_updated_a,
      pair.last_synced_updated_b,
      now,
      now
    ).run();

    addPairToMaps(pairMaps, pair);
    stats.skipped++;
    log("info", "existing_matching_events_paired", { eventAId: eventA.id, eventBId: eventB.id });
  }
}

async function findOrCreatePairForChangedEvent(
  env: Env,
  accessToken: string,
  config: ReturnType<typeof getConfig>,
  side: Side,
  event: CalendarEvent,
  stats: SyncStats,
  pairMaps: PairMaps
): Promise<EventPair | null> {
  const existing = side === "a" ? pairMaps.byA.get(event.id) : pairMaps.byB.get(event.id);
  if (existing) return existing;
  if (event.status === "cancelled") return null;

  const fromCalendar = side === "a" ? config.calendarAId : config.calendarBId;
  const toCalendar = side === "a" ? config.calendarBId : config.calendarAId;
  const copied = await createEvent(accessToken, toCalendar, toWritableEvent(event));
  const pairId = crypto.randomUUID();
  const now = nowIso();

  const aId = side === "a" ? event.id : copied.id;
  const bId = side === "a" ? copied.id : event.id;
  const hashA = side === "a" ? await eventHash(event) : await eventHash(copied);
  const hashB = side === "a" ? await eventHash(copied) : await eventHash(event);
  const updatedA = side === "a" ? event.updated ?? null : copied.updated ?? null;
  const updatedB = side === "a" ? copied.updated ?? null : event.updated ?? null;

  const pair: EventPair = {
    pair_id: pairId,
    calendar_a_event_id: aId,
    calendar_b_event_id: bId,
    last_synced_hash_a: hashA,
    last_synced_hash_b: hashB,
    last_synced_updated_a: updatedA,
    last_synced_updated_b: updatedB,
    status: "active"
  };

  await env.DB.prepare(
    `INSERT INTO event_pairs (
      pair_id, calendar_a_event_id, calendar_b_event_id,
      last_synced_hash_a, last_synced_hash_b,
      last_synced_updated_a, last_synced_updated_b,
      status, last_seen_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
  ).bind(pairId, aId, bId, hashA, hashB, updatedA, updatedB, now, now).run();

  if (side === "a") stats.createdB++;
  else stats.createdA++;

  addPairToMaps(pairMaps, pair);
  log("info", "event_created_on_other_calendar", { fromCalendar, toCalendar, sourceEventId: event.id, copiedEventId: copied.id });
  return null;
}

async function reconcilePair(
  env: Env,
  accessToken: string,
  config: ReturnType<typeof getConfig>,
  pair: EventPair,
  stats: SyncStats,
  knownEventA?: CalendarEvent | null,
  knownEventB?: CalendarEvent | null
): Promise<void> {
  const [eventA, eventB] = await Promise.all([
    knownEventA !== undefined ? Promise.resolve(knownEventA) : pair.calendar_a_event_id ? getEventOrNull(accessToken, config.calendarAId, pair.calendar_a_event_id) : Promise.resolve(null),
    knownEventB !== undefined ? Promise.resolve(knownEventB) : pair.calendar_b_event_id ? getEventOrNull(accessToken, config.calendarBId, pair.calendar_b_event_id) : Promise.resolve(null)
  ]);

  const deletedA = !eventA || eventA.status === "cancelled";
  const deletedB = !eventB || eventB.status === "cancelled";

  if (deletedA || deletedB) {
    await handleDeletes(env, accessToken, config, pair, eventA, eventB, deletedA, deletedB, stats);
    return;
  }

  const hashA = await eventHash(eventA);
  const hashB = await eventHash(eventB);
  const changedA = hashA !== pair.last_synced_hash_a;
  const changedB = hashB !== pair.last_synced_hash_b;

  if (!changedA && !changedB) {
    stats.skipped++;
    await touchPair(env, pair.pair_id);
    return;
  }

  if (changedA && changedB) stats.conflicts++;

  const winner: Side = changedA && changedB
    ? compareUpdated(eventA.updated, eventB.updated) >= 0 ? "a" : "b"
    : changedA ? "a" : "b";

  if (winner === "a") {
    const updatedB = await patchEvent(accessToken, config.calendarBId, pair.calendar_b_event_id!, toWritableEvent(eventA));
    await updatePairSnapshot(env, pair.pair_id, eventA, updatedB);
    stats.updatedB++;
    log("info", "event_updated", { pairId: pair.pair_id, source: "a", target: "b" });
  } else {
    const updatedA = await patchEvent(accessToken, config.calendarAId, pair.calendar_a_event_id!, toWritableEvent(eventB));
    await updatePairSnapshot(env, pair.pair_id, updatedA, eventB);
    stats.updatedA++;
    log("info", "event_updated", { pairId: pair.pair_id, source: "b", target: "a" });
  }
}

async function handleDeletes(
  env: Env,
  accessToken: string,
  config: ReturnType<typeof getConfig>,
  pair: EventPair,
  eventA: CalendarEvent | null,
  eventB: CalendarEvent | null,
  deletedA: boolean,
  deletedB: boolean,
  stats: SyncStats
): Promise<void> {
  const now = nowIso();

  if (deletedA && deletedB) {
    await env.DB.prepare(
      "UPDATE event_pairs SET status = 'deleted', deleted_a_at = COALESCE(deleted_a_at, ?), deleted_b_at = COALESCE(deleted_b_at, ?), last_seen_at = ?, updated_at = ? WHERE pair_id = ?"
    ).bind(now, now, now, now, pair.pair_id).run();
    stats.recordedDeletes++;
    return;
  }

  if (!config.enableDeleteSync) {
    await env.DB.prepare(
      `UPDATE event_pairs
       SET status = ?, deleted_a_at = CASE WHEN ? THEN COALESCE(deleted_a_at, ?) ELSE deleted_a_at END,
           deleted_b_at = CASE WHEN ? THEN COALESCE(deleted_b_at, ?) ELSE deleted_b_at END,
           last_seen_at = ?, updated_at = ?
       WHERE pair_id = ?`
    ).bind("delete_recorded", deletedA ? 1 : 0, now, deletedB ? 1 : 0, now, now, now, pair.pair_id).run();
    stats.recordedDeletes++;
    log("info", "delete_recorded_without_propagation", { pairId: pair.pair_id, deletedA, deletedB });
    return;
  }

  if (deletedA && pair.calendar_b_event_id) {
    await deleteEvent(accessToken, config.calendarBId, pair.calendar_b_event_id);
    await env.DB.prepare(
      "UPDATE event_pairs SET status = 'deleted', deleted_a_at = COALESCE(deleted_a_at, ?), deleted_b_at = COALESCE(deleted_b_at, ?), last_seen_at = ?, updated_at = ? WHERE pair_id = ?"
    ).bind(now, now, now, now, pair.pair_id).run();
    stats.deletedB++;
    return;
  }

  if (deletedB && pair.calendar_a_event_id) {
    await deleteEvent(accessToken, config.calendarAId, pair.calendar_a_event_id);
    await env.DB.prepare(
      "UPDATE event_pairs SET status = 'deleted', deleted_a_at = COALESCE(deleted_a_at, ?), deleted_b_at = COALESCE(deleted_b_at, ?), last_seen_at = ?, updated_at = ? WHERE pair_id = ?"
    ).bind(now, now, now, now, pair.pair_id).run();
    stats.deletedA++;
    return;
  }

  if (eventA && eventB) {
    await updatePairSnapshot(env, pair.pair_id, eventA, eventB);
  }
}

async function listChangedEvents(
  env: Env,
  accessToken: string,
  calendarId: string,
  range: { timeMin: string; timeMax: string },
  stats: SyncStats
): Promise<{ events: CalendarEvent[]; nextSyncToken: string; fullSync: boolean }> {
  const state = await env.DB.prepare("SELECT sync_token FROM sync_state WHERE calendar_id = ?").bind(calendarId).first<{ sync_token: string | null }>();
  const attemptIncremental = Boolean(state?.sync_token);

  if (attemptIncremental) {
    try {
      const result = await listAllEvents(accessToken, calendarId, { syncToken: state!.sync_token!, singleEvents: "true", showDeleted: "true" });
      stats.incrementalSyncs++;
      return { events: result.events, nextSyncToken: result.nextSyncToken, fullSync: false };
    } catch (error) {
      if (!(error instanceof GoogleApiError) || error.status !== 410) throw error;
      log("warn", "sync_token_expired_full_sync_fallback", { calendarId });
      await env.DB.prepare("UPDATE sync_state SET sync_token = NULL, updated_at = ? WHERE calendar_id = ?").bind(nowIso(), calendarId).run();
    }
  }

  try {
    const result = await listAllEvents(accessToken, calendarId, {
      timeMin: range.timeMin,
      timeMax: range.timeMax,
      singleEvents: "true",
      showDeleted: "true"
    });
    stats.fullSyncs++;
    return { events: result.events, nextSyncToken: result.nextSyncToken, fullSync: true };
  } catch (error) {
    if (error instanceof GoogleApiError) {
      throw new GoogleApiError(error.status, `calendarId=${calendarId}; ${error.body}`);
    }
    throw error;
  }
}

async function listAllEvents(
  accessToken: string,
  calendarId: string,
  params: Record<string, string>
): Promise<{ events: CalendarEvent[]; nextSyncToken: string }> {
  const events: CalendarEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;

  do {
    const url = new URL(`${GOOGLE_CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    url.searchParams.set("maxResults", "2500");

    const response = await googleFetch<EventsListResponse>(accessToken, url.toString());
    events.push(...(response.items ?? []));
    pageToken = response.nextPageToken;
    nextSyncToken = response.nextSyncToken ?? nextSyncToken;
  } while (pageToken);

  if (!nextSyncToken) {
    throw new Error(`missing_next_sync_token:${calendarId}:events=${events.length}`);
  }
  return { events, nextSyncToken };
}

async function getEventOrNull(accessToken: string, calendarId: string, eventId: string): Promise<CalendarEvent | null> {
  try {
    return await googleFetch<CalendarEvent>(accessToken, `${GOOGLE_CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
  } catch (error) {
    if (error instanceof GoogleApiError && (error.status === 404 || error.status === 410)) return null;
    throw error;
  }
}

async function createEvent(accessToken: string, calendarId: string, event: Partial<CalendarEvent>): Promise<CalendarEvent> {
  return googleFetch<CalendarEvent>(accessToken, `${GOOGLE_CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: "POST",
    body: JSON.stringify(event)
  });
}

async function patchEvent(accessToken: string, calendarId: string, eventId: string, event: Partial<CalendarEvent>): Promise<CalendarEvent> {
  return googleFetch<CalendarEvent>(accessToken, `${GOOGLE_CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    body: JSON.stringify(event)
  });
}

async function deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void> {
  await googleFetch<unknown>(accessToken, `${GOOGLE_CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: "DELETE"
  });
}

async function googleFetch<T>(accessToken: string, url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${accessToken}`);
  headers.set("content-type", "application/json; charset=utf-8");

  const response = await fetchWithRetry(url, {
    ...init,
    headers
  });

  if (!response.ok) {
    const body = await response.text();
    throw new GoogleApiError(response.status, body);
  }

  if (response.status === 204) return undefined as T;
  return response.json<T>();
}

async function fetchWithRetry(url: string, init: RequestInit, maxAttempts = 4): Promise<Response> {
  let lastResponse: Response | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(url, init);
    if (![429, 500, 502, 503, 504].includes(response.status)) return response;
    lastResponse = response;
    const retryAfter = Number(response.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(1000 * 2 ** (attempt - 1), 8000);
    log("warn", "google_api_retry", { url: safeUrl(url), status: response.status, attempt, waitMs });
    await sleep(waitMs);
  }

  return lastResponse!;
}

async function getAccessToken(env: Env): Promise<string> {
  const token = await env.DB.prepare("SELECT access_token, refresh_token, expires_at FROM oauth_tokens WHERE id = ?")
    .bind(TOKEN_ROW_ID)
    .first<StoredToken>();

  if (!token) throw new HttpError(428, "google_oauth_not_configured");
  if (Date.now() < token.expires_at - 60_000) return token.access_token;
  if (!token.refresh_token) throw new HttpError(428, "google_refresh_token_missing");

  const refreshed = await fetchToken({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: token.refresh_token
  });

  await saveToken(env, { ...refreshed, refresh_token: refreshed.refresh_token ?? token.refresh_token });
  return refreshed.access_token;
}

async function fetchToken(params: Record<string, string>): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams(params);
  const response = await fetchWithRetry(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) throw new HttpError(response.status, await response.text());
  return response.json<GoogleTokenResponse>();
}

async function saveToken(env: Env, token: GoogleTokenResponse): Promise<void> {
  const expiresAt = Date.now() + token.expires_in * 1000;
  await env.DB.prepare(
    `INSERT INTO oauth_tokens (id, access_token, refresh_token, expires_at, scope, token_type, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = COALESCE(excluded.refresh_token, oauth_tokens.refresh_token),
       expires_at = excluded.expires_at,
       scope = excluded.scope,
       token_type = excluded.token_type,
       updated_at = excluded.updated_at`
  ).bind(TOKEN_ROW_ID, token.access_token, token.refresh_token ?? null, expiresAt, token.scope ?? null, token.token_type ?? null, nowIso()).run();
}

async function saveSyncToken(env: Env, calendarId: string, syncToken: string, fullSync: boolean): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO sync_state (calendar_id, sync_token, last_full_sync_at, last_incremental_sync_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(calendar_id) DO UPDATE SET
       sync_token = excluded.sync_token,
       last_full_sync_at = COALESCE(excluded.last_full_sync_at, sync_state.last_full_sync_at),
       last_incremental_sync_at = COALESCE(excluded.last_incremental_sync_at, sync_state.last_incremental_sync_at),
       updated_at = excluded.updated_at`
  ).bind(calendarId, syncToken, fullSync ? now : null, fullSync ? null : now, now).run();
}

async function acquireLock(env: Env, owner: string): Promise<boolean> {
  const now = Date.now();
  await env.DB.prepare("DELETE FROM sync_locks WHERE name = ? AND expires_at < ?").bind(LOCK_NAME, now).run();
  try {
    await env.DB.prepare("INSERT INTO sync_locks (name, owner, expires_at) VALUES (?, ?, ?)")
      .bind(LOCK_NAME, owner, now + LOCK_TTL_MS)
      .run();
    return true;
  } catch {
    return false;
  }
}

async function releaseLock(env: Env, owner: string): Promise<void> {
  await env.DB.prepare("DELETE FROM sync_locks WHERE name = ? AND owner = ?").bind(LOCK_NAME, owner).run();
}

async function loadPairMaps(env: Env): Promise<PairMaps> {
  const rows = await env.DB.prepare("SELECT * FROM event_pairs WHERE status = 'active'").all<EventPair>();
  const maps: PairMaps = {
    byA: new Map(),
    byB: new Map(),
    byId: new Map()
  };

  for (const pair of rows.results) addPairToMaps(maps, pair);
  return maps;
}

function addPairToMaps(maps: PairMaps, pair: EventPair): void {
  maps.byId.set(pair.pair_id, pair);
  if (pair.calendar_a_event_id) maps.byA.set(pair.calendar_a_event_id, pair);
  if (pair.calendar_b_event_id) maps.byB.set(pair.calendar_b_event_id, pair);
}

function eventMapById(events: CalendarEvent[]): Map<string, CalendarEvent> {
  return new Map(events.map((event) => [event.id, event]));
}

async function findPairByEventId(env: Env, side: Side, eventId: string): Promise<EventPair | null> {
  const column = side === "a" ? "calendar_a_event_id" : "calendar_b_event_id";
  return env.DB.prepare(`SELECT * FROM event_pairs WHERE ${column} = ?`).bind(eventId).first<EventPair>();
}

async function findPairById(env: Env, pairId: string): Promise<EventPair | null> {
  return env.DB.prepare("SELECT * FROM event_pairs WHERE pair_id = ?").bind(pairId).first<EventPair>();
}

async function touchPair(env: Env, pairId: string): Promise<void> {
  const now = nowIso();
  await env.DB.prepare("UPDATE event_pairs SET last_seen_at = ?, updated_at = ? WHERE pair_id = ?").bind(now, now, pairId).run();
}

async function updatePairSnapshot(env: Env, pairId: string, eventA: CalendarEvent, eventB: CalendarEvent): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(
    `UPDATE event_pairs
     SET last_synced_hash_a = ?, last_synced_hash_b = ?,
         last_synced_updated_a = ?, last_synced_updated_b = ?,
         status = 'active', last_seen_at = ?, updated_at = ?
     WHERE pair_id = ?`
  ).bind(
    await eventHash(eventA),
    await eventHash(eventB),
    eventA.updated ?? null,
    eventB.updated ?? null,
    now,
    now,
    pairId
  ).run();
}

async function finishRun(env: Env, runId: string, status: string, message: string, stats: SyncStats): Promise<void> {
  await env.DB.prepare("UPDATE sync_runs SET status = ?, finished_at = ?, message = ?, stats_json = ? WHERE id = ?")
    .bind(status, nowIso(), message.slice(0, 1000), JSON.stringify(stats), runId)
    .run();
}

async function getStatus(env: Env): Promise<Record<string, unknown>> {
  const [states, lock, runs, counts, token] = await Promise.all([
    env.DB.prepare("SELECT * FROM sync_state ORDER BY calendar_id").all(),
    env.DB.prepare("SELECT name, owner, expires_at, created_at FROM sync_locks WHERE name = ?").bind(LOCK_NAME).first(),
    env.DB.prepare("SELECT id, trigger_type, status, started_at, finished_at, message, stats_json FROM sync_runs ORDER BY started_at DESC LIMIT 10").all(),
    env.DB.prepare("SELECT status, COUNT(*) AS count FROM event_pairs GROUP BY status").all(),
    env.DB.prepare("SELECT expires_at, scope, updated_at FROM oauth_tokens WHERE id = ?").bind(TOKEN_ROW_ID).first()
  ]);

  return {
    ok: true,
    calendars: {
      a: env.CALENDAR_A_ID,
      b: env.CALENDAR_B_ID
    },
    syncDays: Number(env.SYNC_DAYS || 60),
    enableDeleteSync: parseBoolean(env.ENABLE_DELETE_SYNC),
    oauthConfigured: Boolean(token),
    oauthToken: token ? { expires_at: token.expires_at, scope: token.scope, updated_at: token.updated_at } : null,
    syncState: states.results,
    lock,
    pairCounts: counts.results,
    recentRuns: runs.results
  };
}

function toWritableEvent(event: CalendarEvent): Partial<CalendarEvent> {
  return {
    summary: event.summary ?? "",
    description: event.description ?? "",
    location: event.location ?? "",
    start: event.start,
    end: event.end,
    status: event.status === "cancelled" ? undefined : event.status
  };
}

async function eventHash(event: CalendarEvent): Promise<string> {
  const normalized = JSON.stringify({
    summary: event.summary ?? "",
    description: event.description ?? "",
    location: event.location ?? "",
    start: normalizeDateTime(event.start),
    end: normalizeDateTime(event.end),
    status: event.status ?? "confirmed"
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeDateTime(value: CalendarDateTime | undefined): CalendarDateTime | null {
  if (!value) return null;
  return {
    date: value.date,
    dateTime: value.dateTime,
    timeZone: value.timeZone
  };
}

function eventMatchKey(event: CalendarEvent): string {
  return JSON.stringify({
    summary: event.summary ?? "",
    description: event.description ?? "",
    location: event.location ?? "",
    start: normalizeDateTime(event.start),
    end: normalizeDateTime(event.end),
    status: event.status ?? "confirmed"
  });
}

function compareUpdated(a?: string, b?: string): number {
  return Date.parse(a ?? "1970-01-01T00:00:00Z") - Date.parse(b ?? "1970-01-01T00:00:00Z");
}

function getConfig(env: Env) {
  if (!env.CALENDAR_A_ID || !env.CALENDAR_B_ID) throw new Error("calendar_ids_required");
  if (env.CALENDAR_A_ID === "primary" || env.CALENDAR_B_ID === "primary") throw new Error("primary_calendar_id_is_not_allowed");
  return {
    calendarAId: env.CALENDAR_A_ID,
    calendarBId: env.CALENDAR_B_ID,
    syncDays: Number(env.SYNC_DAYS || 60),
    enableDeleteSync: parseBoolean(env.ENABLE_DELETE_SYNC)
  };
}

function syncRange(days: number): { timeMin: string; timeMax: string } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + days);
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

async function createState(env: Env): Promise<string> {
  const timestamp = Date.now().toString();
  const nonce = crypto.randomUUID();
  const payload = `${timestamp}.${nonce}`;
  const signature = await hmac(env.ADMIN_TOKEN, payload);
  return `${payload}.${signature}`;
}

async function verifyState(env: Env, state: string): Promise<boolean> {
  const parts = state.split(".");
  if (parts.length !== 3) return false;
  const [timestamp, nonce, signature] = parts;
  const age = Date.now() - Number(timestamp);
  if (!Number.isFinite(age) || age < 0 || age > 10 * 60 * 1000) return false;
  const expected = await hmac(env.ADMIN_TOKEN, `${timestamp}.${nonce}`);
  return timingSafeEqual(signature, expected);
}

async function hmac(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let index = 0; index < a.length; index++) result |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return result === 0;
}

function requireAdmin(request: Request, env: Env): void {
  const expected = `Bearer ${env.ADMIN_TOKEN}`;
  if (!env.ADMIN_TOKEN || request.headers.get("authorization") !== expected) {
    throw new HttpError(401, "unauthorized");
  }
}

function emptyStats(): SyncStats {
  return {
    createdA: 0,
    createdB: 0,
    updatedA: 0,
    updatedB: 0,
    deletedA: 0,
    deletedB: 0,
    recordedDeletes: 0,
    skipped: 0,
    conflicts: 0,
    fullSyncs: 0,
    incrementalSyncs: 0
  };
}

function parseBoolean(value: string | undefined): boolean {
  return value?.toLowerCase() === "true";
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: jsonHeaders });
}

function html(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function log(level: "info" | "warn" | "error", message: string, fields: Record<string, unknown> = {}): void {
  console[level](JSON.stringify({ level, message, time: nowIso(), ...fields }));
}

function safeUrl(url: string): string {
  const parsed = new URL(url);
  parsed.search = "";
  return parsed.toString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

class GoogleApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`google_api_error:${status}:${body.slice(0, 300)}`);
  }
}
