# Plan: scaffold kagi-translate-client

Assisted-by: ZCode · GLM 5.3 Flash <zcode-zcode-glm53flash@local>

Provenance: [1790049610662-kagi-translate-client-scaffold.prompts.md](./1790049610662-kagi-translate-client-scaffold.prompts.md)

Date: 2026-09-22

## Goal

Create `/home/balupton/Projects/vibes/kagi-translate-client` in the same spirit as `bevry-vibes/kagi-assistant-client`: a single-file, stdlib-only Python CLI that talks to Kagi Translate using the user's own `kagi_session` cookie. Scaffolded per `bevry-vibes/skills` conventions.

## Research findings

- Kagi Translate has no public API (only Search/Summarize/Enrichment/FastGPT have official APIs). The web app is a SvelteKit SPA at `translate.kagi.com` with modes: Text, Proofread, Dictionary, Document, Website.
- Documented URL-parameter surface (`help.kagi.com/kagi/translate/url-parameters.html`): translation takes `from` (auto or code), `to`, `quality` (standard|best), `style` (natural|literal), `formality`, `language_complexity`, `speaker_gender`, `addressee_gender`, `context`, `preserveFormatting`. Dictionary takes `word`, `quality`, `verbosity`, `synonym_strategy`, `context`. Text input limit about 20,000 characters; free Kagi account required for AI features.
- The internal JSON endpoints the SPA calls are not documented. They will be discovered live: first by grepping the app's JS bundles (works without login), then confirmed by watching network traffic in the user's logged-in browser.
- `kagi-assistant-client` pattern: single `kagi_assistant.py` module (urllib/argparse/json only), `pyproject.toml` with setuptools and a console script, bevry/base configs, RPL-1.5 LICENSE, canonical AGENTS.md, auth = `KAGI_SESSION` env var holding the `kagi_session` cookie, `--format md|json` output.

## Scope (user decisions)

- Launch: Text translation and Dictionary subcommands.
- Proofread / Document / Website: recorded in README as future work, not implemented now.
- Session capture: browser-use login flow — the agent opens a browser at translate.kagi.com, the user logs in, the agent captures the cookie and observes API traffic.

## Steps

1. Scaffold per bevry-vibes/skills (license.md + conventions.md): git init; check `git user.name` is Benjamin Lupton; pull bevry/base `.editorconfig`, `.gitattributes`, `.gitignore`, `LICENSE.md`; write README.md (purpose, install, auth, usage, endpoint table with discovery date, future-features note, LICENSE segment); write AGENTS.md in the canonical skills-pointer shape (reference remote policy.md, commits.md, plans.md, minimax.md — never copy contents); record this plan in `.plans/`; initial commit `chore: initialise with bevry base configs and RPL-1.5 license` with the agent-detect Co-authored-by trailer.
2. API discovery, unauthenticated pass: fetch translate.kagi.com HTML, list `_app/immutable` JS bundles, download and grep for API paths (`/api/`), request param names, streaming hints. Record the inventory in the `.plans/` notes.
3. API discovery, authenticated pass: open translate.kagi.com in the browser-use automation browser; user logs in; capture the `kagi_session` cookie and observe real requests for one Text translation and one Dictionary lookup: method, path, headers, body shape, response format (likely SSE), and whether the same cookie works as on kagi.com. The cookie is used only via env var for testing in the session; never written to any repo file.
4. Implement `kagi_translate.py` and `pyproject.toml`: stdlib-only module mirroring the assistant client's structure (`API` base, branded `User-Agent`, `_request` helper, 401 message, `--format {md,json}`). Subcommands: `translate <text>` (`--from auto`, `--to`, `--quality standard|best`, `--style`, `--formality`, `--language-complexity`, `--speaker-gender`, `--addressee-gender`, `--context`, `--preserve-formatting`) and `dictionary <word>` (`--quality`, `--verbosity`, `--synonym-strategy`, `--context`). Streaming responses rendered progressively to stdout in md mode, full JSON in json mode. pyproject.toml: setuptools>=61, name `kagi-translate-client`, version 0.1.0, RPL-1.5, author Benjamin Lupton, console script `kagi-translate = kagi_translate:main`.
5. Test and commit: run the CLI against the live service with the session in the env var (translations and a dictionary lookup in both output formats); verify the pip-installed entry point; `git grep` for credential leakage; commit `feat: kagi translate api client and CLI` and `docs: add README with usage and endpoint table, AGENTS.md with remote skill references`.

## Notes

- Respectful use: personal-account client for the user's own session, no bulk scraping, modest politeness delays — same spirit as the assistant client.
- Endpoints are internal and can change; the README documents them with a discovery date, as the assistant client does.
- Language and runtime follow the assistant client deliberately: Python 3.9+, stdlib only, zero runtime dependencies.

## Provenance deviation note

plans.md requires committing the plan before each plan-mode exit. This plan was approved before the repository existed, so the plan record lands in the initial scaffold commit instead.
