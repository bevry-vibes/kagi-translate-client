#!/usr/bin/env -S deno run --allow-env --allow-net
/** kagi-translate — API client for Kagi Translate (translate.kagi.com).

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

Like-for-like Deno port of kagi_translate.py — same commands, options,
outputs and endpoints. Deno std only (@std/streams), mirroring the
Python client's stdlib-only rule.

Usage:
    deno run --allow-env --allow-net kagi_translate.ts <command> [options]
    kagi-translate translate <text> [--from auto] [--to en] [options]
    kagi-translate detect <text>
    kagi-translate dictionary <word> [options]
    kagi-translate website <url> [--to en] [--quality fast]
    kagi-translate credits
*/

// deno-lint-ignore-file no-explicit-any

import { toText } from "@std/streams/to-text";
import { TextLineStream } from "@std/streams/text-line-stream";

const SITE = "https://translate.kagi.com";
const USER_AGENT =
  "kagi-translate-client/0.1 (+https://github.com/bevry-vibes/kagi-translate-client)";
// The app's own fallback when its signing module did not initialise; the
// server accepts it in place of the signed-request headers.
const SIGNING_FAIL = btoa("no_init_started");
const TIMEOUT_MS = 120_000;

const encoder = new TextEncoder();

function exit(message: string): never {
  Deno.stderr.writeSync(encoder.encode(`${message}\n`));
  Deno.exit(1);
}

function write(text: string): void {
  Deno.stdout.writeSync(encoder.encode(text));
}

function print(text = ""): void {
  write(`${text}\n`);
}

// json.dumps(data, indent=2, ensure_ascii=False) equivalent
function jsonDump(data: any): string {
  return JSON.stringify(data, null, 2);
}

// str() for the `key: value` credit lines (True/False/None, raw strings)
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "string") return value;
  return String(value);
}

// session

function getSession(required: boolean): string | null {
  const raw = (Deno.env.get("KAGI_SESSION") ?? "").trim();
  const session = raw.startsWith("kagi_session=")
    ? raw.split("=", 2)[1].trim()
    : raw;
  if (required && !session) {
    exit(
      "error: KAGI_SESSION environment variable is required for this command.\n" +
        "Set it to your kagi_session cookie value from translate.kagi.com\n" +
        "(browser devtools, Application, Cookies).",
    );
  }
  return session || null;
}

// transport

function headers(
  session: string | null,
  content = false,
): Record<string, string> {
  const result: Record<string, string> = {
    "User-Agent": USER_AGENT,
    "X-Signing-Fail": SIGNING_FAIL,
    ...(session ? { Cookie: `kagi_session=${session}` } : {}),
  };
  if (content) result["Content-Type"] = "application/json";
  return result;
}

async function open(
  displayPath: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    exit(
      `error: cannot reach ${displayPath}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    if (res.status === 401) {
      exit(
        "error: not_authenticated — set the KAGI_SESSION environment variable " +
          "to your kagi_session cookie from translate.kagi.com.",
      );
    }
    if (res.status === 429) {
      exit(
        "error: rate_limited — the monthly allowance or per-minute limit is spent; try again later.",
      );
    }
    exit(
      `error: HTTP ${res.status} for ${displayPath}: ${JSON.stringify(body)}`,
    );
  }
  return res;
}

async function postJson(
  path: string,
  payload: unknown,
  session: string | null,
  stream: boolean,
): Promise<{ res?: Response; data?: any; streaming: boolean }> {
  const res = await open(path, `${SITE}${path}`, {
    method: "POST",
    headers: headers(session, true),
    body: JSON.stringify(payload),
  });
  const ctype = res.headers.get("Content-Type") ?? "";
  if (stream && ctype.includes("event-stream")) return { res, streaming: true };
  return { data: await res.json(), streaming: false };
}

/** Yield one parsed JSON object per `data:` line of an SSE response. */
async function* sseEvents(res: Response): AsyncGenerator<any> {
  const parseDataLine = (line: string): any | undefined => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return undefined;
    const chunk = trimmed.slice(5).trim();
    if (!chunk) return undefined;
    try {
      return JSON.parse(chunk);
    } catch {
      return undefined;
    }
  };
  const lines: ReadableStream<string> = res.body!
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TextLineStream());
  for await (const line of lines) {
    const event = parseDataLine(line);
    if (event !== undefined) yield event;
  }
}

async function readTextArg(value: string): Promise<string> {
  return value === "-" ? await toText(Deno.stdin.readable) : value;
}

function exitOnErrorEvent(event: any): void {
  if ("error" in event) {
    const detail = event.message || event.error;
    exit(`error: ${event.error} — ${detail}`);
  }
}

// translate

async function translate(
  payload: any,
  session: string | null,
  output: string,
): Promise<void> {
  const posted = await postJson("/api/translate", payload, session, true);
  if (!posted.streaming) {
    printTranslation(posted.data, output);
    return;
  }
  let detected: any;
  const parts: string[] = [];
  let headerDone = false;
  for await (const event of sseEvents(posted.res!)) {
    exitOnErrorEvent(event);
    if ("detected_language" in event) {
      detected = event.detected_language;
    } else if ("delta" in event) {
      if (output === "md") {
        if (!headerDone) {
          print(
            `[${detected?.iso ?? payload.from ?? "auto"} -> ${
              payload.to ?? "en"
            }]\n`,
          );
          headerDone = true;
        }
        write(event.delta);
      }
      parts.push(event.delta);
    } else if (event.done) {
      break;
    }
  }
  if (output === "md") {
    if (headerDone) {
      print();
    } else {
      printTranslation(
        { translation: parts.join(""), detected_language: detected },
        output,
      );
    }
  } else {
    print(
      jsonDump({ translation: parts.join(""), detected_language: detected }),
    );
  }
}

function printTranslation(data: any, output: string): void {
  if (output === "json") {
    print(jsonDump(data));
    return;
  }
  const detected = data.detected_language ?? {};
  print(`[${detected.iso ?? "?"} -> ]\n${data.translation ?? ""}`);
}

// detect

async function detect(
  payload: any,
  session: string | null,
  output: string,
): Promise<void> {
  const posted = await postJson("/api/detect", payload, session, false);
  const data = posted.data;
  if (output === "json") print(jsonDump(data));
  else print(`${data.label ?? "?"} (${data.iso ?? "?"})`);
}

// dictionary

async function dictionary(
  payload: any,
  session: string | null,
  output: string,
): Promise<void> {
  const posted = await postJson("/api/dictionary", payload, session, true);
  if (!posted.streaming) {
    print(jsonDump(posted.data));
    return;
  }
  const fields: Record<string, any> = {};
  let attribution: any;
  for await (const event of sseEvents(posted.res!)) {
    exitOnErrorEvent(event);
    if ("definition_field" in event) {
      const field = event.definition_field;
      fields[field.field ?? "?"] = field.value ?? null;
      if (output === "md") {
        printDictionaryField(field.field ?? "?", field.value);
      }
    } else if ("attribution" in event) {
      attribution = event.attribution;
    } else if (event.done) {
      break;
    }
  }
  if (output === "json") {
    print(jsonDump({ fields, attribution }));
  } else if (attribution) {
    const kind = ({ ai_generated: "AI-generated" } as Record<string, string>)[
      attribution.type ?? ""
    ] ?? attribution.type ?? "unknown";
    const extra = attribution.wiktionary_used ? " (Wiktionary used)" : "";
    print(`\n---\nSource: ${kind}${extra}`);
  }
}

function printDictionaryField(field: string, value: any): void {
  if (field === "word") {
    print(`# ${value}`);
    return;
  }
  if (
    field === "primary_meaning" && value && typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const pos = (value.part_of_speech ?? []).join(", ");
    const level = (value.usage_level ?? []).join(", ");
    const label = "primary meaning" +
      (pos ? ` (${pos}${level ? `; ${level}` : ""})` : "");
    print(`\n## ${label}\n\n${value.definition ?? ""}`);
    const synonyms = Array.isArray(value.synonyms) ? value.synonyms : [];
    if (synonyms.length) print(`\nSynonyms: ${synonyms.join(", ")}`);
    for (const comparison of value.synonym_comparisons ?? []) {
      print(`- ${comparison.synonym ?? "?"}: ${comparison.difference ?? ""}`);
    }
    return;
  }
  if (field === "examples" && Array.isArray(value)) {
    print("\n## examples");
    for (const example of value) print(`- ${example}`);
    return;
  }
  if (field === "related_words" && Array.isArray(value)) {
    print("\n## related words");
    for (const related of value) {
      print(`- ${related.word ?? "?"} (${related.relationship ?? "?"})`);
    }
    return;
  }
  if (typeof value === "string") {
    print(`\n## ${field.replace(/_/g, " ")}\n\n${value}`);
  }
}

// website

const BLOCK_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "blockquote",
  "pre",
  "td",
  "th",
  "figcaption",
  "dt",
  "dd",
]);
const SKIPPED_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "svg",
  "head",
  "template",
]);

/** Collect the page title and one text chunk per block element.
 *
 * Mirrors kagi_translate.py's _TextExtractor over html.parser: a tolerant
 * tag/text scanner (Deno 2 ships no HTMLRewriter and Deno std has no HTML
 * parser), with script/style content treated as CDATA like html.parser. */
class TextExtractor {
  title = "";
  blocks: string[] = [];
  private buffer = "";
  private inTitle = false;
  private skipDepth = 0;

  private flush(): void {
    const text = this.buffer.trim();
    this.buffer = "";
    if (text) this.blocks.push(text);
  }

  startTag(tag: string, selfClosing: boolean): void {
    this.handleTag(tag, true);
    if (selfClosing) this.handleTag(tag, false);
  }

  endTag(tag: string): void {
    this.handleTag(tag, false);
  }

  text(data: string): void {
    if (this.inTitle) this.title += data;
    else if (!this.skipDepth) this.buffer += data;
  }

  private handleTag(tag: string, start: boolean): void {
    if (tag === "title") {
      this.inTitle = start;
      return;
    }
    if (SKIPPED_TAGS.has(tag)) {
      if (start) this.skipDepth++;
      else if (this.skipDepth) this.skipDepth--;
      return;
    }
    // end tags flush regardless of skip depth, exactly like the Python parser
    if (BLOCK_TAGS.has(tag) && (!this.skipDepth || !start)) this.flush();
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ccedil: "ç",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
  szlig: "ß",
};

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (entity, body: string) => {
      if (body.startsWith("#x") || body.startsWith("#X")) {
        const code = parseInt(body.slice(2), 16);
        return Number.isNaN(code) ? entity : String.fromCodePoint(code);
      }
      if (body.startsWith("#")) {
        const code = parseInt(body.slice(1), 10);
        return Number.isNaN(code) ? entity : String.fromCodePoint(code);
      }
      return ENTITIES[body.toLowerCase()] ?? entity;
    },
  );
}

function scanHtml(html: string, extractor: TextExtractor): void {
  // find the end of a start tag, skipping over quoted attribute values
  const tagEnd = (from: number): number => {
    for (let i = from; i < html.length; i++) {
      const ch = html[i];
      if (ch === '"' || ch === "'") {
        const close = html.indexOf(ch, i + 1);
        if (close === -1) return html.length;
        i = close;
      } else if (ch === ">") {
        return i;
      }
    }
    return html.length;
  };
  let pos = 0;
  while (pos < html.length) {
    const open = html.indexOf("<", pos);
    if (open === -1) {
      extractor.text(decodeEntities(html.slice(pos)));
      return;
    }
    if (open > pos) extractor.text(decodeEntities(html.slice(pos, open)));
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      pos = close === -1 ? html.length : close + 3;
      continue;
    }
    if (html.startsWith("<!", open) || html.startsWith("<?", open)) {
      const close = html.indexOf(">", open);
      pos = close === -1 ? html.length : close + 1;
      continue;
    }
    const nameMatch = /^<\/?\s*([a-zA-Z][a-zA-Z0-9:_-]*)/.exec(
      html.slice(open),
    );
    if (!nameMatch) {
      // a literal '<' that is not a tag; html.parser passes it through as data
      extractor.text("<");
      pos = open + 1;
      continue;
    }
    const tag = nameMatch[1].toLowerCase();
    const isEnd = html[open + 1] === "/";
    if (isEnd) {
      const close = html.indexOf(">", open);
      pos = close === -1 ? html.length : close + 1;
      extractor.endTag(tag);
      continue;
    }
    const end = tagEnd(open + nameMatch[0].length);
    const selfClosing = html[end - 1] === "/";
    pos = end === html.length ? html.length : end + 1;
    extractor.startTag(tag, selfClosing);
    // script/style content is CDATA for html.parser: skip to the real end tag
    if ((tag === "script" || tag === "style") && !selfClosing) {
      const close = new RegExp(`</\\s*${tag}\\b[^>]*>`, "i").exec(
        html.slice(pos),
      );
      if (close) {
        extractor.endTag(tag);
        pos += close.index + close[0].length;
      }
    }
  }
}

async function extractPage(
  pageUrl: string,
): Promise<{ title: string; blocks: string[] }> {
  const res = await open(pageUrl, pageUrl, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
  });
  const ctype = res.headers.get("Content-Type") ?? "";
  if (!ctype.includes("html")) {
    exit(
      `error: ${pageUrl} returned ${
        ctype || "an unknown content type"
      }; only HTML pages are supported.`,
    );
  }
  const extractor = new TextExtractor();
  scanHtml(await res.text(), extractor);
  return extractor;
}

async function website(
  target: string,
  toLang: string,
  quality: string,
  session: string | null,
  output: string,
): Promise<void> {
  const candidate = target.includes("://") ? target : `https://${target}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    exit(`error: cannot parse a website URL out of ${JSON.stringify(target)}`);
  }
  if (!parsed.host) {
    exit(`error: cannot parse a website URL out of ${JSON.stringify(target)}`);
  }
  const pageUrl = `https://${parsed.host}${parsed.pathname || "/"}`;
  const extractor = await extractPage(pageUrl);
  if (!extractor.blocks.length) {
    exit(`error: no translatable text found on ${pageUrl}`);
  }
  const models: Record<string, string> = {
    fast: "basic",
    standard: "standard",
    best: "best",
  };
  const payload = {
    source_lang: "auto",
    target_lang: toLang,
    text: extractor.blocks,
    model: models[quality],
    skip_definition: true,
  };
  const posted = await postJson(
    "/api/translate/website",
    payload,
    session,
    false,
  );
  const translated = posted.data.snippets ?? [];
  if (output === "json") {
    print(
      jsonDump({
        url: pageUrl,
        title: extractor.title.trim(),
        original: extractor.blocks,
        translated,
      }),
    );
    return;
  }
  const title = extractor.title.trim();
  if (title) print(`# ${title}\n`);
  for (const block of translated) {
    print(block);
    print();
  }
}

// credits

async function credits(session: string | null, output: string): Promise<void> {
  const res = await open("/api/credit/status", `${SITE}/api/credit/status`, {
    headers: headers(session),
  });
  const data = await res.json();
  if (output === "json") {
    print(jsonDump(data));
    return;
  }
  for (const [key, value] of Object.entries(data)) {
    print(`${key}: ${pyStr(value)}`);
  }
}

// cli

type OptionSpec = { key: string; kind: "value" | "flag"; choices?: string[] };
type CommandSpec = {
  help: string;
  positional: string | null;
  options: Record<string, OptionSpec>;
};

const COMMANDS: Record<string, CommandSpec> = {
  translate: {
    help: "translate text (auth required); use - to read stdin",
    positional: "text",
    options: {
      "--from": { key: "from_lang", kind: "value" },
      "--to": { key: "to_lang", kind: "value" },
      "--no-stream": { key: "no_stream", kind: "flag" },
      "--formality": {
        key: "formality",
        kind: "value",
        choices: ["default", "more", "less"],
      },
      "--style": {
        key: "translation_style",
        kind: "value",
        choices: ["natural", "literal"],
      },
      "--language-complexity": { key: "language_complexity", kind: "value" },
      "--speaker-gender": {
        key: "speaker_gender",
        kind: "value",
        choices: ["unknown", "masculine", "feminine", "neutral"],
      },
      "--addressee-gender": {
        key: "addressee_gender",
        kind: "value",
        choices: ["unknown", "masculine", "feminine", "neutral"],
      },
      "--context": { key: "context", kind: "value" },
      "--preserve-formatting": { key: "preserve_formatting", kind: "flag" },
      "--model": { key: "model", kind: "value" },
    },
  },
  detect: {
    help: "detect the language of text (auth required)",
    positional: "text",
    options: {},
  },
  dictionary: {
    help: "dictionary lookup (auth required)",
    positional: "word",
    options: {
      "--quality": {
        key: "quality",
        kind: "value",
        choices: ["standard", "best"],
      },
      "--verbosity": {
        key: "verbosity",
        kind: "value",
        choices: ["concise", "standard", "comprehensive"],
      },
      "--synonym-strategy": {
        key: "synonym_strategy",
        kind: "value",
        choices: ["exact", "semantic_field", "hierarchical"],
      },
      "--lang": { key: "lang", kind: "value" },
      "--definition-lang": { key: "definition_lang", kind: "value" },
      "--context": { key: "context", kind: "value" },
    },
  },
  website: {
    help: "translate the text of a web page (auth required)",
    positional: "url",
    options: {
      "--to": { key: "to_lang", kind: "value" },
      "--quality": {
        key: "quality",
        kind: "value",
        choices: ["fast", "standard", "best"],
      },
    },
  },
  credits: {
    help: "show translation credit/allowance state",
    positional: null,
    options: {},
  },
};

const HELP = `usage: kagi-translate [-h] [--format {md,json}]
                      {translate,detect,dictionary,website,credits} ...

kagi-translate — API client for Kagi Translate (translate.kagi.com).

Endpoints (discovered 2026-09-22 against translate.kagi.com):

- POST /api/translate          text translation (auth); SSE stream by default
- POST /api/detect             language detection (auth)
- POST /api/dictionary         dictionary lookup (auth); SSE stream
- POST /api/translate/website  batch translation of page text (auth)
- GET  /api/credit/status      usage/credit state (no auth)

Authentication: the KAGI_SESSION environment variable (your \`kagi_session\`
cookie from translate.kagi.com). Everything except the credit check needs
it — the browser's anonymous website-translation flow relies on an
invisible Cloudflare Turnstile challenge that no CLI can solve.
The value is read from the environment only — never stored, never committed.

commands:
  translate    translate text (auth required); use - to read stdin
  detect       detect the language of text (auth required)
  dictionary   dictionary lookup (auth required)
  website      translate the text of a web page (auth required)
  credits      show translation credit/allowance state

options:
  -h, --help           show this help message and exit
  --format {md,json}   output format (default: md)

run \`kagi-translate <command> -h\` for a command's options.`;

function usageError(message: string): never {
  Deno.stderr.writeSync(encoder.encode(`${message}\n`));
  Deno.stderr.writeSync(
    encoder.encode(
      "usage: kagi-translate [-h] [--format {md,json}] {translate,detect,dictionary,website,credits} ...\n",
    ),
  );
  Deno.exit(2);
}

function parseFormatValue(value: string | undefined, argument: string): string {
  if (value === undefined) {
    usageError(`argument ${argument}: expected one argument`);
  }
  if (value !== "md" && value !== "json") {
    usageError(
      `argument ${argument}: invalid choice: ${
        JSON.stringify(value)
      } (choose from 'md', 'json')`,
    );
  }
  return value;
}

export async function main(): Promise<void> {
  const argv = [...Deno.args];
  const parsed: Record<string, string | boolean> = {};

  // global options, before the subcommand
  let index = 0;
  for (; index < argv.length; index++) {
    const token = argv[index];
    if (token === "-h" || token === "--help") {
      print(HELP);
      return;
    }
    if (token === "--format" || token.startsWith("--format=")) {
      const value = token.startsWith("--format=")
        ? token.slice("--format=".length)
        : argv[++index];
      parsed.format = parseFormatValue(value, "--format");
      continue;
    }
    if (token.startsWith("-")) usageError(`unrecognized argument: ${token}`);
    break;
  }

  const command = argv[index];
  if (!command) usageError("the following arguments are required: command");
  const spec = COMMANDS[command];
  if (!spec) {
    usageError(
      `argument command: invalid choice: ${
        JSON.stringify(command)
      } (choose from 'translate', 'detect', 'dictionary', 'website', 'credits')`,
    );
  }

  // options and the positional, after the subcommand
  const positionals: string[] = [];
  const rest = argv.slice(index + 1);
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === "-h" || token === "--help") {
      print(
        `${spec.help}\n\noptions:\n  -h, --help           show this help message and exit\n  --format {md,json}   output format (default: md)\n${
          Object.entries(spec.options).map(([name, option]) =>
            `  ${name}${
              option.kind === "value"
                ? (option.choices ? ` {${option.choices.join(",")}}` : " VALUE")
                : ""
            }`
          ).join("\n")
        }`,
      );
      return;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = eq === -1 ? token : token.slice(0, eq);
      if (name === "--format") {
        const value = eq === -1 ? rest[++i] : token.slice(eq + 1);
        parsed.format = parseFormatValue(value, "--format");
        continue;
      }
      const option = spec.options[name];
      if (!option) usageError(`unrecognized argument: ${name}`);
      if (option.kind === "flag") {
        if (eq !== -1) {
          usageError(
            `argument ${name}: ignored explicit argument ${
              JSON.stringify(token.slice(eq + 1))
            }`,
          );
        }
        parsed[option.key] = true;
        continue;
      }
      const value = eq === -1 ? rest[++i] : token.slice(eq + 1);
      if (value === undefined) {
        usageError(`argument ${name}: expected one argument`);
      }
      if (option.choices && !option.choices.includes(value)) {
        usageError(
          `argument ${name}: invalid choice: ${
            JSON.stringify(value)
          } (choose from ${
            option.choices.map((choice) => JSON.stringify(choice)).join(", ")
          })`,
        );
      }
      parsed[option.key] = value;
      continue;
    }
    positionals.push(token);
  }
  if (spec.positional) {
    if (!positionals.length) {
      usageError(`the following arguments are required: ${spec.positional}`);
    }
    if (positionals.length > 1) {
      usageError(`unrecognized arguments: ${positionals.slice(1).join(" ")}`);
    }
  }

  const output = (parsed.format as string | undefined) ?? "md";
  const as = (key: string): string | undefined =>
    parsed[key] as string | undefined;
  const positional = positionals[0];

  switch (command) {
    case "translate": {
      const payload: any = {
        text: await readTextArg(positional),
        from: as("from_lang") ?? "auto",
        to: as("to_lang") ?? "en",
        stream: !parsed.no_stream,
        formality: as("formality") ?? "default",
        speaker_gender: as("speaker_gender") ?? "unknown",
        addressee_gender: as("addressee_gender") ?? "unknown",
        language_complexity: as("language_complexity") ?? "standard",
        translation_style: as("translation_style") ?? "natural",
        context: as("context") ?? "",
      };
      if (parsed.preserve_formatting) payload.preserve_formatting = true;
      const model = as("model");
      if (model) payload.model = model;
      await translate(payload, getSession(true), output);
      return;
    }
    case "detect": {
      const payload = {
        text: await readTextArg(positional),
        include_alternatives: true,
      };
      await detect(payload, getSession(true), output);
      return;
    }
    case "dictionary": {
      const payload = {
        word: positional,
        word_language: as("lang") ?? "en",
        definition_language: as("definition_lang") ?? "en",
        ui_language: as("definition_lang") ?? "en",
        stream: true,
        quality: as("quality") ?? "standard",
        verbosity: as("verbosity") ?? "standard",
        synonym_strategy: as("synonym_strategy") ?? "exact",
        context: as("context") ?? "",
      };
      await dictionary(payload, getSession(true), output);
      return;
    }
    case "website":
      await website(
        positional,
        as("to_lang") ?? "en",
        as("quality") ?? "fast",
        getSession(true),
        output,
      );
      return;
    case "credits":
      await credits(getSession(false), output);
      return;
  }
}

if (import.meta.main) await main();
