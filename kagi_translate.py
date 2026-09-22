#!/usr/bin/env python3
"""kagi-translate — API client for Kagi Translate (translate.kagi.com).

Endpoints (discovered 2026-09-22 against translate.kagi.com):

- POST /api/translate          text translation (auth); SSE stream by default
- POST /api/detect             language detection (auth)
- POST /api/dictionary         dictionary lookup (auth); SSE stream
- POST /api/translate/website  batch translation of page text (auth)
- GET  /api/credit/status      usage/credit state (no auth)

Authentication: the KAGI_SESSION environment variable (your `kagi_session`
cookie from translate.kagi.com). Everything except the credit check needs
it — the browser's anonymous website-translation flow relies on an
invisible Cloudflare Turnstile challenge that no CLI can solve.
The value is read from the environment only — never stored, never committed.

Usage:
    kagi-translate translate <text> [--from auto] [--to en] [options]
    kagi-translate detect <text>
    kagi-translate dictionary <word> [options]
    kagi-translate website <url> [--to en] [--quality fast]
    kagi-translate credits
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

SITE = "https://translate.kagi.com"
USER_AGENT = "kagi-translate-client/0.1 (+https://github.com/bevry-vibes/kagi-translate-client)"
# The app's own fallback when its signing module did not initialise; the
# server accepts it in place of the signed-request headers.
SIGNING_FAIL = base64.b64encode(b"no_init_started").decode()


def get_session(required: bool) -> str | None:
    raw = os.environ.get("KAGI_SESSION", "").strip()
    if raw.startswith("kagi_session="):
        raw = raw.split("=", 1)[1].strip()
    if required and not raw:
        sys.exit(
            "error: KAGI_SESSION environment variable is required for this command.\n"
            "Set it to your kagi_session cookie value from translate.kagi.com\n"
            "(browser devtools, Application, Cookies)."
        )
    return raw or None


def _headers(session: str | None, content: bool = False) -> dict:
    headers = {
        "User-Agent": USER_AGENT,
        "X-Signing-Fail": SIGNING_FAIL,
        **({"Cookie": f"kagi_session={session}"} if session else {}),
    }
    if content:
        headers["Content-Type"] = "application/json"
    return headers


def _open(request: urllib.request.Request, path: str):
    try:
        return urllib.request.urlopen(request, timeout=120)
    except urllib.error.HTTPError as e:
        body = e.read()[:200]
        if e.code == 401:
            sys.exit(
                "error: not_authenticated — set the KAGI_SESSION environment variable "
                "to your kagi_session cookie from translate.kagi.com."
            )
        if e.code == 429:
            sys.exit("error: rate_limited — the monthly allowance or per-minute limit is spent; try again later.")
        sys.exit(f"error: HTTP {e.code} for {path}: {body!r}")
    except (urllib.error.URLError, OSError) as e:
        sys.exit(f"error: cannot reach {path}: {e}")


def _post_json(path: str, payload: dict, session: str | None, stream: bool):
    req = urllib.request.Request(
        f"{SITE}{path}",
        data=json.dumps(payload).encode(),
        headers=_headers(session, content=True),
        method="POST",
    )
    res = _open(req, path)
    ctype = res.headers.get("Content-Type", "")
    if stream and "event-stream" in ctype:
        return res, True
    return json.load(res), False


def _sse_events(res):
    """Yield one parsed JSON object per `data:` line of an SSE response."""
    for raw in res:
        line = raw.decode("utf-8", "replace").strip()
        if line.startswith("data:"):
            chunk = line[5:].strip()
            if chunk:
                try:
                    yield json.loads(chunk)
                except json.JSONDecodeError:
                    pass


def _read_text_arg(value: str) -> str:
    if value == "-":
        return sys.stdin.read()
    return value


def _exit_on_error_event(event: dict) -> None:
    if "error" in event:
        detail = event.get("message") or event["error"]
        sys.exit(f"error: {event['error']} — {detail}")


# translate


def translate(payload: dict, session: str | None, output: str) -> None:
    data, streaming = _post_json("/api/translate", payload, session, stream=True)
    if not streaming:
        _print_translation(data, output)
        return
    detected = None
    parts: list[str] = []
    header_done = False
    for event in _sse_events(data):
        _exit_on_error_event(event)
        if "detected_language" in event:
            detected = event["detected_language"]
        elif "delta" in event:
            if output == "md":
                if not header_done:
                    print(f"[{(detected or {}).get('iso', payload.get('from', 'auto'))} -> {payload.get('to', 'en')}]\n")
                    header_done = True
                    sys.stdout.flush()
                print(event["delta"], end="")
                sys.stdout.flush()
            parts.append(event["delta"])
        elif event.get("done"):
            break
    if output == "md":
        if header_done:
            print()
        else:
            _print_translation({"translation": "".join(parts), "detected_language": detected}, output)
    else:
        print(json.dumps({"translation": "".join(parts), "detected_language": detected}, indent=2, ensure_ascii=False))


def _print_translation(data: dict, output: str) -> None:
    if output == "json":
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return
    detected = data.get("detected_language") or {}
    print(f"[{detected.get('iso', '?')} -> ]\n{data.get('translation', '')}")


# detect


def detect(payload: dict, session: str | None, output: str) -> None:
    data, _ = _post_json("/api/detect", payload, session, stream=False)
    if output == "json":
        print(json.dumps(data, indent=2, ensure_ascii=False))
    else:
        print(f"{data.get('label', '?')} ({data.get('iso', '?')})")


# dictionary


def dictionary(payload: dict, session: str | None, output: str) -> None:
    data, streaming = _post_json("/api/dictionary", payload, session, stream=True)
    if not streaming:
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return
    fields: dict[str, object] = {}
    attribution = None
    for event in _sse_events(data):
        _exit_on_error_event(event)
        if "definition_field" in event:
            field = event["definition_field"]
            fields[field.get("field", "?")] = field.get("value")
            if output == "md":
                _print_dictionary_field(field.get("field", "?"), field.get("value"), header=(field.get("field") == "word"))
                sys.stdout.flush()
        elif "attribution" in event:
            attribution = event["attribution"]
        elif event.get("done"):
            break
    if output == "json":
        print(json.dumps({"fields": fields, "attribution": attribution}, indent=2, ensure_ascii=False))
    elif attribution:
        kind = {"ai_generated": "AI-generated"}.get(attribution.get("type", ""), attribution.get("type", "unknown"))
        extra = " (Wiktionary used)" if attribution.get("wiktionary_used") else ""
        print(f"\n---\nSource: {kind}{extra}")


def _print_dictionary_field(field: str, value: object, header: bool = False) -> None:
    if field == "word":
        print(f"# {value}")
        return
    if field == "primary_meaning" and isinstance(value, dict):
        pos = ", ".join(value.get("part_of_speech", []))
        level = ", ".join(value.get("usage_level", []))
        label = "primary meaning" + (f" ({pos}" + (f"; {level}" if level else "") + ")" if pos else "")
        print(f"\n## {label}\n\n{value.get('definition', '')}")
        synonyms = value.get("synonyms", [])
        if synonyms:
            print(f"\nSynonyms: {', '.join(synonyms)}")
        for comparison in value.get("synonym_comparisons", []):
            print(f"- {comparison.get('synonym', '?')}: {comparison.get('difference', '')}")
        return
    if field == "examples" and isinstance(value, list):
        print("\n## examples")
        for example in value:
            print(f"- {example}")
        return
    if field == "related_words" and isinstance(value, list):
        print("\n## related words")
        for related in value:
            print(f"- {related.get('word', '?')} ({related.get('relationship', '?')})")
        return
    if isinstance(value, str):
        print(f"\n## {field.replace('_', ' ')}\n\n{value}")


# website


_BLOCK_TAGS = ("p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "pre", "td", "th", "figcaption", "dt", "dd")


class _TextExtractor(HTMLParser):
    """Collect the page title and one text chunk per block element."""

    skipped = ("script", "style", "noscript", "svg", "head", "template")

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.blocks: list[str] = []
        self._in_title = False
        self._skip_depth = 0
        self._buffer: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag == "title":
            self._in_title = True
        elif tag in self.skipped:
            self._skip_depth += 1
        elif not self._skip_depth and tag in _BLOCK_TAGS:
            self._flush()

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False
        elif tag in self.skipped:
            if self._skip_depth:
                self._skip_depth -= 1
        elif tag in _BLOCK_TAGS:
            self._flush()

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data
        elif not self._skip_depth:
            self._buffer.append(data)

    def _flush(self) -> None:
        text = "".join(self._buffer).strip()
        self._buffer = []
        if text:
            self.blocks.append(text)


def website(target: str, to_lang: str, quality: str, session: str | None, output: str) -> None:
    parsed = urllib.parse.urlsplit(target if "://" in target else f"https://{target}")
    if not parsed.netloc:
        sys.exit(f"error: cannot parse a website URL out of {target!r}")
    page_url = f"https://{parsed.netloc}{parsed.path or '/'}"
    req = urllib.request.Request(page_url, headers={"User-Agent": USER_AGENT, "Accept": "text/html"})
    res = _open(req, page_url)
    ctype = res.headers.get("Content-Type", "")
    if "html" not in ctype:
        sys.exit(f"error: {page_url} returned {ctype or 'an unknown content type'}; only HTML pages are supported.")
    extractor = _TextExtractor()
    extractor.feed(res.read().decode("utf-8", "replace"))
    if not extractor.blocks:
        sys.exit(f"error: no translatable text found on {page_url}")
    model = {"fast": "basic", "standard": "standard", "best": "best"}[quality]
    payload = {
        "source_lang": "auto",
        "target_lang": to_lang,
        "text": extractor.blocks,
        "model": model,
        "skip_definition": True,
    }
    data, _ = _post_json("/api/translate/website", payload, session, stream=False)
    translated = data.get("snippets", [])
    if output == "json":
        print(json.dumps(
            {"url": page_url, "title": extractor.title.strip(), "original": extractor.blocks, "translated": translated},
            indent=2,
            ensure_ascii=False,
        ))
        return
    if extractor.title:
        print(f"# {extractor.title.strip()}\n")
    for block in translated:
        print(block)
        print()


# credits


def credits(session: str | None, output: str) -> None:
    req = urllib.request.Request(f"{SITE}/api/credit/status", headers=_headers(session))
    data = json.load(_open(req, "/api/credit/status"))
    if output == "json":
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return
    for key, value in data.items():
        print(f"{key}: {value}")


# cli


def main() -> None:
    format_option = argparse.ArgumentParser(add_help=False)
    format_option.add_argument("--format", choices=["md", "json"], default=argparse.SUPPRESS, help="output format (default: md)")
    parser = argparse.ArgumentParser(
        prog="kagi-translate",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--format", choices=["md", "json"], default="md", help="output format (default: md)")
    sub = parser.add_subparsers(dest="command", required=True)

    p_translate = sub.add_parser("translate", parents=[format_option], help="translate text (auth required); use - to read stdin")
    p_translate.add_argument("text", help="text to translate, or - for stdin")
    p_translate.add_argument("--from", dest="from_lang", default="auto", help="source language code or auto (default: auto)")
    p_translate.add_argument("--to", dest="to_lang", default="en", help="target language code (default: en)")
    p_translate.add_argument("--no-stream", action="store_true", help="fetch the whole translation in one response")
    p_translate.add_argument("--formality", choices=["default", "more", "less"], default="default")
    p_translate.add_argument("--style", dest="translation_style", choices=["natural", "literal"], default="natural")
    p_translate.add_argument("--language-complexity", default="standard", help="standard or a1-c2 (default: standard)")
    p_translate.add_argument("--speaker-gender", choices=["unknown", "masculine", "feminine", "neutral"], default="unknown")
    p_translate.add_argument("--addressee-gender", choices=["unknown", "masculine", "feminine", "neutral"], default="unknown")
    p_translate.add_argument("--context", default="", help="extra context for the translation model")
    p_translate.add_argument("--preserve-formatting", action="store_true")
    p_translate.add_argument("--model", default=None, help=argparse.SUPPRESS)

    p_detect = sub.add_parser("detect", parents=[format_option], help="detect the language of text (auth required)")
    p_detect.add_argument("text", help="text to inspect, or - for stdin")

    p_dictionary = sub.add_parser("dictionary", parents=[format_option], help="dictionary lookup (auth required)")
    p_dictionary.add_argument("word", help="word to look up")
    p_dictionary.add_argument("--quality", choices=["standard", "best"], default="standard")
    p_dictionary.add_argument("--verbosity", choices=["concise", "standard", "comprehensive"], default="standard")
    p_dictionary.add_argument("--synonym-strategy", choices=["exact", "semantic_field", "hierarchical"], default="exact")
    p_dictionary.add_argument("--lang", default="en", help="language of the word (default: en)")
    p_dictionary.add_argument("--definition-lang", default="en", help="language of the definitions (default: en)")
    p_dictionary.add_argument("--context", default="", help="extra context for the definitions")

    p_website = sub.add_parser("website", parents=[format_option], help="translate the text of a web page (auth required)")
    p_website.add_argument("url", help="the page to translate, e.g. example.com/page")
    p_website.add_argument("--to", dest="to_lang", default="en", help="target language code (default: en)")
    p_website.add_argument("--quality", choices=["fast", "standard", "best"], default="fast")

    p_credits = sub.add_parser("credits", parents=[format_option], help="show translation credit/allowance state")
    args = parser.parse_args()

    session = get_session(required=False)

    if args.command == "translate":
        payload = {
            "text": _read_text_arg(args.text),
            "from": args.from_lang,
            "to": args.to_lang,
            "stream": not args.no_stream,
            "formality": args.formality,
            "speaker_gender": args.speaker_gender,
            "addressee_gender": args.addressee_gender,
            "language_complexity": args.language_complexity,
            "translation_style": args.translation_style,
            "context": args.context,
        }
        if args.preserve_formatting:
            payload["preserve_formatting"] = True
        if args.model:
            payload["model"] = args.model
        translate(payload, get_session(required=True), args.format)
    elif args.command == "detect":
        payload = {"text": _read_text_arg(args.text), "include_alternatives": True}
        detect(payload, get_session(required=True), args.format)
    elif args.command == "dictionary":
        payload = {
            "word": args.word,
            "word_language": args.lang,
            "definition_language": args.definition_lang,
            "ui_language": args.definition_lang,
            "stream": True,
            "quality": args.quality,
            "verbosity": args.verbosity,
            "synonym_strategy": args.synonym_strategy,
            "context": args.context,
        }
        dictionary(payload, get_session(required=True), args.format)
    elif args.command == "website":
        website(args.url, args.to_lang, args.quality, get_session(required=True), args.format)
    elif args.command == "credits":
        credits(session, args.format)


if __name__ == "__main__":
    main()
