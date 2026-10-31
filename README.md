# Dental Patient Tracker

A static web app (plain HTML, CSS and JavaScript). There is no server, no build step and no Streamlit. It runs entirely in the browser, so GitHub Pages can host it.

## Deploy on GitHub Pages

1. Create a new GitHub repository and push these files to the **root** of the `main` branch (`index.html`, `app.js`, `styles.css`).
2. In the repo go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**, choose **main** and **/ (root)**, then **Save**.
4. After a minute the site is live at `https://<your-username>.github.io/<repo-name>/`.

To try it locally first, run `python3 -m http.server` in this folder and open http://localhost:8000.

## How your data is stored

- Accounts and patient data live in each browser's **localStorage**. Nothing is uploaded anywhere, and the repository never contains patient data.
- Data is **per browser and per device**. It does not sync, and clearing site data erases it. Use **Export backup** in the sidebar regularly, and **Import backup** to restore or move to another device.
- Log-in accounts are separate local profiles on that browser (passwords are hashed with PBKDF2). They keep profiles apart, but they are **not** protection against someone with access to the same browser profile, because the stored data is not encrypted.
- The app only asks for an internal patient ID. Avoid entering names or other identifying details in notes unless your organisation's privacy rules allow it.
- GitHub Pages on a free plan needs a public repository. That is fine here, since the repo holds only the app code.

## Moving data from the Streamlit version

For each user database in the old `databases/` folder:

```
python tools/export_from_sqlite.py databases/yourname.db
```

This writes `yourname.backup.json`. Log in to the new app and use **Import backup** to load it. Old stored recall statuses (Upcoming / Due Soon / Overdue) become Pending, because urgency is now calculated from the due date.
