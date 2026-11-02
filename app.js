"use strict";

/* ============================================================
   Dental Patient Tracker: static web app (no server, no build).
   Data is stored in this browser's localStorage.

   Layers, top to bottom. Each layer only uses the ones above it:
     1. Constants and pure helpers   (no DOM, no storage)
     2. Storage and state
     3. Data operations              (commit() is the only place data changes)
     4. View model                   (buildView(): one derived snapshot, cached)
     5. Rendering                    (render* builds DOM from the snapshot)
     6. Backup and startup
   ============================================================ */


// ============================================================
// 1. CONSTANTS AND PURE HELPERS
// ============================================================

const PRIORITIES = ["High", "Medium", "Low"];
const TREATMENT_STATUSES = ["Planned", "Scheduled", "In Progress", "Completed", "Referred"];
const RECALL_TYPES = [
  "Perio Maintenance", "Prophy", "POE",
  "PERIAS", "Post-op Follow-up", "Other",
];
const RECALL_INTERVALS = [0, 3, 4, 6, 12, 18, 24, 36];
const RECALL_STATUSES = ["Pending", "Contacted", "Scheduled", "Completed"];
const CLOSED_STATUSES = new Set(["Scheduled", "Completed"]);
const ATTENTION_WINDOW_DAYS = 14;
const PBKDF2_ITERATIONS = 200000;

const PRIORITY_TONE = { High: "red", Medium: "amber", Low: "gray" };
const TREATMENT_TONE = { Planned: "gray", Scheduled: "blue", "In Progress": "amber", Completed: "green", Referred: "gray" };
const RECALL_TONE = { Pending: "gray", Contacted: "blue", Scheduled: "blue", Completed: "green" };

const USERS_KEY = "dpt.users";
const SESSION_KEY = "dpt.session";
const dataKey = (userKey) => `dpt.data.${userKey}`;

// Created once; numeric-aware so "P-2" sorts before "P-10".
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const pad = (n) => String(n).padStart(2, "0");

function emptyDb() {
  return { nextId: 1, patients: [], treatments: [], recalls: [] };
}

/** Dates are "YYYY-MM-DD" strings; parsed values are UTC-midnight Date objects. */
function parseDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date : null;
}

function formatDate(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Add calendar months, clamping to month end (Jan 31 + 1 month = Feb 28/29). */
function addMonths(value, months) {
  const date = parseDate(value);
  if (!date) return "";
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return formatDate(new Date(Date.UTC(y, m, Math.min(date.getUTCDate(), lastDay))));
}

/** Whole days from `fromDate` (a parsed Date) to a date string; null if invalid. */
function daysBetween(fromDate, value) {
  const date = parseDate(value);
  return date && fromDate ? Math.round((date - fromDate) / 86400000) : null;
}

function daysUntil(value) {
  return daysBetween(parseDate(todayStr()), value);
}

function timingText(days) {
  if (days == null) return "";
  if (days < 0) return `Overdue by ${-days} day${days === -1 ? "" : "s"}`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due in ${days} days`;
}

function urgency(days, status) {
  if (CLOSED_STATUSES.has(status) || days == null) return { label: "-", tone: "gray" };
  if (days < 0) return { label: "Overdue", tone: "red" };
  if (days <= 30) return { label: "Due soon", tone: "amber" };
  return { label: "Upcoming", tone: "green" };
}

/** Legacy rows may hold Upcoming / Due Soon / Overdue; those are now calculated. */
const normStatus = (status) => (RECALL_STATUSES.includes(status) ? status : "Pending");

const cmpText = (a, b) => {
  const x = a || "";
  const y = b || "";
  return x < y ? -1 : x > y ? 1 : 0;
};

function groupBy(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(row);
  }
  return groups;
}


// ============================================================
// 2. STORAGE AND STATE
// ============================================================

// ---------- DOM helpers ----------

const $ = (selector, root = document) => root.querySelector(selector);

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Build an element. Text is always inserted as text nodes, never as HTML. */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  append(el, children);
  return el;
}

function badge(text, tone) {
  return h("span", { class: `badge ${tone}` }, text);
}

let toastTimer;
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
}

// ---------- localStorage ----------

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  },
};

// ---------- State ----------

const state = {
  username: null,
  userKey: null,
  authMode: "login",
  selectedId: null,
  search: "",
  tab: "treatments",
  selTx: null,
  selRc: null,
  selAttn: null,
};

/** The dataset. Replace it only through setDb/commit, never by mutating it directly. */
let db = emptyDb();

/** Cached view model. Null means it must be rebuilt. */
let viewCache = null;

function setDb(next) {
  db = next;
  viewCache = null;
}

function loadDb() {
  setDb(store.get(dataKey(state.userKey), null) || emptyDb());
}

function writeDb(next) {
  try {
    store.set(dataKey(state.userKey), next);
    return true;
  } catch {
    toast("Could not save: browser storage is full or blocked.");
    return false;
  }
}


// ============================================================
// 3. DATA OPERATIONS
// ============================================================

/**
 * Apply `mutate` to a copy of the data and keep it only if the save succeeds.
 * Screens never show a change that isn't stored.
 */
function commit(mutate) {
  const draft = structuredClone(db);
  mutate(draft);
  if (!writeDb(draft)) return false;
  setDb(draft);
  return true;
}

function replaceAll(data) {
  if (!writeDb(data)) return false;
  setDb(data);
  return true;
}

const addRow = (draft, table, row) => {
  draft[table].push({ id: draft.nextId++, ...row });
};
const findRow = (draft, table, id) => draft[table].find((row) => row.id === id);
const removeRow = (draft, table, id) => {
  draft[table] = draft[table].filter((row) => row.id !== id);
};

function addPatient(rawId) {
  const identifier = rawId.trim();
  if (!identifier) return { error: "Enter a patient ID." };
  if (getView().patientKeys.has(identifier.toLowerCase())) {
    return { error: "That patient ID already exists." };
  }
  let id = null;
  const saved = commit((d) => {
    id = d.nextId++;
    d.patients.push({ id, patientId: identifier, notes: "" });
  });
  return saved ? { id } : { error: "Could not save the patient." };
}

function deletePatient(id) {
  const saved = commit((d) => {
    d.treatments = d.treatments.filter((t) => t.patientId !== id);
    d.recalls = d.recalls.filter((r) => r.patientId !== id);
    d.patients = d.patients.filter((p) => p.id !== id);
  });
  if (!saved) return;
  state.selectedId = null;
  state.selTx = state.selRc = null;
  toast("Patient deleted");
  renderAll();
}

function savePatientNotes(id, notes) {
  if (commit((d) => { const p = findRow(d, "patients", id); if (p) p.notes = notes.trim(); })) {
    toast("Notes saved");
  }
}

function saveTreatment(patientId, id, record) {
  return commit((d) => {
    if (id) Object.assign(findRow(d, "treatments", id) || {}, record);
    else addRow(d, "treatments", { patientId, ...record });
  });
}

function deleteTreatment(id) {
  return commit((d) => removeRow(d, "treatments", id));
}

function saveRecall(patientId, id, { recallType, intervalMonths, lastVisit, status }) {
  const data = { recallType, intervalMonths, lastVisit, nextDue: addMonths(lastVisit, intervalMonths), status };
  return commit((d) => {
    if (id) Object.assign(findRow(d, "recalls", id) || {}, data);
    else addRow(d, "recalls", { patientId, ...data });
  });
}

function deleteRecall(id) {
  return commit((d) => removeRow(d, "recalls", id));
}

function setRecallStatus(id, status) {
  if (!commit((d) => { const r = findRow(d, "recalls", id); if (r) r.status = status; })) return;
  toast(`Marked ${status.toLowerCase()}`);
  renderAll();
}

// ---------- Authentication (local profiles) ----------

const encoder = new TextEncoder();

const toHex = (buffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

const fromHex = (hex) => Uint8Array.from(hex.match(/../g).map((x) => parseInt(x, 16)));

async function hashPassword(password, saltHex) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key,
    256
  );
  return { hash: toHex(bits), salt: toHex(salt) };
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function createUser(username, password) {
  username = username.trim();
  if (username.length < 3) return { ok: false, message: "Username must be at least 3 characters." };
  if (password.length < 6) return { ok: false, message: "Password must be at least 6 characters." };
  if (!/^[A-Za-z0-9_.-]+$/.test(username)) {
    return { ok: false, message: "Username can only contain letters, numbers, _, -, and ." };
  }

  const users = store.get(USERS_KEY, {});
  const key = username.toLowerCase();
  if (users[key]) return { ok: false, message: "That username already exists." };

  const { hash, salt } = await hashPassword(password);
  users[key] = { username, hash, salt };
  try {
    store.set(USERS_KEY, users);
  } catch {
    return { ok: false, message: "Browser storage is unavailable, so the account could not be saved." };
  }
  return { ok: true, message: "Account created. You can now log in." };
}

async function authenticate(username, password) {
  const record = store.get(USERS_KEY, {})[username.trim().toLowerCase()];
  if (!record) return null;
  const { hash } = await hashPassword(password, record.salt);
  return safeEqual(hash, record.hash) ? record.username : null;
}

function startSession(username) {
  state.username = username;
  state.userKey = username.toLowerCase();
  state.selectedId = null;
  state.selTx = state.selRc = state.selAttn = null;
  state.search = "";
  state.tab = "treatments";
  try { sessionStorage.setItem(SESSION_KEY, state.userKey); } catch { /* ignore */ }
  loadDb();
  render();
}

function logout() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  state.username = state.userKey = null;
  setDb(emptyDb());
  closeDialog();
  render();
}


// ============================================================
// 4. VIEW MODEL
// ============================================================

/**
 * Derive everything the screens need in one pass over the data.
 * Rebuilt only after a change (commit / load / import), not on every render.
 */
function buildView() {
  const today = parseDate(todayStr());

  const patients = [...db.patients].sort((a, b) => collator.compare(a.patientId, b.patientId));
  const patientById = new Map(patients.map((p) => [p.id, p]));
  // Sorted by due date once, so every list built from it is already in order.
  const recalls = [...db.recalls].sort((a, b) => cmpText(a.nextDue, b.nextDue));

  const counts = { overdue: 0, week: 0, month: 0 };
  const attention = [];
  for (const r of recalls) {
    const status = normStatus(r.status);
    if (CLOSED_STATUSES.has(status)) continue;
    const days = daysBetween(today, r.nextDue);
    if (days == null) continue;

    // One pass feeds both the counters and the attention list.
    if (days < 0) counts.overdue++;
    else if (days <= 7) counts.week++;
    else if (days <= 30) counts.month++;

    if (days <= ATTENTION_WINDOW_DAYS) {
      attention.push({
        id: r.id,
        patientPk: r.patientId,
        patient: patientById.get(r.patientId)?.patientId ?? "?",
        type: r.recallType,
        due: r.nextDue,
        days,
        status,
      });
    }
  }

  return {
    patients,
    patientById,
    patientKeys: new Set(patients.map((p) => p.patientId.toLowerCase())),
    treatmentsByPatient: groupBy(db.treatments, (t) => t.patientId),
    recallsByPatient: groupBy(recalls, (r) => r.patientId),
    counts,
    attention,
  };
}

function getView() {
  if (!viewCache) viewCache = buildView();
  return viewCache;
}

// Thin accessors kept for the rest of the app and for tests.
const dashboardCounts = () => getView().counts;
const attentionRecalls = () => getView().attention;


// ============================================================
// 5. RENDERING
// ============================================================

const dialogEl = () => $("#dialog");

function openDialog(title, content) {
  const dlg = dialogEl();
  dlg.replaceChildren(
    h("div", { class: "dialog-head" },
      h("h2", null, title),
      h("button", { class: "icon-btn", type: "button", "aria-label": "Close", onclick: closeDialog }, "✕")
    ),
    content
  );
  if (!dlg.open) dlg.showModal();
}

function closeDialog() {
  const dlg = dialogEl();
  if (dlg && dlg.open) dlg.close();
}

function confirmDialog(message, confirmLabel, onConfirm) {
  openDialog("Please confirm",
    h("div", { class: "dialog-body" },
      h("p", null, message),
      h("div", { class: "actions" },
        h("button", { class: "btn", type: "button", onclick: closeDialog }, "Cancel"),
        h("button", {
          class: "btn danger", type: "button",
          onclick: () => { closeDialog(); onConfirm(); },
        }, confirmLabel)
      )
    )
  );
}

function field(label, control) {
  return h("label", { class: "field" }, h("span", null, label), control);
}

function selectEl(name, options, value) {
  return h("select", { name },
    options.map((o) => h("option", { value: String(o), selected: String(o) === String(value) }, String(o)))
  );
}

function formActions(submitLabel) {
  return h("div", { class: "actions" },
    h("button", { class: "btn", type: "button", onclick: closeDialog }, "Cancel"),
    h("button", { class: "btn primary", type: "submit" }, submitLabel)
  );
}

// ---------- Dialog forms ----------

function newPatientDialog() {
  const error = h("p", { class: "form-error", role: "alert" });
  const form = h("form", {
    class: "dialog-body",
    onsubmit: (e) => {
      e.preventDefault();
      const result = addPatient(e.currentTarget.elements.patientId.value);
      if (result.error) { error.textContent = result.error; return; }
      state.selectedId = result.id;
      state.selTx = state.selRc = null;
      closeDialog();
      renderAll();
    },
  },
    field("Internal patient ID", h("input", { type: "text", name: "patientId", autocomplete: "off", required: true })),
    error,
    formActions("Save patient")
  );
  openDialog("New patient", form);
  form.elements.patientId.focus();
}

function treatmentDialog(patientId, tx) {
  const error = h("p", { class: "form-error", role: "alert" });
  const form = h("form", {
    class: "dialog-body",
    onsubmit: (e) => {
      e.preventDefault();
      const f = e.currentTarget.elements;
      const record = {
        tooth: f.tooth.value.trim(),
        treatment: f.treatment.value.trim(),
        priority: f.priority.value,
        status: f.status.value,
        notes: f.notes.value.trim(),
      };
      if (!record.treatment) { error.textContent = "Enter a treatment."; return; }
      if (!saveTreatment(patientId, tx?.id ?? null, record)) return;
      closeDialog();
      renderAll();
    },
  },
    field("Tooth", h("input", { type: "text", name: "tooth", value: tx?.tooth || "", autocomplete: "off" })),
    field("Treatment", h("input", { type: "text", name: "treatment", value: tx?.treatment || "", autocomplete: "off" })),
    h("div", { class: "field-pair" },
      field("Priority", selectEl("priority", PRIORITIES, tx?.priority || "Medium")),
      field("Status", selectEl("status", TREATMENT_STATUSES, tx?.status || "Planned"))
    ),
    field("Notes", h("textarea", { name: "notes" }, tx?.notes || "")),
    error,
    formActions("Save treatment")
  );
  openDialog(tx ? "Edit treatment" : "Add treatment", form);
}

function recallDialog(patientId, recall) {
  const error = h("p", { class: "form-error", role: "alert" });
  const preview = h("p", { class: "muted small" });

  const form = h("form", {
    class: "dialog-body",
    onsubmit: (e) => {
      e.preventDefault();
      const f = e.currentTarget.elements;
      if (!parseDate(f.lastVisit.value)) { error.textContent = "Choose a valid last visit date."; return; }
      const saved = saveRecall(patientId, recall?.id ?? null, {
        recallType: f.recallType.value,
        intervalMonths: Number(f.interval.value),
        lastVisit: f.lastVisit.value,
        status: f.status.value,
      });
      if (!saved) return;
      closeDialog();
      renderAll();
    },
  },
    field("Recall type", selectEl("recallType", RECALL_TYPES, recall?.recallType || "POE")),
    h("div", { class: "field-pair" },
      field("Interval (months)", selectEl("interval", RECALL_INTERVALS, recall?.intervalMonths || 6)),
      field("Last visit", h("input", { type: "date", name: "lastVisit", value: recall?.lastVisit || todayStr(), required: true }))
    ),
    field("Status", selectEl("status", RECALL_STATUSES, normStatus(recall?.status))),
    preview,
    error,
    formActions("Save recall")
  );

  const updatePreview = () => {
    const f = form.elements;
    const due = addMonths(f.lastVisit.value, Number(f.interval.value));
    preview.textContent = due
      ? `Next due: ${due} (${timingText(daysUntil(due)).toLowerCase()}), calculated from last visit + interval.`
      : "Choose a valid last visit date.";
  };
  form.addEventListener("input", updatePreview);
  updatePreview();

  openDialog(recall ? "Edit recall" : "Add recall", form);
}

// ---------- Screens ----------

/** Full rebuild, used at login, logout and startup. */
function render() {
  const app = $("#app");
  if (!state.userKey) {
    app.replaceChildren(loginView());
    return;
  }
  app.replaceChildren(appShell());
  renderAll();
}

/** Refresh the data-driven parts. Everything uses the same cached view. */
function renderAll() {
  const v = getView();
  renderList(v);
  renderDashboard(v);
  renderDetail(v);
}

function selectPatient(id) {
  state.selectedId = id;
  state.selTx = state.selRc = null;
  renderAll();
}

// ---------- Login ----------

function loginView() {
  const isLogin = state.authMode === "login";
  const error = h("p", { class: "form-error", role: "alert" });

  const tabs = h("div", { class: "tabs", role: "tablist" },
    [["login", "Log in"], ["create", "Create account"]].map(([mode, label]) =>
      h("button", {
        class: "tab" + (state.authMode === mode ? " active" : ""),
        type: "button",
        "aria-selected": String(state.authMode === mode),
        onclick: () => { state.authMode = mode; render(); },
      }, label)
    )
  );

  const onSubmit = async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = form.elements;
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    error.textContent = "";
    try {
      if (isLogin) {
        const user = await authenticate(f.username.value, f.password.value);
        if (user) startSession(user);
        else error.textContent = "Invalid username or password.";
      } else if (f.password.value !== f.confirm.value) {
        error.textContent = "Passwords do not match.";
      } else {
        const result = await createUser(f.username.value, f.password.value);
        if (result.ok) {
          state.authMode = "login";
          render();
          toast(result.message);
        } else {
          error.textContent = result.message;
        }
      }
    } finally {
      button.disabled = false;
    }
  };

  const form = h("form", { onsubmit: onSubmit },
    field(isLogin ? "Username" : "Choose a username",
      h("input", { type: "text", name: "username", autocomplete: "username", required: true })),
    field(isLogin ? "Password" : "Choose a password",
      h("input", { type: "password", name: "password", autocomplete: isLogin ? "current-password" : "new-password", required: true })),
    !isLogin && field("Confirm password",
      h("input", { type: "password", name: "confirm", autocomplete: "new-password", required: true })),
    error,
    h("button", { class: "btn primary block", type: "submit" }, isLogin ? "Log in" : "Create account")
  );

  return h("div", { class: "login-wrap" },
    h("div", { class: "card login-card" },
      h("h1", null, "🦷 Dental Case Tracker"),
      h("p", { class: "muted" }, "Sign in to open your patient list."),
      tabs,
      form,
      h("p", { class: "login-note" },
        "Accounts and data are stored only in this browser. Nothing is sent to a server. " +
        "Use Export backup in the sidebar to keep a copy.")
    )
  );
}

// ---------- App shell and sidebar ----------

function appShell() {
  const fileInput = h("input", {
    type: "file", accept: "application/json,.json", hidden: true, onchange: importBackup,
  });

  const sidebar = h("aside", { class: "sidebar" },
    h("div", { class: "brand" },
      h("span", { class: "logo" }, "🦷"),
      h("div", null,
        h("strong", null, "Patient Tracker"),
        h("div", { class: "muted small" }, `Signed in as ${state.username}`)
      )
    ),
    h("button", { class: "btn primary block", type: "button", onclick: newPatientDialog }, "＋ New patient"),
    h("input", {
      type: "search", class: "input", placeholder: "Search patient ID…", "aria-label": "Search patients",
      value: state.search,
      oninput: (e) => { state.search = e.target.value; renderList(); },
    }),
    h("div", { id: "patient-count", class: "muted small" }),
    h("div", { id: "patient-list", class: "patient-list" }),
    h("div", { class: "sidebar-foot" },
      h("button", { class: "btn block", type: "button", onclick: exportBackup }, "Export backup"),
      h("button", { class: "btn block", type: "button", onclick: () => fileInput.click() }, "Import backup"),
      fileInput,
      h("button", { class: "btn ghost block", type: "button", onclick: logout }, "Log out")
    )
  );

  const main = h("main", { class: "main" },
    h("h1", null, "Dental Case Tracker"),
    h("section", { id: "dashboard" }),
    h("section", { id: "detail" })
  );

  return h("div", { class: "layout" }, sidebar, main);
}

function renderList(v = getView()) {
  const query = state.search.trim().toLowerCase();
  const patients = query
    ? v.patients.filter((p) => p.patientId.toLowerCase().includes(query))
    : v.patients;

  $("#patient-count").textContent = `${patients.length} patient${patients.length === 1 ? "" : "s"}`;

  const nodes = patients.length
    ? patients.map((p) =>
        h("button", {
          class: "patient-btn" + (p.id === state.selectedId ? " active" : ""),
          type: "button",
          onclick: () => selectPatient(p.id),
        }, p.patientId))
    : [h("p", { class: "muted small empty" }, "No patients found.")];

  $("#patient-list").replaceChildren(...nodes);
}

// ---------- Shared table and metric helpers ----------

function dataTable(columns, rows, selectedId, onSelect) {
  return h("div", { class: "table-wrap" },
    h("table", null,
      h("thead", null, h("tr", null, columns.map((c) => h("th", null, c.label)))),
      h("tbody", null,
        rows.map((row) => {
          const toggle = () => onSelect(row.id === selectedId ? null : row.id);
          return h("tr", {
            class: row.id === selectedId ? "selected" : "",
            tabIndex: 0,
            "aria-selected": String(row.id === selectedId),
            onclick: toggle,
            onkeydown: (e) => {
              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
            },
          }, columns.map((c) =>
            h("td", { class: c.wrap ? "wrap" : "" }, c.render ? c.render(row) : (row[c.key] ?? ""))
          ));
        })
      )
    )
  );
}

function metric(label, value, tone) {
  return h("div", { class: `metric ${tone || ""}` },
    h("div", { class: "metric-label" }, label),
    h("div", { class: "metric-value" }, String(value))
  );
}

// ---------- Dashboard ----------

function renderDashboard(v = getView()) {
  const root = $("#dashboard");
  const rows = v.attention;

  state.selAttn = rows.some((r) => r.id === state.selAttn) ? state.selAttn : null;
  const chosen = rows.find((r) => r.id === state.selAttn) || null;

  let body;
  if (!rows.length) {
    body = h("p", { class: "muted" }, `Nothing overdue or due in the next ${ATTENTION_WINDOW_DAYS} days.`);
  } else {
    body = h("div", null,
      dataTable(
        [
          { label: "Patient", key: "patient" },
          { label: "Recall", key: "type" },
          { label: "Due", key: "due" },
          { label: "Timing", render: (r) => badge(timingText(r.days), r.days <= 0 ? "red" : "amber") },
          { label: "Status", render: (r) => badge(r.status, RECALL_TONE[r.status]) },
        ],
        rows,
        state.selAttn,
        (id) => { state.selAttn = id; renderDashboard(v); }
      ),
      h("div", { class: "row-actions" },
        h("button", {
          class: "btn", type: "button", disabled: !chosen,
          onclick: () => selectPatient(chosen.patientPk),
        }, "Open patient"),
        h("button", {
          class: "btn", type: "button", disabled: !chosen,
          onclick: () => setRecallStatus(chosen.id, "Contacted"),
        }, "Mark contacted"),
        h("button", {
          class: "btn", type: "button", disabled: !chosen,
          onclick: () => setRecallStatus(chosen.id, "Scheduled"),
        }, "Mark scheduled")
      ),
      h("p", { class: "hint" }, "Select a row to act on it.")
    );
  }

  const { overdue, week, month } = v.counts;
  root.replaceChildren(
    h("div", { class: "metrics" },
      metric("Overdue", overdue, overdue ? "red" : ""),
      metric("Due this week", week),
      metric("Due this month", month),
      metric("Patients", v.patients.length)
    ),
    h("details", { class: "card attention", open: rows.length > 0 },
      h("summary", null, `🔔 Recalls needing attention${rows.length ? ` (${rows.length})` : ""}`),
      body
    )
  );
}

// ---------- Patient details ----------

function renderDetail(v = getView()) {
  const root = $("#detail");
  const patient = v.patientById.get(state.selectedId);

  if (!patient) {
    state.selectedId = null;
    root.replaceChildren(h("div", { class: "card empty-state" }, "Select a patient from the sidebar, or add a new one."));
    return;
  }

  const tabs = [
    ["treatments", "🦷 Restorative needs"],
    ["recalls", "📅 Recalls"],
    ["notes", "📝 Notes"],
  ];

  const panel =
    state.tab === "recalls" ? recallsPanel(patient, v) :
    state.tab === "notes" ? notesPanel(patient) :
    treatmentsPanel(patient, v);

  root.replaceChildren(
    h("div", { class: "detail-head" },
      h("h2", null, `Patient ${patient.patientId}`),
      h("button", {
        class: "btn danger", type: "button",
        onclick: () => confirmDialog(
          `Delete patient ${patient.patientId} along with all of their treatments and recalls? This cannot be undone.`,
          "Yes, delete",
          () => deletePatient(patient.id)
        ),
      }, "Delete patient")
    ),
    h("div", { class: "card" },
      h("div", { class: "tabs", role: "tablist" },
        tabs.map(([key, label]) =>
          h("button", {
            class: "tab" + (state.tab === key ? " active" : ""),
            type: "button",
            "aria-selected": String(state.tab === key),
            onclick: () => { state.tab = key; renderDetail(); },
          }, label)
        )
      ),
      panel
    )
  );
}

function treatmentsPanel(patient, v) {
  const rows = v.treatmentsByPatient.get(patient.id) || [];
  const chosen = rows.find((t) => t.id === state.selTx) || null;
  state.selTx = chosen ? chosen.id : null;

  return h("div", null,
    rows.length
      ? dataTable(
          [
            { label: "Tooth", key: "tooth" },
            { label: "Treatment", key: "treatment" },
            { label: "Priority", render: (t) => badge(t.priority, PRIORITY_TONE[t.priority] || "gray") },
            { label: "Status", render: (t) => badge(t.status, TREATMENT_TONE[t.status] || "gray") },
            { label: "Notes", key: "notes", wrap: true },
          ],
          rows,
          state.selTx,
          (id) => { state.selTx = id; renderDetail(); }
        )
      : h("p", { class: "muted" }, "No restorative needs recorded."),
    rows.length ? h("p", { class: "hint" }, "Select a row to edit or delete it.") : null,
    h("div", { class: "row-actions" },
      h("button", { class: "btn primary", type: "button", onclick: () => treatmentDialog(patient.id) }, "＋ Add treatment"),
      h("button", {
        class: "btn", type: "button", disabled: !chosen,
        onclick: () => treatmentDialog(patient.id, chosen),
      }, "Edit"),
      h("button", {
        class: "btn", type: "button", disabled: !chosen,
        onclick: () => {
          const id = chosen.id;
          confirmDialog("Delete this treatment?", "Delete", () => {
            if (!deleteTreatment(id)) return;
            state.selTx = null;
            renderAll();
          });
        },
      }, "Delete")
    )
  );
}

function recallsPanel(patient, v) {
  const rows = v.recallsByPatient.get(patient.id) || [];
  const chosen = rows.find((r) => r.id === state.selRc) || null;
  state.selRc = chosen ? chosen.id : null;

  return h("div", null,
    rows.length
      ? dataTable(
          [
            { label: "Recall", key: "recallType" },
            { label: "Interval", render: (r) => (r.intervalMonths ? `${r.intervalMonths} months` : "") },
            { label: "Last visit", key: "lastVisit" },
            { label: "Next due", key: "nextDue" },
            { label: "Status", render: (r) => badge(normStatus(r.status), RECALL_TONE[normStatus(r.status)]) },
            {
              label: "Urgency",
              render: (r) => {
                const u = urgency(daysUntil(r.nextDue), normStatus(r.status));
                return badge(u.label, u.tone);
              },
            },
          ],
          rows,
          state.selRc,
          (id) => { state.selRc = id; renderDetail(); }
        )
      : h("p", { class: "muted" }, "No recalls recorded."),
    rows.length ? h("p", { class: "hint" }, "Select a row to edit or delete it.") : null,
    h("div", { class: "row-actions" },
      h("button", { class: "btn primary", type: "button", onclick: () => recallDialog(patient.id) }, "＋ Add recall"),
      h("button", {
        class: "btn", type: "button", disabled: !chosen,
        onclick: () => recallDialog(patient.id, chosen),
      }, "Edit"),
      h("button", {
        class: "btn", type: "button", disabled: !chosen,
        onclick: () => {
          const id = chosen.id;
          confirmDialog("Delete this recall?", "Delete", () => {
            if (!deleteRecall(id)) return;
            state.selRc = null;
            renderAll();
          });
        },
      }, "Delete")
    )
  );
}

function notesPanel(patient) {
  const area = h("textarea", {
    class: "input notes-area", "aria-label": "Patient notes", placeholder: "Notes about this patient…",
  }, patient.notes || "");
  return h("div", null,
    area,
    h("button", {
      class: "btn primary", type: "button",
      onclick: () => savePatientNotes(patient.id, area.value),
    }, "Save notes")
  );
}


// ============================================================
// 6. BACKUP, STARTUP
// ============================================================

function exportBackup() {
  const payload = {
    app: "dental-patient-tracker",
    version: 1,
    exportedAt: new Date().toISOString(),
    data: db,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  const link = h("a", { href: url, download: `dental-tracker-backup-${todayStr()}.json` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Validate and normalize imported data so a bad file can't corrupt the app. */
function sanitizeData(raw) {
  if (!raw || !Array.isArray(raw.patients)) {
    throw new Error("This file doesn't look like a Dental Case Tracker backup.");
  }
  const str = (v) => (v == null ? "" : String(v));
  const int = (v) => {
    const n = Number(v);
    if (!Number.isInteger(n)) throw new Error("The backup file contains an invalid ID.");
    return n;
  };

  const patients = raw.patients.map((p) => ({ id: int(p.id), patientId: str(p.patientId).trim(), notes: str(p.notes) }));
  if (patients.some((p) => !p.patientId)) throw new Error("The backup file has a patient with no ID.");
  if (new Set(patients.map((p) => p.id)).size !== patients.length ||
      new Set(patients.map((p) => p.patientId.toLowerCase())).size !== patients.length) {
    throw new Error("The backup file contains duplicate patients.");
  }
  const known = new Set(patients.map((p) => p.id));

  const treatments = (raw.treatments || [])
    .filter((t) => known.has(Number(t.patientId)))
    .map((t) => ({
      id: int(t.id), patientId: int(t.patientId),
      tooth: str(t.tooth), treatment: str(t.treatment),
      priority: PRIORITIES.includes(t.priority) ? t.priority : "Medium",
      status: TREATMENT_STATUSES.includes(t.status) ? t.status : "Planned",
      notes: str(t.notes),
    }));

  const recalls = (raw.recalls || [])
    .filter((r) => known.has(Number(r.patientId)))
    .map((r) => {
      const intervalMonths = RECALL_INTERVALS.includes(Number(r.intervalMonths)) ? Number(r.intervalMonths) : 6;
      const lastVisit = parseDate(r.lastVisit) ? r.lastVisit : "";
      return {
        id: int(r.id), patientId: int(r.patientId),
        recallType: RECALL_TYPES.includes(r.recallType) ? r.recallType : "Other",
        intervalMonths, lastVisit,
        nextDue: parseDate(r.nextDue) ? r.nextDue : addMonths(lastVisit, intervalMonths),
        status: normStatus(r.status),
      };
    });

  const maxId = Math.max(0, ...patients.map((p) => p.id), ...treatments.map((t) => t.id), ...recalls.map((r) => r.id));
  return { nextId: maxId + 1, patients, treatments, recalls };
}

function importBackup(event) {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;

  const reader = new FileReader();
  reader.onerror = () => toast("Could not read that file.");
  reader.onload = () => {
    let data;
    try {
      const parsed = JSON.parse(reader.result);
      data = sanitizeData(parsed.data || parsed);
    } catch (err) {
      toast(err instanceof SyntaxError ? "That file isn't valid JSON." : err.message);
      return;
    }
    confirmDialog(
      `Replace all current data with the backup (${data.patients.length} patients)? This cannot be undone.`,
      "Replace data",
      () => {
        if (!replaceAll(data)) return;
        state.selectedId = null;
        state.selTx = state.selRc = state.selAttn = null;
        renderAll();
        toast("Backup imported");
      }
    );
  };
  reader.readAsText(file);
}

function init() {
  const dlg = dialogEl();
  // Clicking the dimmed backdrop closes the dialog.
  dlg.addEventListener("click", (e) => { if (e.target === dlg) closeDialog(); });

  // Keep several open tabs in sync.
  window.addEventListener("storage", (e) => {
    if (state.userKey && e.key === dataKey(state.userKey)) {
      closeDialog();
      loadDb();
      renderAll();
    }
  });

  let saved = null;
  try { saved = sessionStorage.getItem(SESSION_KEY); } catch { /* ignore */ }
  const record = saved && store.get(USERS_KEY, {})[saved];
  if (record) startSession(record.username);
  else render();
}

init();
