import type { TechnicalClient } from "./cli.js";

/**
 * `text` with every credential in it replaced by "<secret>", before it is
 * stored or shown (a failed CLI call, a scan warning, a connection check).
 *
 * With `client`, its secret in every form the CLI or an HTTP library may print
 * it: as it is, URL-encoded, and in base64 or base64url, alone or as
 * "clientId:secret" (an HTTP Basic header). Always, whatever looks like a
 * credential, since the access token the CLI gets is never known to us:
 * Bearer and Basic headers, JWTs (eyJ….….…), and the values of access_token,
 * refresh_token, id_token and client_secret in JSON, a query string or a form.
 */
export function maskSecrets(text: string, client?: Pick<TechnicalClient, "clientId" | "clientSecret">): string {
  let out = text;
  // Longest first, so a form that contains another one is replaced whole.
  for (const form of [...clientForms(client)].sort((a, b) => b.length - a.length)) out = out.replaceAll(form, MASK);
  return GENERIC.reduce((t, [pattern, replacement]) => t.replace(pattern, replacement), out);
}

const MASK = "<secret>";
const KEYS = String.raw`\b(?:access|refresh|id)[_-]?token|\bclient[_-]?secret`;

const GENERIC: [RegExp, string][] = [
  [/\b(Bearer)\s+[A-Za-z0-9\-._~+/]{16,}=*/gi, `$1 ${MASK}`],
  // Base64 with a digit or + / = in it, so "Basic authentication" stays readable.
  [/\b(Basic)\s+(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{12,}={0,2}/g, `$1 ${MASK}`],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, MASK],
  // "access_token": "…", client_secret: '…', access_token="…" (up to the line's end when output was cut off)
  [new RegExp(String.raw`(${KEYS})(["']?\s*[:=]\s*)(["'])(?:\\.|(?!\3)[^\\\n])*(\3?)`, "gi"), `$1$2$3${MASK}$4`],
  // ?access_token=…&, client_secret=… in a form, access_token: … in YAML or a log line
  [new RegExp(String.raw`(${KEYS})(["']?\s*[:=]\s*)(?![\s"'<])[^\s&"',;}]+`, "gi"), `$1$2${MASK}`],
];

/** The ways a client's secret can be written out, apart from the patterns above. */
function clientForms(client: Pick<TechnicalClient, "clientId" | "clientSecret"> | undefined): Set<string> {
  const forms = new Set<string>();
  if (!client?.clientSecret) return forms;
  const { clientId, clientSecret } = client;
  // OAuth's Basic header URL-encodes both parts first (RFC 6749, 2.3.1), in one of two ways; many libraries don't.
  const pairs = [(v: string) => v, encodeURIComponent, formEncode].map((encode) => `${encode(clientId)}:${encode(clientSecret)}`);
  for (const plain of [clientSecret, ...pairs]) {
    const base64 = Buffer.from(plain, "utf8").toString("base64");
    forms.add(base64).add(base64.replace(/=+$/, "")).add(Buffer.from(plain, "utf8").toString("base64url"));
  }
  forms.add(clientSecret);
  for (const encoded of [encodeURIComponent(clientSecret), formEncode(clientSecret)]) {
    forms.add(encoded).add(encoded.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase()));
  }
  return forms;
}

/** As in an application/x-www-form-urlencoded body: a space is "+", and !'()~ are encoded too. */
const formEncode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
