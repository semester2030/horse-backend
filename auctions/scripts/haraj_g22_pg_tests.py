#!/usr/bin/env python3
"""Run Auction Core PG tests against staging. Never prints the URL."""

import json
import os
import re
import subprocess
import urllib.request
from pathlib import Path

ROOT = Path("/Users/fayez/Desktop/horse/backend/auctions")
EVIDENCE = Path(
    "/Users/fayez/Desktop/horse/delivery/NOMAS_HARAJ_G2.2_STAGING_MIGRATIONS_FINAL/evidence"
)


def url() -> str:
    text = Path.home().joinpath(".render/cli.yaml").read_text()
    token = re.search(r"(?im)key:\s*[\"']?(rnd_[A-Za-z0-9_\-\.]+)", text).group(1)
    req = urllib.request.Request(
        "https://api.render.com/v1/postgres/dpg-dabp4j6k1f9s7391dseg-a/connection-info"
    )
    req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=30) as resp:
        value = json.loads(resp.read().decode())["externalConnectionString"]
    if "dpg-dabp4j6k1f9s7391dseg-a" not in value or "nomas_auctions_staging" not in value:
        raise SystemExit("ABORT: test URL is not staging")
    if "dpg-da5fc18jo6nc73cd4930-a" in value:
        raise SystemExit("ABORT: production URL")
    if "ssl=" not in value and "sslmode=" not in value:
        value += ("&" if "?" in value else "?") + "ssl=true"
    return value


def main() -> None:
    env = os.environ.copy()
    env["APP_ENV"] = "staging"
    env["AUCTIONS_STAGING_DATABASE_URL"] = url()
    env["AUCTIONS_TEST_DATABASE_URL"] = env["AUCTIONS_STAGING_DATABASE_URL"]
    env["AUCTIONS_DATABASE_URL"] = env["AUCTIONS_STAGING_DATABASE_URL"]
    files = [
        "auction_core.test.js",
        "custom_bid.test.js",
        "auction_lifecycle_security.test.js",
        "auction_independence_integration.test.js",
        "auction_flow_remediation.test.js",
        "lifecycle_worker.test.js",
    ]
    summaries = []
    failed = 0
    for name in files:
        proc = subprocess.run(
            ["node", "--test", "--test-concurrency=1", name],
            cwd=str(ROOT),
            env=env,
            capture_output=True,
            text=True,
        )
        lines = (proc.stdout + proc.stderr).splitlines()
        info = [ln for ln in lines if ln.startswith("ℹ") or ln.startswith("✖")]
        summaries.append({"file": name, "exit": proc.returncode, "info": info[-8:]})
        if proc.returncode != 0:
            failed += 1
            summaries[-1]["tail"] = lines[-25:]
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    (EVIDENCE / "pg_tests_summary.json").write_text(json.dumps(summaries, indent=2) + "\n")
    print(json.dumps(summaries, indent=2))
    print("PG_TEST_FAILED_FILES", failed)
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
