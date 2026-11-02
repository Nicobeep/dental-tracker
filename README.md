# Dental Patient Tracker

A personal, browser-based tool to track restorative treatment needs and recall appointments for dental patients.

- **Dashboard:** counts of overdue and upcoming recalls, plus a "Recalls needing attention" list you can act on directly.
- **Patients:** search by internal patient ID, add or delete patients, and keep free-text notes.
- **Restorative needs:** tooth, treatment, priority, status and notes for each item.
- **Recalls:** recall type, interval, last visit and automatically calculated next due date. Urgency is worked out from the due date, so it never goes stale.
- **Backups:** export everything to a JSON file and import it on any device.

It is a static web app: plain HTML, CSS and JavaScript with no build step, no framework and no dependencies. Light and dark themes follow your system setting, and the layout works on phones.

> **Privacy:** data is stored only in your browser (localStorage). Nothing is sent to a server. Use internal patient IDs, not names, and keep notes free of identifying details unless your organisation's privacy rules allow them.

---

## Quick start

### Option A: Run it on your computer

Requires Python 3.8 or newer. Nothing else to install.

```bash
python dental_tracker.py
```

This starts a local server at `http://127.0.0.1:8765/` and opens it in your browser. Press `Ctrl+C` to stop. Other options:

```bash
python dental_tracker.py --port 9000     # use a different port
python dental_tracker.py --no-browser    # don't open a browser window
```

Keep the default port. Browsers store data separately for each address, so a different port starts with an empty database.

### Option B: Open it with any static server

```bash
cd dental-tracker
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

### Option C: Host it on GitHub Pages

1. Create a GitHub repository and push these files to the root of the `main` branch:
   `index.html`, `styles.css`, `app.js`, `README.md`.
2. Go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to *Deploy from a branch*, choose **main** and **/ (root)**, then **Save**.
4. After a minute the site is live at `https://<your-username>.github.io/<repo-name>/`.

GitHub Pages is public, but the site contains only the app code. Patient data never leaves the browser that enters it.

---

## Using the app

1. **Create an account** on the *Create account* tab, then log in. Usernames are not case-sensitive.
2. **Add a patient** with *New patient* in the sidebar.
3. **Add treatments and recalls** from the patient's tabs. Click a row to select it, then edit or delete it.
4. **Check the dashboard** for recalls that are overdue or due within 14 days. Open the patient, or mark a recall *Contacted* or *Scheduled*.
5. **Back up regularly** with *Export backup* in the sidebar.

### Recall statuses

| Stored status | Meaning |
|---|---|
| Pending | No contact yet (default) |
| Contacted | Patient has been reached |
| Scheduled | Appointment booked; leaves the attention list |
| Completed | Recall finished; leaves the attention list |

Urgency is shown separately and calculated from the due date:

| Urgency | When |
|---|---|
| 🔴 Overdue | Due date has passed |
| 🟠 Due soon | Due within 30 days |
| 🟢 Upcoming | Due in more than 30 days |

---

## Data, backups and moving devices

- **Where data lives:** each browser keeps its own copy in localStorage. Data does not sync between computers or browsers.
- **Clearing site data erases the app's data.** Export a backup first.
- **Export backup** downloads a JSON file containing every patient, treatment and recall.
- **Import backup** replaces all current data with the contents of a backup file after you confirm. It checks the file and drops entries that don't fit the format.
- **Accounts** are local to each browser. Passwords are hashed with PBKDF2-SHA256 (200,000 iterations). This keeps accounts apart on a shared browser, but it does not encrypt the stored data, so anyone with access to your browser profile can read it.

### Moving from the older Streamlit version

If you have per-user databases from the earlier Streamlit version:

```bash
python tools/export_from_sqlite.py databases/yourname.db
```

This writes `yourname.backup.json`. Log in to the new app and use **Import backup**. Old recall statuses (Upcoming, Due Soon, Overdue) become *Pending*, because urgency is now calculated from the due date.

---

## Project layout

```
dental-tracker/
├── index.html          page shell
├── styles.css          all styling (light and dark themes)
├── app.js              the application
├── dental_tracker.py   optional local launcher (embeds the three web files)
├── tools/
│   └── export_from_sqlite.py   converts old Streamlit databases to backups
└── README.md
```

`app.js` is organised in layers, from top to bottom: constants and helpers, storage, data operations, a cached view model, rendering, and startup. All data changes go through one `commit()` function, which saves a copy and applies it only if the save succeeds.

### Rebuilding `dental_tracker.py`

If you change `index.html`, `styles.css` or `app.js`, rebuild the launcher so it embeds the new files. The build script is kept outside this folder, so re-create it from the launcher template or copy the three files into the launcher by hand.

---

## Limitations

- Single user per browser. No sharing between staff or devices.
- No server-side access control, audit log or encryption at rest.
- Intended for a single clinic's working data, not as a certified medical records system. Check your legal and privacy obligations before storing real patient information.

## License

MIT LICENSE.
