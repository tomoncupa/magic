# Working on this repo

- Work on `main` in this folder and push straight to `main`. No side branches, no pull requests (Tom, 2026-10-18: "Why do we have to merge so much?"). Claude Code's auto mode refuses `gh pr merge`, so every PR waited on Tom.
- If the session was started in a worktree on a side branch, finish there, then bring it onto `main` here (`git merge`, fast-forward when it can) and push `main`.
- `git pull --ff-only origin main` before starting: the nightly jobs commit combos.json and decks/ on their own.
- Verify before pushing (syntax check, click-test on real inputs where possible): a push to main goes live.
