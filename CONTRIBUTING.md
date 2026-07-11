# Contributing to simple-multi-snake

Thanks for considering a contribution. This is a small project and the process is intentionally lightweight.

## How to report a bug

Open an issue using the Bug report template. Please include:
- The version of this project you are running (commit SHA or release tag)
- The exact command or workflow that triggered the issue
- The full error output (redact any secrets, credentials, or personal data)
- Relevant log excerpts
- Your runtime environment (OS, Node.js version, deployment target, etc.)

## How to propose a feature

Open an issue using the Feature request template. Describe the use case before the implementation. Knowing why is more useful than what in early discussion.

## How to submit a change

- Fork the repo and create a feature branch (git checkout -b feat/short-description).
- Make your change. Keep changes focused, one logical change per PR.
- Test it. To verify locally, from the repo root run: npm install, then node server.js, then open http://127.0.0.1:8080 in a browser and confirm a snake spawns and moves, food is eaten, and the score updates. Open a second browser session to confirm a second player slot fills, and a fifth session to confirm the spectator queue.
- Lint it. Run any project-specific formatters before pushing.
- Update documentation. If your change alters user-visible behavior, update README.md and add a new numbered entry to CHANGELOG.md under the current round.
- Open a PR against main. Fill in the PR template.

## Coding conventions

- Follow the style of the surrounding code. Match formatting, naming, and structure of existing files.
- Comments should explain why, not what. The diff already shows what.
- No new dependencies without strong justification. The appeal of small projects is the small, predictable surface area.
- No telemetry, ever. This project must not phone home.

## Commit messages

Conventional Commits style is preferred but not required:

    feat: add support for X
    fix: handle empty response from Y
    docs: clarify setup for Z

Keep the subject under 72 characters. Add a body if the change is not obvious from the diff.

## Releases

Maintainers cut releases by tagging vX.Y.Z on main. Pre-1.0 versioning rules:
- 0.X.0 for any user-visible change
- 0.X.Y for bug-fix-only patch releases

After 1.0, standard SemVer applies.
