#!/usr/bin/env python3
"""Convert a per-user SQLite database from the old Streamlit version into a
JSON backup that the web app can import (sidebar -> Import backup).

Usage:
    python export_from_sqlite.py databases/yourname.db [output.json]
"""

import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

LEGACY_STATUSES = {"Upcoming", "Due Soon", "Overdue"}  # these are now calculated, not stored


def rows(conn, query):
    return [dict(r) for r in conn.execute(query)]


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)

    source = Path(sys.argv[1])
    if not source.exists():
        sys.exit(f"File not found: {source}")
    target = Path(sys.argv[2]) if len(sys.argv) > 2 else source.with_suffix(".backup.json")

    conn = sqlite3.connect(source)
    conn.row_factory = sqlite3.Row

    patients = [
        {"id": r["id"], "patientId": r["patient_id"], "notes": r["notes"] or ""}
        for r in rows(conn, "SELECT id, patient_id, notes FROM patients")
    ]
    treatments = [
        {
            "id": r["id"], "patientId": r["patient_id"],
            "tooth": r["tooth"] or "", "treatment": r["treatment"] or "",
            "priority": r["priority"] or "Medium", "status": r["status"] or "Planned",
            "notes": r["notes"] or "",
        }
        for r in rows(conn, "SELECT * FROM treatment_needs")
    ]
    recalls = [
        {
            "id": r["id"], "patientId": r["patient_id"],
            "recallType": r["recall_type"] or "Other",
            "intervalMonths": r["interval_months"] or 6,
            "lastVisit": r["last_visit"] or "", "nextDue": r["next_due"] or "",
            "status": "Pending" if r["status"] in LEGACY_STATUSES or not r["status"] else r["status"],
        }
        for r in rows(conn, "SELECT * FROM recalls")
    ]
    conn.close()

    max_id = max([0] + [x["id"] for x in patients + treatments + recalls])
    payload = {
        "app": "dental-patient-tracker",
        "version": 1,
        "exportedAt": datetime.now(timezone.utc).isoformat(),
        "data": {
            "nextId": max_id + 1,
            "patients": patients,
            "treatments": treatments,
            "recalls": recalls,
        },
    }
    target.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote {target}: {len(patients)} patients, {len(treatments)} treatments, {len(recalls)} recalls")


if __name__ == "__main__":
    main()
