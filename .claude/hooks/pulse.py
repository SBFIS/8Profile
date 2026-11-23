#!/usr/bin/env python3
"""Project Pulse auto-log hook for Claude Code.

SessionStart: remember which commit the session started on.
Stop: if this session has made commits that haven't been logged, ask Claude
to run the log-update skill before finishing. Throttled so it fires on the
first commit of a session, then again after 3 more commits or 40 minutes.
"""
import json, os, subprocess, sys, time

THROTTLE_COMMITS = 3
THROTTLE_SECONDS = 40 * 60


def git(*args):
    try:
        return subprocess.run(["git", *args], capture_output=True, text=True,
                              cwd=os.environ.get("CLAUDE_PROJECT_DIR", ".")).stdout.strip()
    except Exception:
        return ""


def main():
    event = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        data = json.load(sys.stdin)
    except Exception:
        data = {}
    sid = data.get("session_id", "default")
    state_dir = os.path.join(os.environ.get("TMPDIR", "/tmp"), "pulse")
    os.makedirs(state_dir, exist_ok=True)
    state_file = os.path.join(state_dir, f"{sid}.json")
    head = git("rev-parse", "HEAD")
    if not head:
        return

    if event == "start":
        with open(state_file, "w") as f:
            json.dump({"start": head, "logged": head, "logged_at": time.time(), "logs": 0}, f)
        return

    # Stop event
    if data.get("stop_hook_active"):
        return
    try:
        with open(state_file) as f:
            st = json.load(f)
    except Exception:
        # No start record (e.g. hook added mid-session): start from here.
        with open(state_file, "w") as f:
            json.dump({"start": head, "logged": head, "logged_at": time.time(), "logs": 0}, f)
        return

    if head == st["logged"]:
        return
    new = git("rev-list", "--count", f"{st['logged']}..{head}")
    try:
        new = int(new)
    except ValueError:
        new = 1
    if new == 0:
        return
    first = st.get("logs", 0) == 0
    if not (first or new >= THROTTLE_COMMITS or time.time() - st["logged_at"] >= THROTTLE_SECONDS):
        return

    try:
        cfg = json.load(open(os.path.join(os.environ.get("CLAUDE_PROJECT_DIR", "."), ".claude", "pulse.json")))
    except Exception:
        cfg = {}
    row = cfg.get("row", "this project")
    parent = cfg.get("part_of")
    target = f'Pulse row "{row}"' + (f' (part of "{parent}"; pick the specific app row from what changed)' if parent else "")
    if cfg.get("note"):
        target += f" ({cfg['note']})"

    st.update(logged=head, logged_at=time.time(), logs=st.get("logs", 0) + 1)
    with open(state_file, "w") as f:
        json.dump(st, f)

    reason = (
        f"Project Pulse: {new} commit(s) since the last log haven't been recorded. "
        f"Before finishing, use the log-update skill for {target}. Base 'what got done' on "
        f"`git log {st['start'][:7]}..HEAD --oneline` and what you verified this session. "
        "Write to the Project Pulse sheet. If the Google Sheets tools aren't available, append the entry "
        "to PULSE.md, commit and push it. Then end your reply with one line saying what you logged."
    )
    print(json.dumps({"decision": "block", "reason": reason}))


if __name__ == "__main__":
    main()
