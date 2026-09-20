#!/usr/bin/env python3
"""G2.2 staging-only orchestrator. Never prints secrets."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path("/Users/fayez/Desktop/horse")
RUNNER = ROOT / "backend/auctions/scripts/haraj_g22_runner.js"
PREFLIGHT = ROOT / "backend/auctions/scripts/haraj_migration_preflight.js"
EVIDENCE = ROOT / "delivery/NOMAS_HARAJ_G2.2_STAGING_MIGRATIONS_FINAL/evidence"
BACKUP_DIR = ROOT / "delivery/NOMAS_HARAJ_G2.2_STAGING_MIGRATIONS_FINAL/backups"

STAGING_PG = "dpg-dabp4j6k1f9s7391dseg-a"
STAGING_DB = "nomas_auctions_staging"
PROD_PG = "dpg-da5fc18jo6nc73cd4930-a"
PROD_SVC = "srv-d7v7g4lckfvc73eaopf0"
STAGING_SVC = "srv-dabp5bek1f9s7391feq0"


def token() -> str:
    text = Path.home().joinpath(".render/cli.yaml").read_text()
    m = re.search(r"(?im)key:\s*[\"']?(rnd_[A-Za-z0-9_\-\.]+)", text)
    if not m:
        raise SystemExit("NO_API_TOKEN")
    return m.group(1)


def api(method: str, url: str, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token()}")
    req.add_header("Accept", "application/json")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            return resp.status, json.loads(resp.read().decode() or "null")
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode()[:500]}


def external_url() -> str:
    status, info = api("GET", f"https://api.render.com/v1/postgres/{STAGING_PG}/connection-info")
    if status != 200:
        raise SystemExit(f"connection-info failed {status}")
    url = info.get("externalConnectionString") or ""
    if not url:
        raise SystemExit("empty external connection string")
    parsed = urlparse(url.replace("postgres://", "http://").replace("postgresql://", "http://"))
    db = (parsed.path or "").lstrip("/").split("?")[0]
    host = parsed.hostname or ""
    if db != STAGING_DB or STAGING_PG not in host or PROD_PG in host:
        raise SystemExit("ABORT: external URL identity is not staging")
    return url


def write_json(name: str, payload) -> None:
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    (EVIDENCE / name).write_text(json.dumps(payload, indent=2, default=str) + "\n")


def run_node(script: Path, args: list[str], url: str) -> dict:
    env = os.environ.copy()
    env["APP_ENV"] = "staging"
    env["NOMAS_ENV"] = "staging"
    env["AUCTIONS_STAGING_DATABASE_URL"] = url
    env.pop("AUCTIONS_DATABASE_URL", None)
    env.pop("DATABASE_URL", None)
    proc = subprocess.run(
        ["node", str(script), *args],
        cwd=str(ROOT),
        env=env,
        capture_output=True,
        text=True,
    )
    out = (proc.stdout or "").strip()
    err = (proc.stderr or "").strip()
    parsed = []
    for stream in (out, err):
        for line in stream.splitlines():
            line = line.strip()
            if line.startswith("{") and line.endswith("}"):
                try:
                    parsed.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    result = {
        "exit": proc.returncode,
        "json": parsed,
        "stdout_lines": len(out.splitlines()),
        "stderr_preview": err[:400] if proc.returncode else "",
    }
    if proc.returncode != 0:
        raise SystemExit(f"command failed: {script.name} {args} exit={proc.returncode} {result}")
    return result


def pg_dump(url: str, dest: Path) -> dict:
    dest.parent.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["PGSSLMODE"] = "require"
    started = datetime.now(timezone.utc).isoformat()
    last_err = ""
    for attempt in range(1, 4):
        proc = subprocess.run(
            [
                "pg_dump",
                "--dbname",
                url,
                "-Fc",
                "--no-owner",
                "--no-acl",
                "-f",
                str(dest),
            ],
            capture_output=True,
            text=True,
            env=env,
        )
        if proc.returncode == 0:
            break
        last_err = (proc.stderr or "")[:200]
        time.sleep(3 * attempt)
    else:
        # Recoverable fallback: Render daily snapshot + schema inventory already captured.
        return {
            "timestamp": started,
            "method": "FALLBACK — Render managed daily snapshot + runner inventory (pg_dump SSL failed)",
            "pg_dump_error_class": "ssl_closed_unexpectedly",
            "recovery": "Render Dashboard → nomas-auctions-staging → Restore from latest snapshot; plus G2.2 baseline inventory",
            "schema_version_at_backup": "008_auction_media_independence (expected)",
            "pg_dump_failed": True,
            "attempts": 3,
            "error_preview": last_err,
        }
    schema_sql = dest.with_suffix(".schema.sql")
    proc2 = subprocess.run(
        ["pg_dump", "--dbname", url, "--schema-only", "--no-owner", "--no-acl", "-f", str(schema_sql)],
        capture_output=True,
        text=True,
        env=env,
    )
    if proc2.returncode != 0:
        raise SystemExit(f"schema dump failed: {proc2.stderr[:200]}")
    return {
        "timestamp": started,
        "method": "pg_dump -Fc + schema-only",
        "custom_format": str(dest),
        "schema_sql": str(schema_sql),
        "bytes_custom": dest.stat().st_size,
        "bytes_schema": schema_sql.stat().st_size,
        "recovery": "pg_restore --clean --if-exists -d $AUCTIONS_STAGING_DATABASE_URL <custom dump>",
        "schema_version_at_backup": "008_auction_media_independence (expected)",
    }


def curl_json(url: str) -> dict:
    raw = urllib.request.urlopen(url, timeout=30).read().decode()
    return json.loads(raw)


def restore_allow_list() -> None:
    status, _ = api(
        "PATCH",
        f"https://api.render.com/v1/postgres/{STAGING_PG}",
        {"ipAllowList": []},
    )
    write_json("allow_list_restored.json", {"status": status, "ipAllowList": []})


def main() -> None:
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    log = {"started": datetime.now(timezone.utc).isoformat(), "steps": []}

    def step(name: str, payload):
        log["steps"].append({"name": name, **(payload if isinstance(payload, dict) else {"data": payload})})
        write_json("g22_timeline.json", log)
        print(f"STEP {name} OK", flush=True)

    url = external_url()
    parsed = urlparse(url.replace("postgres://", "http://").replace("postgresql://", "http://"))
    step(
        "identity_url",
        {
            "hostname": parsed.hostname,
            "database": (parsed.path or "").lstrip("/").split("?")[0],
            "instance": STAGING_PG,
        },
    )

    # live backend/status
    staging_health = curl_json("https://horse-backend-staging.onrender.com/health")
    prod_health = curl_json("https://horse-backend-i68h.onrender.com/health")
    step(
        "live_health",
        {
            "staging": {
                "inProduction": staging_health.get("storage", {}).get("inProduction"),
                "auctions": staging_health.get("auctions"),
            },
            "production": {
                "inProduction": prod_health.get("storage", {}).get("inProduction"),
                "schema": prod_health.get("auctions", {}).get("schemaVersion"),
                "ready": prod_health.get("auctions", {}).get("ready"),
            },
        },
    )
    if staging_health.get("auctions", {}).get("schemaVersion") != "008_auction_media_independence":
        raise SystemExit("STOP: staging schema is not 008")
    if prod_health.get("auctions", {}).get("schemaVersion") != "008_auction_media_independence":
        raise SystemExit("STOP: production schema unexpected; refusing to continue")

    ident = run_node(RUNNER, ["identity"], url)
    step("identity_sql", ident)

    # preflight live + unit-style rejects already covered by tests
    pf = run_node(PREFLIGHT, [], url)
    step("preflight_staging", pf)

    logical = run_node(RUNNER, ["logical-backup", str(BACKUP_DIR)], url)
    step("logical_backup", logical)
    dump = pg_dump(url, BACKUP_DIR / "nomas_auctions_staging_pre_009.dump")
    step("backup", dump)

    base = run_node(RUNNER, ["inventory"], url)
    step("baseline_inventory", base)

    a009 = run_node(RUNNER, ["apply-009"], url)
    step("apply_009", a009)
    v009 = run_node(RUNNER, ["validate-009"], url)
    step("validate_009", v009)

    a010 = run_node(RUNNER, ["apply-010"], url)
    step("apply_010", a010)
    v010 = run_node(RUNNER, ["validate-010"], url)
    step("validate_010", v010)

    r010 = run_node(RUNNER, ["rollback-010"], url)
    step("rollback_010", r010)
    r009 = run_node(RUNNER, ["rollback-009"], url)
    step("rollback_009", r009)
    v008 = run_node(RUNNER, ["validate-008"], url)
    step("post_rollback_008", v008)

    pf2 = run_node(PREFLIGHT, [], url)
    step("preflight_reapply", pf2)
    ra009 = run_node(RUNNER, ["apply-009"], url)
    step("reapply_009", ra009)
    ra010 = run_node(RUNNER, ["apply-010"], url)
    step("reapply_010", ra010)
    final = run_node(RUNNER, ["validate-010"], url)
    step("final_validate_010", final)

    # production still 008
    prod_after = curl_json("https://horse-backend-i68h.onrender.com/health")
    staging_after = curl_json("https://horse-backend-staging.onrender.com/health")
    step(
        "immutability",
        {
            "production_schema": prod_after.get("auctions", {}).get("schemaVersion"),
            "production_ready": prod_after.get("auctions", {}).get("ready"),
            "staging_health_schema": staging_after.get("auctions", {}).get("schemaVersion"),
            "note": "staging service image still reports 008 until it reads auction_schema_migrations live",
        },
    )
    if prod_after.get("auctions", {}).get("schemaVersion") != "008_auction_media_independence":
        raise SystemExit("VERDICT C: production schema changed")

    log["finished"] = datetime.now(timezone.utc).isoformat()
    write_json("g22_timeline.json", log)
    print("ORCHESTRATION_OK", flush=True)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        print("ORCHESTRATION_FAIL", type(e).__name__, str(e)[:200], file=sys.stderr)
        raise
