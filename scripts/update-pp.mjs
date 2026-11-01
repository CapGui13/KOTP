#!/usr/bin/env node
/**
 * KOTP 1.19.0 — actualisation hebdomadaire des seuls PP gagnés.
 * Aucun secret n'est écrit dans le fichier publié ni dans les journaux.
 * En cas d'erreur (réseau, FFB, joueur, changement de saison), rien n'est publié.
 */
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const START = '/*__RANKING_STALKING_DATA_START__*/';
const END = '/*__RANKING_STALKING_DATA_END__*/';
const DEFAULT_PROXY = 'https://ranking-stalking-proxy.vercel.app';
const CONCURRENCY = 3;
const MAX_ATTEMPTS = 4;
const wait = ms => new Promise(r => setTimeout(r, ms));
const int = v => v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number.isInteger(Number(v)) ? Number(v) : null;

export function parseEmbedded(html) {
  const a = html.indexOf(START), b = html.indexOf(END);
  if (a < 0 || b <= a) {
    throw new Error('Délimiteurs EMBEDDED_DATA absents ou dupliqués');
  }
  const inner = html.slice(a + START.length, b);
  const m = inner.match(/^\s*const EMBEDDED_DATA\s*=\s*([\s\S]*?)\s*;\s*$/);
  if (!m) throw new Error('Bloc EMBEDDED_DATA illisible');
  let data;
  try { data = JSON.parse(m[1]); } catch { throw new Error('Données intégrées invalides'); }
  if (!Array.isArray(data?.players) || !data.season?.id) throw new Error('Base KOTP invalide');
  return { data, start: a, end: b + END.length };
}

export function serializeEmbedded(html, data) {
  const { start, end } = parseEmbedded(html);
  const next = `${START}\nconst EMBEDDED_DATA=${JSON.stringify(data)};\n${END}`;
  return html.slice(0, start) + next + html.slice(end);
}

function validate(data) {
  if (data.mode !== 'provence') throw new Error('Fichier hors Provence');
  if (data.players.length < 1) throw new Error('Classement vide');
  const ids = new Set();
  for (const r of data.players) {
    if (!Number.isSafeInteger(Number(r.person_id)) || Number(r.person_id) <= 0 || ids.has(Number(r.person_id))) throw new Error('Identifiant joueur absent ou en double');
    if (!Number.isInteger(int(r.pp_base)) || int(r.pp_base) < 125 || int(r.pp_withdrawal) === null) throw new Error('PP Base ou abattement non valide');
    ids.add(Number(r.person_id));
  }
  if (data.count && Number(data.count) !== data.players.length) throw new Error('Compteur / joueurs incohérents');
}

class ApiError extends Error {
  constructor(status, context) { super(`${context}: HTTP ${status}`); this.status = status; }
}

export async function makeFfbClient({ email, password, firebaseApiKey = process.env.FFB_FIREBASE_API_KEY, fetchImpl = fetch, proxy = DEFAULT_PROXY, pause = wait }) {
  if (!email || !email.includes('@') || !password) throw new Error('Configurer les secrets FFB_EMAIL (adresse e-mail) et FFB_PASSWORD');
  const apiKey = typeof firebaseApiKey === 'string' ? firebaseApiKey.trim() : '';
  if (!apiKey) throw new Error('Configurer le secret FFB_FIREBASE_API_KEY dans GitHub Actions');
  let token = '', refreshToken = '', expiry = 0, easi = '';

  async function request(url, opts = {}, context = 'API') {
    let last;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetchImpl(url, { ...opts, signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new ApiError(res.status, context);
        return await res.json();
      } catch (e) {
        last = e;
        const temporary = !(e instanceof ApiError) || [408, 425, 429, 500, 502, 503, 504].includes(e.status);
        if (!temporary || attempt === MAX_ATTEMPTS) break;
        await pause(Math.min(12000, 700 * 2 ** (attempt - 1)));
      }
    }
    throw last;
  }

  async function signin() {
    const data = await request('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + encodeURIComponent(apiKey), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true, clientType: 'CLIENT_TYPE_WEB' })
    }, 'Authentification FFB');
    if (!data?.idToken || !data?.refreshToken) throw new Error('Connexion FFB : jetons manquants');
    token = data.idToken; refreshToken = data.refreshToken;
    expiry = Date.now() + Math.max(60, Number(data.expiresIn) || 3600) * 1000 - 60000;
    easi = '';
  }

  async function ensureToken() {
    if (token && Date.now() < expiry) return;
    if (!refreshToken) return signin();
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
    const data = await request('https://securetoken.googleapis.com/v1/token?key=' + encodeURIComponent(apiKey), {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString()
    }, 'Renouvellement FFB');
    if (!data?.id_token) throw new Error('Impossible de renouveler la session FFB');
    token = data.id_token; refreshToken = data.refresh_token || refreshToken;
    expiry = Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000 - 60000;
    easi = '';
  }

  async function call(base, path, params = {}, bearer = null) {
    await ensureToken();
    const doCall = async tok => request(proxy.replace(/\/$/, '') + '/api/ffb', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
      body: JSON.stringify({ base, path, params })
    }, `FFB ${base}/${path}`);
    try { return await doCall(bearer || token); }
    catch (e) {
      if (e.status !== 401) throw e;
      // Le jeton FFB est devenu invalide pendant la lecture : renouveler puis retenter.
      expiry = 0; await ensureToken(); return doCall(token);
    }
  }

  async function easiToken() {
    if (easi) return easi;
    const data = await call('lancelot', 'users/me/easi-token');
    easi = typeof data === 'string' ? data : data?.token || data?.easi_token || data?.easiToken || '';
    return easi;
  }

  async function ranking(pid, seasonId) {
    const path = `api/persons/${pid}/ranking-page`, params = { seasonId };
    let error;
    try { return await call('www', path, params); }
    catch (e) { error = e; }
    // En cas de 401/403 sur www, l'API accepte parfois le jeton EASI.
    if ([401, 403].includes(error?.status)) {
      try {
        const et = await easiToken();
        if (et) {
          // Essayer l'ancien jeton directement, puis le jeton EASI, sans écraser la session.
          return await request(proxy.replace(/\/$/, '') + '/api/ffb', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + et },
            body: JSON.stringify({ base: 'www', path, params })
          }, 'FFB classement EASI');
        }
      } catch { /* lancelot est une alternative existante dans KOTP */ }
    }
    try { return await call('lancelot', `persons/${pid}/ranking-page`, params); }
    catch { throw error; }
  }

  await signin();
  return {
    currentSeason: () => call('lancelot', 'seasons/current'),
    ranking
  };
}

function updateHistory(row, sid, base, withdrawal, gained, total) {
  const history = Array.isArray(row.pp_history) ? row.pp_history : [];
  const entry = { season_id: sid, pp: base, withdrawal, gained, total, missing: false };
  const i = history.findIndex(h => int(h?.season_id) === sid);
  if (i >= 0) history[i] = entry; else history.push(entry);
  history.sort((a, b) => Number(b.season_id) - Number(a.season_id));
  row.pp_history = history;
  const peak = int(row.peak_pp);
  if (peak === null || base > peak || total > peak) {
    const next = Math.max(base, total);
    row.peak_pp = next;
    row.peak_pp_season_id = next === base ? Math.max(1, sid - 1) : sid;
  }
}

export function applyGains(data, gains, now = new Date().toISOString()) {
  validate(data);
  if (!(gains instanceof Map) || gains.size !== data.players.length) throw new Error('MAJ incomplète, publication refusée');
  const sid = Number(data.season.id);
  for (const r of data.players) {
    const base = int(r.pp_base), withdrawal = int(r.pp_withdrawal);
    const gained = int(gains.get(Number(r.person_id)));
    if (gained === null || gained < 0) throw new Error('PP gagnés absents/incohérents pour un joueur');
    const total = base + withdrawal + gained;
    if (!Number.isSafeInteger(total)) throw new Error('PP Total invalide');
    r.pp_gained = gained;
    r.pp_season = withdrawal + gained;
    r.pp_total = total;
    r.current_status = 'ok'; r.status = 'ok';
    updateHistory(r, sid, base, withdrawal, gained, total);
  }
  const c = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
  const disp = r => `${r.first_name || ''} ${r.last_name || ''}`.trim();
  const ranked = [...data.players].sort((a, b) => b.pp_total - a.pp_total || b.pp_base - a.pp_base || c.compare(disp(a), disp(b)));
  ranked.forEach((row, i) => { row.rank = i + 1; });
  data.count = data.players.length;
  data.generated_at = now; data.state_updated_at = now;
  data.province = data.province || {};
  data.province.last_pp_update_at = now;
  data.province.last_failed_pp_ids = [];
  data.province.last_update_scope = { type: 'pp-global', players: data.players.length, at: now };
  data.cache_meta = data.cache_meta || {}; data.cache_meta.pp_at = now;
  return data;
}

export async function updateDocument(html, options) {
  const { data } = parseEmbedded(html);
  validate(data);
  const api = options.api || await makeFfbClient({ ...options, html });
  const season = await api.currentSeason();
  if (!Number.isInteger(int(season?.id)) || Number(season.id) !== Number(data.season.id)) {
    throw new Error(`Saison FFB différente : base ${data.season.id}, FFB ${season?.id ?? 'inconnue'}. Nouvelle base nécessaire, fichier inchangé.`);
  }
  const ids = data.players.map(p => Number(p.person_id));
  const gains = new Map();
  let i = 0, success = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, ids.length) }, async () => {
    while (i < ids.length) {
      const pid = ids[i++];
      const rank = await api.ranking(pid, Number(season.id));
      const gained = int(rank?.iv?.ppSeason);
      if (gained === null || gained < 0) throw new Error(`PP gagnés invalides/indisponibles : personne ${pid}`);
      gains.set(pid, gained);
      success++;
      if (success % 50 === 0 || success === ids.length) console.log(`PP vérifiés : ${success}/${ids.length}`);
    }
  });
  await Promise.all(workers);
  if (gains.size !== ids.length) throw new Error('MAJ incomplète, fichier inchangé');
  applyGains(data, gains, options.now || new Date().toISOString());
  return { html: serializeEmbedded(html, data), count: gains.size, generated_at: data.generated_at };
}

async function main() {
  const file = resolve(process.argv[2] || 'index.html');
  const dryRun = process.argv.includes('--dry-run');
  const html = await readFile(file, 'utf8');
  const result = await updateDocument(html, { email: process.env.FFB_EMAIL, password: process.env.FFB_PASSWORD });
  if (!dryRun) {
    const temp = file + '.pending';
    try { await writeFile(temp, result.html, 'utf8'); await rename(temp, file); }
    catch (e) { await rm(temp, { force: true }); throw e; }
  }
  console.log(`${dryRun ? 'Simulation' : 'Actualisation'} terminée : ${result.count} joueurs / ${result.generated_at}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(e => { console.error('KOTP : ' + (e?.message || String(e))); process.exitCode = 1; });
}