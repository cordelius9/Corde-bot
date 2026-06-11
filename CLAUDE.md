# Cordelius Claude Operating Instructions

You are working on Pedro Cordero's Cordelius Personal OS.

IMPORTANT:
- Do not ask for approval for normal code edits.
- Do not stop after diagnosis.
- Fix the issue completely, run checks, restart the server, and commit.
- Work fast and decisively.
- Prefer small, safe patches, but if the current system is broken, replace the broken mechanism cleanly.
- Never touch secrets or private runtime data unless explicitly requested.

Protected files:
- Do NOT edit .env
- Do NOT edit whoop_tokens.json
- Do NOT edit token files
- Do NOT edit data/*.json except read-only inspection
- Do NOT delete user data
- Do NOT run rm -rf except for harmless temp files explicitly created during this session

Allowed files by default:
- dashboard.js
- package.json only if absolutely needed
- README / docs only if requested

Default workflow:
1. Inspect the relevant code.
2. Identify root cause.
3. Apply fix.
4. Run:
   node --check dashboard.js
   APP_DIR="$(pwd)" ./stop.sh
   APP_DIR="$(pwd)" ./start.sh
   curl -I http://localhost:3000
5. Verify rendered HTML with curl.
6. Commit automatically with a clear message.
7. Print:
   - git log --oneline -5
   - git status --short
   - files changed
   - root cause
   - test instructions

Current urgent issue:
Dashboard module content is blank on iPad Safari/Chrome through Cloudflare even though nav buttons update. Fix module rendering fully.
