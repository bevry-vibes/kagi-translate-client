# kagi-translate-client

API client for [Kagi Translate](https://translate.kagi.com): translate text, detect languages, look up dictionary entries, and translate the text of web pages — as Markdown or JSON, using your own Kagi session.

## Install

```sh
pip install .
# or run directly: python3 kagi_translate.py ...
```

## Usage

```sh
# usage/credit state (no auth needed)
kagi-translate credits

# everything below needs your session cookie
export KAGI_SESSION="<your kagi_session cookie>"

kagi-translate translate "Hola mundo" --from es --to en
echo "<long text>" | kagi-translate translate - --to en   # stdin works for long text
kagi-translate translate "Bonjour" --format json
kagi-translate detect "Bonjour le monde"
kagi-translate dictionary serendipity --verbosity comprehensive
kagi-translate website example.com --to en          # fetch, extract, translate the page text
```

`KAGI_SESSION` is read from the environment only — never stored, never committed. Keep it in your shell profile or a `.env` file (`.env` is gitignored). The cookie value is the `kagi_session` cookie of `translate.kagi.com` (browser devtools, Application, Cookies).

## Feature notes

- `translate` streams by default and prints the translation as it arrives; `--no-stream` fetches one response. `--formality`, `--style`, `--language-complexity`, `--speaker-gender`, `--addressee-gender`, `--context` and `--preserve-formatting` map onto the web app's translation settings.
- `dictionary` renders pronunciation, meanings, synonyms, examples, etymology and related words; `--quality`, `--verbosity` and `--synonym-strategy` map onto the web app's dictionary settings.
- `website` fetches the original page, extracts its block text and batch-translates it; `--quality fast|standard|best` selects the engine tier.
- Proofread, document, OCR/audio and speech endpoints exist in the web app but are not covered yet.

## API endpoints used

Discovered against `translate.kagi.com` (2026-09-22). Kagi Translate has no public API; these are the web app's own endpoints. Authentication is the session cookie; requests also carry the app's `X-Signing-Fail` fallback header, and the server does not enforce its optional WASM request signing for cookie-authenticated calls.

| Endpoint | Auth | Notes |
|---|---|---|
| `GET /api/credit/status` | no | credit/allowance state; anonymous shows `canSpend: false` |
| `POST /api/translate` | yes | JSON payload; `stream: true` returns SSE with `delta` events ending in `done: true` |
| `POST /api/detect` | yes | `{text, include_alternatives}` → `{iso, label, isUncertain, isMixed}` |
| `POST /api/dictionary` | yes | SSE with `definition_field` events (`word`, `primary_meaning`, `examples`, `pronunciation`, `etymology`, `notes`, `related_words`) |
| `POST /api/translate/website` | yes | `{source_lang, target_lang, text: [blocks], model, skip_definition}` → `{snippets: [...]}` |

<!-- LICENSE/ -->

## License

Unless stated otherwise all works are:

- Copyright &copy; [Benjamin Lupton](https://balupton.com)

and licensed under:

- [Reciprocal Public License 1.5](http://spdx.org/licenses/RPL-1.5.html)

<!-- /LICENSE -->
