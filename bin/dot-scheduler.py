#!/usr/bin/env python3
"""dot-scheduler — self-service scheduled turns for the gentle-dot agent.

Host cron runs this every minute (see DEPLOY.md). The agent manages jobs by
writing JSON files into its own volume at /home/dot/scheduler/*.job (host:
/var/lib/docker/volumes/gentle-dot_dot-home/_data/scheduler). When a job is
due, its prompt is injected as a conversation turn via bin/dot-say.sh.

Job file schema (agent-writable, all fields required unless noted):
{
  "name": "resumen-semanal-gsc",          # short id, unique per file
  "enabled": true,                         # optional, default true
  "schedule": {
    "type": "weekly",                      # every | daily | weekly | once
    "day": "MON",                          # weekly only: MON..SUN
    "time": "09:00",                       # daily/weekly only, local time
    "minutes": 30,                         # every only: >= 5
    "at": "2026-11-23T00:05"               # once only, local time
  },
  "prompt": "...",                          # what the agent should do
  "timeout_min": 15,                       # optional, default 15
  "last_run_epoch": 0,                     # managed by the scheduler
  "attempts": 0,                           # managed by the scheduler
  "last_error": null,                      # managed by the scheduler
  "last_result": null                      # managed by the scheduler
}

Local host time is used (Europe/Berlin == Spain clock). Files are rewritten
preserving uid 1001 (dot) so the agent keeps editing its own jobs.
Exit codes: 0 ran (or nothing due) · 1 scheduler-level failure.
"""

from __future__ import annotations
import fcntl
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

JOB_DIR = Path("/var/lib/docker/volumes/gentle-dot_dot-home/_data/scheduler")
DOT_SAY = "/root/containers/gentle-dot/bin/dot-say.sh"
LOG_FILE = Path("/var/log/dot-scheduler.log")
LOCK_FILE = "/run/dot-scheduler.lock"
MAX_LOG_BYTES = 1_000_000
MAX_JOBS = 50
MIN_EVERY_MINUTES = 5
MAX_PROMPT_CHARS = 8000
DEFAULT_TIMEOUT_MIN = 15
MAX_ATTEMPTS = 3
WEEKDAYS = {"MON": 0, "TUE": 1, "WED": 2, "THU": 3, "FRI": 4, "SAT": 5, "SUN": 6}


def log(msg: str) -> None:
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    if LOG_FILE.exists() and LOG_FILE.stat().st_size > MAX_LOG_BYTES:
        keep = LOG_FILE.read_text(errors="replace").splitlines()[-500:]
        LOG_FILE.write_text("\n".join(keep) + "\n")
    with LOG_FILE.open("a") as fh:
        fh.write(f"{datetime.now().isoformat(timespec='seconds')} {msg}\n")


def parse_local(value: str, what: str) -> datetime:
    # Accepts "YYYY-MM-DDTHH:MM[:SS]" (local time) and full ISO 8601 with a
    # UTC "Z" or numeric offset (converted to local), so agent-written jobs
    # with ISO stamps are not silently skipped as malformed.
    v = str(value).strip()
    for fmt in ("%Y-%m-%dT%H:%M", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(v, fmt)
        except ValueError:
            pass
    try:
        iso = v[:-1] + "+00:00" if v.endswith(("Z", "z")) else v
        parsed = datetime.fromisoformat(iso)
    except ValueError:
        raise JobError(
            f"invalid {what} {value!r}: expected YYYY-MM-DDTHH:MM[:SS] local time "
            "or ISO 8601 with UTC/offset"
        )
    if parsed.tzinfo is None:
        return parsed
    return parsed.astimezone()


def parse_hhmm(value: str, what: str) -> tuple[int, int]:
    try:
        hh, mm = value.split(":")
        hh, mm = int(hh), int(mm)
        if not (0 <= hh < 24 and 0 <= mm < 60):
            raise ValueError
        return hh, mm
    except (ValueError, AttributeError):
        raise JobError(f"invalid {what} {value!r}: expected HH:MM")


class JobError(Exception):
    pass


def validate(job: dict) -> None:
    if not isinstance(job.get("name"), str) or not job["name"].strip():
        raise JobError("missing name")
    prompt = job.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise JobError("missing prompt")
    if len(prompt) > MAX_PROMPT_CHARS:
        raise JobError(f"prompt longer than {MAX_PROMPT_CHARS} chars")
    sch = job.get("schedule")
    if not isinstance(sch, dict):
        raise JobError("missing schedule")
    stype = sch.get("type")
    if stype == "every":
        minutes = sch.get("minutes")
        if not isinstance(minutes, (int, float)) or minutes < MIN_EVERY_MINUTES:
            raise JobError(f"'every' needs minutes >= {MIN_EVERY_MINUTES}")
    elif stype == "daily":
        parse_hhmm(sch.get("time", ""), "daily time")
    elif stype == "weekly":
        if str(sch.get("day", "")).upper() not in WEEKDAYS:
            raise JobError("weekly needs day MON..SUN")
        parse_hhmm(sch.get("time", ""), "weekly time")
    elif stype == "once":
        parse_local(str(sch.get("at", "")), "once at")
    else:
        raise JobError(f"unknown schedule type {stype!r} (every|daily|weekly|once)")


def is_due(job: dict, now: datetime) -> bool:
    sch = job["schedule"]
    last = float(job.get("last_run_epoch") or 0)
    stype = sch["type"]
    if stype == "every":
        return (time.time() - last) >= float(sch["minutes"]) * 60
    if stype == "daily":
        hh, mm = parse_hhmm(sch["time"], "daily time")
        due_at = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
        return now >= due_at and last < due_at.timestamp()
    if stype == "weekly":
        hh, mm = parse_hhmm(sch["time"], "weekly time")
        due_day = WEEKDAYS[str(sch["day"]).upper()]
        days_ahead = (due_day - now.weekday()) % 7
        due_at = (now + timedelta(days=days_ahead)).replace(hour=hh, minute=mm, second=0, microsecond=0)
        if due_at > now:  # this week's slot not reached yet
            due_at -= timedelta(days=7)
        return now >= due_at and last < due_at.timestamp()
    if stype == "once":
        return last == 0 and now >= parse_local(str(sch["at"]), "once at")
    return False


def save_job(path: Path, job: dict) -> None:
    tmp = path.with_suffix(".job.tmp")
    tmp.write_text(json.dumps(job, ensure_ascii=False, indent=2) + "\n")
    os.chmod(tmp, 0o644)
    os.chown(tmp, 1001, 1001)
    os.replace(tmp, path)


def fire(job: dict) -> tuple[int, str]:
    timeout = int(job.get("timeout_min") or DEFAULT_TIMEOUT_MIN)
    try:
        proc = subprocess.run(
            [DOT_SAY, job["prompt"], str(timeout)],
            capture_output=True, text=True, timeout=timeout * 60 + 60,
        )
        reply = (proc.stdout or "").strip()
        err = (proc.stderr or "").strip()
        detail = err if err else reply
        return proc.returncode, detail[:500]
    except subprocess.TimeoutExpired:
        return 1, "dot-say timed out"


def main() -> int:
    lock_fh = open(LOCK_FILE, "w")
    try:
        fcntl.flock(lock_fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return 0  # a previous run is still working
    with lock_fh:
        if not JOB_DIR.is_dir():
            log(f"job dir missing: {JOB_DIR} (nothing to do)")
            return 0
        jobs = sorted(JOB_DIR.glob("*.job"))
        if len(jobs) > MAX_JOBS:
            log(f"warning: {len(jobs)} jobs (cap {MAX_JOBS}) — check for runaway job creation")
        now = datetime.now()
        for path in jobs:
            try:
                job = json.loads(path.read_text())
                validate(job)
            except Exception as e:
                log(f"SKIP {path.name}: malformed job ({e})")
                continue
            if not job.get("enabled", True):
                continue
            if not is_due(job, now):
                continue
            code, detail = fire(job)
            name = job.get("name", path.stem)
            if code == 0:
                job["last_run_epoch"] = time.time()
                job["attempts"] = 0
                job["last_error"] = None
                job["last_result"] = detail or "(empty reply)"
                log(f"FIRED {name}: ok — {detail[:200]!r}")
            else:
                job["attempts"] = int(job.get("attempts") or 0) + 1
                job["last_error"] = f"exit {code}: {detail}"
                if job["attempts"] >= MAX_ATTEMPTS:
                    job["last_run_epoch"] = time.time()  # give up this window
                    log(f"FAILED {name}: giving up after {MAX_ATTEMPTS} attempts — {detail[:200]!r}")
                else:
                    log(f"RETRY-QUEUED {name}: attempt {job['attempts']}/{MAX_ATTEMPTS} — {detail[:200]!r}")
            try:
                save_job(path, job)
            except Exception as e:
                log(f"ERROR writing {path.name}: {e}")
        return 0


if __name__ == "__main__":
    sys.exit(main())
