// CompliCheck NYC: accounts and cloud portfolio (Supabase).
// Loaded as a module after the main script. When signed out, nothing changes: the
// portfolio stays in this browser. When signed in, the portfolio belongs to the
// user's organization in Supabase and this browser keeps a cache of it.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ORG_PREF = "nyccc.org.current";
const importedKey = org => `nyccc.imported.${org}`;
const state = { user: null, org: null, role: null, orgs: [], syncing: false, dirty: false, error: null, pushTimer: null };
const canWrite = () => ["owner", "admin", "member"].includes(state.role);

/* ---------- mapping between the browser portfolio entry and the buildings table ---------- */
const toRow = b => ({
  org_id: state.org.id, bin: b.bin, bbl: b.bbl || null, borough: b.borough || null,
  address: b.addr || b.label, label: b.label || null, name: b.name || null,
  last_checked: b.checked || null, summary: b.summary || null, events: b.events || null,
});
const fromRow = r => ({
  bin: r.bin, bbl: r.bbl, borough: r.borough, label: r.label || r.address, addr: r.address, name: r.name || "",
  added: (r.created_at || "").slice(0, 10), checked: r.last_checked || r.created_at, summary: r.summary || {}, events: r.events || [],
});

/* ---------- org selection ---------- */
async function loadOrgs() {
  const { data, error } = await sb.from("memberships")
    .select("role, organizations(id, name, kind)").eq("user_id", state.user.id);
  if (error) throw error;
  state.orgs = (data || []).filter(m => m.organizations).map(m => ({ ...m.organizations, role: m.role }));
  if (!state.orgs.length) {
    const name = (state.user.email.split("@")[1] || "My").split(".")[0];
    const { data: org, error: e2 } = await sb.from("organizations")
      .insert({ name: name.charAt(0).toUpperCase() + name.slice(1) + " portfolio", created_by: state.user.id })
      .select("id, name, kind").single();
    if (e2) throw e2;
    state.orgs = [{ ...org, role: "owner" }];
  }
  const pref = localStorage.getItem(ORG_PREF);
  const cur = state.orgs.find(o => o.id === pref) || state.orgs[0];
  state.org = cur; state.role = cur.role;
  localStorage.setItem(ORG_PREF, cur.id);
}

/* ---------- pull / push ---------- */
async function pull() {
  const { data, error } = await sb.from("buildings").select("*").eq("org_id", state.org.id).order("created_at");
  if (error) throw error;
  LS = `nyccc.cache.${state.org.id}`;                       // eslint-disable-line no-undef
  localStorage.setItem(LS, JSON.stringify((data || []).map(fromRow)));  // eslint-disable-line no-undef
  refreshViews();
}

async function push() {
  if (!state.org || !canWrite()) return;
  state.syncing = true; state.dirty = false; drawBar();
  const rows = loadP().map(toRow);                           // eslint-disable-line no-undef
  const { error } = rows.length
    ? await sb.from("buildings").upsert(rows, { onConflict: "org_id,bin" })
    : { error: null };
  state.syncing = false; state.error = error ? `Couldn't save to your account: ${error.message}` : null;
  if (state.dirty) schedulePush();
  drawBar();
}
function schedulePush() { clearTimeout(state.pushTimer); state.pushTimer = setTimeout(push, 800); }

async function removeRemote(bins) {
  if (!state.org || !canWrite() || !bins.length) return;
  const { error } = await sb.from("buildings").delete().eq("org_id", state.org.id).in("bin", bins);
  if (error) { state.error = `Couldn't remove from your account: ${error.message}`; drawBar(); }
}

/* ---------- import of the signed-out browser portfolio ---------- */
function localOnly() {
  try { return JSON.parse(localStorage.getItem(LS_LOCAL)) || []; } catch { return []; }  // eslint-disable-line no-undef
}
async function importLocal() {
  const cloud = loadP(), have = new Set(cloud.map(b => b.bin));  // eslint-disable-line no-undef
  const add = localOnly().filter(b => !have.has(b.bin));
  saveP(cloud.concat(add));                                   // eslint-disable-line no-undef  (triggers push)
  localStorage.setItem(importedKey(state.org.id), "1");
  await push(); refreshViews();
}

/* ---------- UI ---------- */
function refreshViews() {
  $("#pcount").textContent = loadP().length;                  // eslint-disable-line no-undef
  if (VIEW === "portfolio") drawPortfolio();                  // eslint-disable-line no-undef
  if (VIEW === "calendar") drawCalendar();                    // eslint-disable-line no-undef
  drawBar();
}

function drawAuth() {
  const box = $("#authbox");
  if (!state.user) { box.innerHTML = `<button class="btn ghostnav" id="signin" type="button" style="margin-right:0">Sign in</button>`; $("#signin").onclick = openSignIn; return; }
  box.innerHTML = `<span class="who" title="${esc(state.user.email)}">${esc(state.user.email)}</span>
    <button class="btn ghostnav" id="signout" type="button" style="margin-right:0">Sign out</button>`;
  $("#signout").onclick = async () => { await sb.auth.signOut(); };
}

function drawBar() {
  const bar = $("#cloudbar");
  if (!state.user) {
    bar.innerHTML = `<div><span class="grow">This portfolio is saved in this browser only. <b>Sign in</b> to keep it in your account and share it with your team.</span>
      <button class="btn sm" id="cb-signin">Sign in</button></div>`;
    bar.classList.remove("hidden"); $("#cb-signin").onclick = openSignIn; return;
  }
  const local = localOnly(), cloudBins = new Set(loadP().map(b => b.bin));  // eslint-disable-line no-undef
  const pending = local.filter(b => !cloudBins.has(b.bin)).length;
  const offerImport = pending && canWrite() && !localStorage.getItem(importedKey(state.org.id));
  const cls = state.error ? "err" : offerImport ? "warn" : "";
  const status = state.error ? esc(state.error)
    : state.syncing ? "Saving…"
    : `Synced to <b>${esc(state.org.name)}</b> · your role: ${esc(state.role)}${canWrite() ? "" : " (read-only)"}`;
  bar.innerHTML = `<div class="${cls}"><span class="grow">${status}${offerImport ? ` · <b>${pending}</b> building(s) from this browser aren't in your account yet.` : ""}</span>
    ${state.orgs.length > 1 ? `<select id="cb-org">${state.orgs.map(o => `<option value="${o.id}" ${o.id === state.org.id ? "selected" : ""}>${esc(o.name)}${o.kind === "partner" ? " (partner)" : ""}</option>`).join("")}</select>` : ""}
    ${offerImport ? `<button class="btn sm" id="cb-import">Import ${pending}</button><button class="btn sm light" id="cb-skip">Not now</button>` : ""}
    ${state.error ? `<button class="btn sm light" id="cb-retry">Retry</button>` : ""}</div>`;
  bar.classList.remove("hidden");
  $("#cb-import")?.addEventListener("click", importLocal);
  $("#cb-skip")?.addEventListener("click", () => { localStorage.setItem(importedKey(state.org.id), "skip"); drawBar(); });
  $("#cb-retry")?.addEventListener("click", () => { state.error = null; push(); });
  $("#cb-org")?.addEventListener("change", async e => {
    const o = state.orgs.find(x => x.id === e.target.value); state.org = o; state.role = o.role;
    localStorage.setItem(ORG_PREF, o.id); await pull();
  });
}

function openSignIn() {
  let m = $("#signinmodal");
  if (!m) {
    m = document.createElement("div");
    m.id = "signinmodal"; m.className = "modal-bg"; m.setAttribute("role", "dialog"); m.setAttribute("aria-modal", "true");
    m.innerHTML = `<div class="modal" style="max-width:440px">
      <div class="modal-h"><div><h2>Sign in</h2><p class="sub" style="margin:2px 0 0">We'll email you a sign-in link. No password needed.</p></div>
        <button class="iconbtn" id="si-close" aria-label="Close">✕</button></div>
      <form class="modal-b" id="si-form" style="padding-bottom:18px">
        <div class="field"><label for="si-email">Work email</label><input id="si-email" type="email" required autocomplete="email" placeholder="you@company.com"></div>
        <button class="btn" id="si-send" style="width:100%">Email me a sign-in link</button>
        <p class="src" id="si-msg" style="margin:12px 0 0"></p>
      </form></div>`;
    document.body.appendChild(m);
    const close = () => m.classList.add("hidden");
    $("#si-close").onclick = close;
    m.onclick = e => { if (e.target === m) close(); };
    $("#si-form").onsubmit = async e => {
      e.preventDefault();
      const email = $("#si-email").value.trim(), btn = $("#si-send"), msg = $("#si-msg");
      btn.disabled = true; btn.textContent = "Sending…"; msg.textContent = "";
      const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + "/" } });
      btn.disabled = false; btn.textContent = "Email me a sign-in link";
      if (error) { msg.innerHTML = `<span style="color:var(--bad)">${esc(error.message)}</span>`; return; }
      msg.innerHTML = `Check <b>${esc(email)}</b> for a link from Supabase and open it in this browser. It may take a minute; check spam too.`;
    };
  }
  m.classList.remove("hidden"); setTimeout(() => $("#si-email").focus(), 50);
}

/* ---------- session lifecycle ---------- */
async function onSignedIn(user) {
  if (state.user?.id === user.id && state.org) return;
  state.user = user; state.error = null; drawAuth();
  try { await loadOrgs(); await pull(); }
  catch (e) { state.error = `Couldn't load your account: ${e.message}`; drawBar(); }
  $("#signinmodal")?.classList.add("hidden");
  const u = new URL(location.href);
  if (u.searchParams.has("code")) { u.searchParams.delete("code"); history.replaceState(null, "", u.pathname + u.search + "#/portfolio"); route(); }  // eslint-disable-line no-undef
}
function onSignedOut() {
  state.user = null; state.org = null; state.role = null; state.orgs = []; state.error = null;
  LS = LS_LOCAL;                                              // eslint-disable-line no-undef
  drawAuth(); refreshViews();
}

window.CCCloud = {
  changed() { if (state.org && canWrite()) { state.dirty = true; if (!state.syncing) schedulePush(); } },
  removed(bins) { removeRemote(bins); },
  get state() { return { user: state.user?.email || null, org: state.org?.name || null, role: state.role, error: state.error }; },
  client: sb,
};

sb.auth.onAuthStateChange((event, session) => {
  if (session?.user) setTimeout(() => onSignedIn(session.user), 0);   // avoid awaiting inside the callback
  else if (event === "SIGNED_OUT") onSignedOut();
});
const { data: { session } } = await sb.auth.getSession();
if (session?.user) await onSignedIn(session.user); else { drawAuth(); drawBar(); }
