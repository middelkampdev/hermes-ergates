"""One process of the two-process reminder race in test_reminders.py.

    python tests/reminder_race_worker.py <store file> <cron file> <go file>

Waits until <go file> exists, sends one reminder request with a fixed
request id, and prints the outcome as JSON. The cron is a JSON-lines file
that both processes share, guarded by flock, with a slow create so the two
requests overlap. pytest does not collect this file (no test_ prefix).
"""

from __future__ import annotations

import dataclasses
import fcntl
import json
import sys
import time
from pathlib import Path

from ergates.reminders import ReminderService
from ergates.store import ControlStore


class FileCron:
    def __init__(self, path: Path) -> None:
        self.path = path

    def _jobs(self) -> list[dict]:
        if not self.path.exists():
            return []
        return [json.loads(line) for line in self.path.read_text(encoding="utf-8").splitlines()]

    def create_job(self, profile, *, schedule, prompt, name):
        time.sleep(0.2)
        with open(self.path, "a+", encoding="utf-8") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            handle.seek(0)
            job = {"id": f"job-{len(handle.readlines()) + 1}", "profile": profile, "name": name}
            handle.write(json.dumps(job) + "\n")
        return {"id": job["id"]}

    def get_job(self, profile, job_id):
        return next((job for job in self._jobs() if job["id"] == job_id), None)

    def find_job_ids_by_name(self, profile, name):
        return [job["id"] for job in self._jobs() if job["profile"] == profile and job["name"] == name]


def main() -> None:
    store_file, cron_file, go_file = (Path(arg) for arg in sys.argv[1:4])
    service = ReminderService(ControlStore(store_file), FileCron(cron_file))
    while not go_file.exists():
        time.sleep(0.001)
    outcome = service.create(
        "thijs", "0 9 * * *", "Europe/Amsterdam", "Check invoices.", request_id="outbox-7",
    )
    print(json.dumps(dataclasses.asdict(outcome)))


if __name__ == "__main__":
    main()
