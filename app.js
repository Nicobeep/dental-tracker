"use strict";

/* ============================================================
   Dental Patient Tracker: static web app (no server, no build).
   Everything is stored in this browser's localStorage.
   ============================================================ */

// ============================================================
// CONSTANTS
// ============================================================

const PRIORITIES = ["High", "Medium", "Low"];
const TREATMENT_STATUSES = ["Planned", "Scheduled", "In Progress", "Completed", "Referred"];
const RECALL_TYPES = [
  "Perio Maintenance", "Prophy", "Periodic Exam",
  "Radiographs", "Post-op Follow-up", "Other",
];
const RECALL_INTERVALS = [3, 4, 6, 12, 18, 24, 36];
const RECALL_STATUSES = ["Pending", "Contacted", "Scheduled", "Completed"];
const CLOSED_STATUSES = ["Scheduled", "Completed"];
const ATTENTION_WINDOW_DAYS = 14;
const PBKDF2_ITERATIONS = 200000;

const USERS_KEY = "dpt.users";
const SESSION_KEY = "dpt.session";
const dataKey = (userKey) => `dpt.data.${userKey}`;


// ============================================================
// DOM HELPERS
// ============================================================

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


// ============================================================
// STORAGE
// ============================================================

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

let db = null; // { nextId, patients, treatments, recalls }

const emptyDb = () => ({ nextId: 1, patients: [], treatments: [], recalls: [] });
const nextId = () => db.nextId++;

function loadDb() {
  db = store.get(dataKey(state.userKey), null) || emptyDb();
}

function persist() {
  try {
    store.set(dataKey(state.userKey), db);
    return true;
  } catch {
    toast("Could not save: browser storage is full or blocked.");
    return false;
  }
}


// ============================================================
// AUTHENTICATION (local profiles)
// ============================================================

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
  db = null;
  closeDialog();
  render();
}


// ============================================================
// DATE HELPERS (all dates are "YYYY-MM-DD" strings)
// ============================================================

const pad = (n) => String(n).padStart(2, "0");

const formatDate = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date : null;
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

function daysUntil(value) {
  const date = parseDate(value);
  if (!date) return null;
  return Math.round((date - parseDate(todayStr())) / 86400000);
}

function timingText(days) {
  if (days == null) return "";
  if (days < 0) return `Overdue by ${-days} day${days === -1 ? "" : "s"}`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due in ${days} days`;
}

function urgency(days, status) {
  if (CLOSED_STATUSES.includes(status) || days == null) return { label: "-", tone: "gray" };
  if (days < 0) return { label: "Overdue", tone: "red" };
  if (days <= 30) return { label: "Due soon", tone: "amber" };
  return { label: "Upcoming", tone: "green" };
}

const normStatus = (status) => (RECALL_STATUSES.includes(status) ? status : "Pending");

const PRIORITY_TONE = { High: "red", Medium: "amber", Low: "gray" };
const TREATMENT_TONE = { Planned: "gray", Scheduled: "blue", "In Progress": "amber", Completed: "green", Referred: "gray" };
const RECALL_TONE = { Pending: "gray", Contacted: "blue", Scheduled: "blue", Completed: "green" };


// ============================================================
// DASHBOARD DATA
// ============================================================

function dashboardCounts() {
  let overdue = 0, week = 0, month = 0;
  for (const recall of db.recalls) {
    if (CLOSED_STATUSES.includes(normStatus(recall.status))) continue;
    const days = daysUntil(recall.nextDue);
    if (days == null) continue;
    if (days < 0) overdue++;
    else if (days <= 7) week++;
    else if (days <= 30) month++;
  }
  return { overdue, week, month };
}

function attentionRecalls() {
  const names = new Map(db.patients.map((p) => [p.id, p.patientId]));
  return db.recalls
    .filter((r) => !CLOSED_STATUSES.includes(normStatus(r.status)))
    .map((r) => ({ r, days: daysUntil(r.nextDue) }))
    .filter(({ days }) => days != null && days <= ATTENTION_WINDOW_DAYS)
    .sort((a, b) => a.days - b.days)
    .map(({ r, days }) => ({
      id: r.id,
      patientPk: r.patientId,
      patient: names.get(r.patientId) || "?",
      type: r.recallType,
      due: r.nextDue,
      days,
      status: normStatus(r.status),
    }));
}


// ============================================================
// DIALOGS
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

function newPatientDialog() {
  const error = h("p", { class: "form-error", role: "alert" });
  const form = h("form", {
    class: "dialog-body",
    onsubmit: (e) => {
      e.preventDefault();
      const id = e.currentTarget.elements.patientId.value.trim();
      if (!id) { error.textContent = "Enter a patient ID."; return; }
      if (db.patients.some((p) => p.patientId.toLowerCase() === id.toLowerCase())) {
        error.textContent = "That patient ID already exists.";
        return;
      }
      const patient = { id: nextId(), patientId: id, notes: "" };
      db.patients.push(patient);
      if (!persist()) return;
      state.selectedId = patient.id;
      state.selTx = state.selRc = null;
      closeDialog();
      renderList();
      renderDetail();
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
      if (tx) Object.assign(tx, record);
      else db.treatments.push({ id: nextId(), patientId, ...record });
      if (!persist()) return;
      closeDialog();
      renderDetail();
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
      const interval = Number(f.interval.value);
      const nextDue = addMonths(f.lastVisit.value, interval);
      if (!nextDue) { error.textContent = "Choose a valid last visit date."; return; }
      const record = {
        recallType: f.recallType.value,
        intervalMonths: interval,
        lastVisit: f.lastVisit.value,
        nextDue,
        status: f.status.value,
      };
      if (recall) Object.assign(recall, record);
      else db.recalls.push({ id: nextId(), patientId, ...record });
      if (!persist()) return;
      closeDialog();
      renderDetail();
      renderDashboard();
    },
  },
    field("Recall type", selectEl("recallType", RECALL_TYPES, recall?.recallType || "Periodic Exam")),
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


// ============================================================
// RENDERING
// ============================================================

function render() {
  const app = $("#app");
  app.replaceChildren();
  if (!state.userKey) {
    app.append(loginView());
    return;
  }
  app.append(appShell());
  renderList();
  renderDashboard();
  renderDetail();
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
      } else {
        if (f.password.value !== f.confirm.value) {
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
      h("h1", null, "🦷 Dental Patient Tracker"),
      h("p", { class: "muted" }, "Sign in to open your patient list."),
      tabs,
      form,
      h("p", { class: "login-note" },
        "Accounts and data are stored only in this browser. Nothing is sent to a server. " +
        "Use Export backup in the sidebar to keep a copy.")
    )
  );
}

// ---------- Shell & sidebar ----------

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
    h("h1", null, "Dental Patient Tracker"),
    h("section", { id: "dashboard" }),
    h("section", { id: "detail" })
  );

  return h("div", { class: "layout" }, sidebar, main);
}

function selectPatient(id) {
  state.selectedId = id;
  state.selTx = state.selRc = null;
  renderList();
  renderDetail();
}

function renderList() {
  const query = state.search.trim().toLowerCase();
  const patients = db.patients
    .filter((p) => p.patientId.toLowerCase().includes(query))
    .sort((a, b) => a.patientId.localeCompare(b.patientId, undefined, { numeric: true }));

  $("#patient-count").textContent = `${patients.length} patient${patients.length === 1 ? "" : "s"}`;

  const list = $("#patient-list");
  list.replaceChildren();
  if (!patients.length) list.append(h("p", { class: "muted small empty" }, "No patients found."));
  for (const p of patients) {
    list.append(
      h("button", {
        class: "patient-btn" + (p.id === state.selectedId ? " active" : ""),
        type: "button",
        onclick: () => selectPatient(p.id),
      }, p.patientId)
    );
  }
}

// ---------- Tables ----------

function dataTable(columns, rows, selectedId, onSelect) {
  const toggle = (row) => onSelect(row.id === selectedId ? null : row.id);
  return h("div", { class: "table-wrap" },
    h("table", null,
      h("thead", null, h("tr", null, columns.map((c) => h("th", null, c.label)))),
      h("tbody", null,
        rows.map((row) =>
          h("tr", {
            class: row.id === selectedId ? "selected" : "",
            tabIndex: 0,
            "aria-selected": String(row.id === selectedId),
            onclick: () => toggle(row),
            onkeydown: (e) => {
              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(row); }
            },
          }, columns.map((c) => h("td", { class: c.wrap ? "wrap" : "" }, c.render ? c.render(row) : (row[c.key] ?? ""))))
        )
      )
    )
  );
}

// ---------- Dashboard ----------

function metric(label, value, tone) {
  return h("div", { class: `metric ${tone || ""}` },
    h("div", { class: "metric-label" }, label),
    h("div", { class: "metric-value" }, String(value))
  );
}

function setRecallStatus(id, status) {
  const recall = db.recalls.find((r) => r.id === id);
  if (!recall) return;
  recall.status = status;
  if (!persist()) return;
  toast(`Marked ${status.toLowerCase()}`);
  renderDashboard();
  renderDetail();
}

function renderDashboard() {
  const root = $("#dashboard");
  root.replaceChildren();

  const counts = dashboardCounts();
  root.append(
    h("div", { class: "metrics" },
      metric("Overdue", counts.overdue, counts.overdue ? "red" : ""),
      metric("Due this week", counts.week),
      metric("Due this month", counts.month),
      metric("Patients", db.patients.length)
    )
  );

  const rows = attentionRecalls();
  if (!rows.some((r) => r.id === state.selAttn)) state.selAttn = null;
  const chosen = rows.find((r) => r.id === state.selAttn);

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
          {
            label: "Timing",
            render: (r) => badge(timingText(r.days), r.days <= 0 ? "red" : "amber"),
          },
          { label: "Status", render: (r) => badge(r.status, RECALL_TONE[r.status]) },
        ],
        rows,
        state.selAttn,
        (id) => { state.selAttn = id; renderDashboard(); }
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

  root.append(
    h("details", { class: "card attention", open: rows.length > 0 },
      h("summary", null, `🔔 Recalls needing attention${rows.length ? ` (${rows.length})` : ""}`),
      body
    )
  );
}

// ---------- Patient details ----------

function renderDetail() {
  const root = $("#detail");
  root.replaceChildren();

  const patient = db.patients.find((p) => p.id === state.selectedId);
  if (!patient) {
    state.selectedId = null;
    root.append(h("div", { class: "card empty-state" }, "Select a patient from the sidebar, or add a new one."));
    return;
  }

  const tabs = [
    ["treatments", "🦷 Restorative needs"],
    ["recalls", "📅 Recalls"],
    ["notes", "📝 Notes"],
  ];

  const panel =
    state.tab === "recalls" ? recallsPanel(patient) :
    state.tab === "notes" ? notesPanel(patient) :
    treatmentsPanel(patient);

  root.append(
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

function deletePatient(id) {
  db.treatments = db.treatments.filter((t) => t.patientId !== id);
  db.recalls = db.recalls.filter((r) => r.patientId !== id);
  db.patients = db.patients.filter((p) => p.id !== id);
  if (!persist()) return;
  state.selectedId = null;
  state.selTx = state.selRc = null;
  toast("Patient deleted");
  renderList();
  renderDashboard();
  renderDetail();
}

function treatmentsPanel(patient) {
  const rows = db.treatments.filter((t) => t.patientId === patient.id);
  if (!rows.some((t) => t.id === state.selTx)) state.selTx = null;
  const chosen = rows.find((t) => t.id === state.selTx);

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
        onclick: () => confirmDialog("Delete this treatment?", "Delete", () => {
          db.treatments = db.treatments.filter((t) => t.id !== chosen.id);
          if (!persist()) return;
          state.selTx = null;
          renderDetail();
        }),
      }, "Delete")
    )
  );
}

function recallsPanel(patient) {
  const rows = db.recalls
    .filter((r) => r.patientId === patient.id)
    .sort((a, b) => (a.nextDue || "").localeCompare(b.nextDue || ""));
  if (!rows.some((r) => r.id === state.selRc)) state.selRc = null;
  const chosen = rows.find((r) => r.id === state.selRc);

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
        onclick: () => confirmDialog("Delete this recall?", "Delete", () => {
          db.recalls = db.recalls.filter((r) => r.id !== chosen.id);
          if (!persist()) return;
          state.selRc = null;
          renderDetail();
          renderDashboard();
        }),
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
      onclick: () => {
        patient.notes = area.value.trim();
        if (persist()) toast("Notes saved");
      },
    }, "Save notes")
  );
}


// ============================================================
// BACKUP / RESTORE
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

/** Validate and normalize imported data so bad files can't corrupt the app. */
function sanitizeData(raw) {
  if (!raw || !Array.isArray(raw.patients)) {
    throw new Error("This file doesn't look like a Dental Patient Tracker backup.");
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
        db = data;
        if (!persist()) return;
        state.selectedId = null;
        state.selTx = state.selRc = state.selAttn = null;
        renderList();
        renderDashboard();
        renderDetail();
        toast("Backup imported");
      }
    );
  };
  reader.readAsText(file);
}


// ============================================================
// STARTUP
// ============================================================

function init() {
  const dlg = dialogEl();
  // Clicking the dimmed backdrop closes the dialog.
  dlg.addEventListener("click", (e) => { if (e.target === dlg) closeDialog(); });

  // Keep several open tabs in sync.
  window.addEventListener("storage", (e) => {
    if (state.userKey && e.key === dataKey(state.userKey)) {
      closeDialog();
      loadDb();
      renderList();
      renderDashboard();
      renderDetail();
    }
  });

  let saved = null;
  try { saved = sessionStorage.getItem(SESSION_KEY); } catch { /* ignore */ }
  const record = saved && store.get(USERS_KEY, {})[saved];
  if (record) startSession(record.username);
  else render();
}

init();
