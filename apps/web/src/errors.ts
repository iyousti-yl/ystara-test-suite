/**
 * What goes wrong with a call to the API, in words a person reads: the API's
 * own sentence, the field a refused form names, or one plain sentence when
 * Ystara can't be reached at all. Plain functions, so the wording is tested
 * (errors.test.ts); api.ts throws these and the pages show them.
 */
export class ApiError extends Error {
  constructor(
    /** The HTTP status, or 0 when no answer came (no connection, or too slow). */
    readonly status: number,
    message: string,
    /** The whole answer, for fields beyond `error`. */
    readonly body?: unknown,
  ) {
    super(message);
  }
}

/**
 * A 401 on a call made while signed in: the sign-in ended (an hour without use,
 * signed out elsewhere, or removed from the account). main.tsx then opens
 * "Your sign-in ended" over the page, so nothing on it is lost; a wrong password
 * or code while signing in is a plain ApiError, shown in the form.
 */
export class SignInEnded extends ApiError {
  constructor(body?: unknown) {
    super(401, "Your sign-in ended. Sign in again to carry on.", body);
  }
}

export const isUnauthorized = (e: unknown) => e instanceof ApiError && e.status === 401;

export const UNREACHABLE = "Ystara can't be reached right now. Check your connection and try again.";
export const TIMED_OUT = "Ystara didn't answer within 30 seconds. Try again in a moment.";

/** A fetch that got no answer: no connection, or it took longer than its time limit (AbortSignal.timeout). */
export function connectionFailure(e: unknown): ApiError {
  return new ApiError(0, e instanceof DOMException && e.name === "TimeoutError" ? TIMED_OUT : UNREACHABLE);
}

/** The calls that check a password or code: their 401 means "not right", not that a sign-in ended. */
const SIGN_IN_STEPS = new Set(["/auth/login", "/auth/code"]);

/**
 * An answer that isn't OK, as the error to throw. A gateway that answers for the API while it is down
 * (502, 503, 504 without the API's own words) counts as "can't be reached".
 */
export function answerError(path: string, status: number, statusText: string, data: unknown): ApiError {
  if (status === 401 && !SIGN_IN_STEPS.has(path)) return new SignInEnded(data);
  const message = errorMessage(data) ?? (status >= 502 && status <= 504 ? UNREACHABLE : `Something went wrong in Ystara (${status}${statusText ? ` ${statusText}` : ""}). Try again in a moment.`);
  return new ApiError(status, message, data);
}

interface Issue {
  path?: (string | number)[];
  message?: string;
  code?: string;
  type?: string;
  minimum?: number;
  maximum?: number;
  received?: string;
  validation?: string;
}

/**
 * The API's `{ error, issues? }` as one readable sentence. A refused form comes with Zod's issues: each is
 * named by its field ("Token URL: Use the token URL from…"), without the API's "Invalid request" before them.
 */
export function errorMessage(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || !("error" in data) || typeof data.error !== "string") return undefined;
  const issues = "issues" in data && Array.isArray(data.issues) ? (data.issues as Issue[]).map(issueText).filter(Boolean) : [];
  return issues.length ? issues.join("; ") : data.error;
}

function issueText(issue: Issue): string {
  const says = plainIssue(issue);
  const field = fieldName(issue.path ?? []);
  return field && says ? `${field}: ${says}` : (says ?? "");
}

/** Zod's own wording where a person would say it differently; a refine's message as it is. */
function plainIssue(i: Issue): string | undefined {
  if (i.code === "too_big" && i.type === "string") return `Use at most ${i.maximum} characters`;
  if (i.code === "too_big" && i.type === "array") return `At most ${i.maximum}`;
  if ((i.code === "too_small" && i.type === "string" && i.minimum === 1) || (i.code === "invalid_type" && i.received === "undefined")) return "Fill this in";
  if (i.code === "invalid_string" && i.validation === "email") return "Enter an email address";
  return i.message;
}

/** The field an issue is about, from its path: the last name in it ("spaces.2" is Spaces), in words ("tokenUrl" is Token URL). */
export function fieldName(path: (string | number)[]): string | undefined {
  const name = [...path].reverse().find((p): p is string => typeof p === "string");
  if (!name) return undefined;
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((w) => (/^(id|url)$/i.test(w) ? w.toUpperCase() : w.toLowerCase()));
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What a page that couldn't load says: a heading, one sentence, and whether trying again may help. */
export interface PageProblem {
  heading: string;
  sentence: string;
  retry: boolean;
}

/**
 * A page's main call failed (PageError): what the person reads, by status. `what` names what the link
 * points at ("pipeline"); `severalAccounts`: the user belongs to more than one account, so a link from
 * another of them may be why it isn't found.
 */
export function pageProblem(error: Error, what: string, severalAccounts: boolean): PageProblem {
  const status = error instanceof ApiError ? error.status : undefined;
  if (error instanceof SignInEnded) return { heading: "Your sign-in ended", sentence: "Sign in again to see this page.", retry: false };
  if (status === 0) return { heading: "Ystara can't be reached", sentence: error.message, retry: true };
  if (status === 400) {
    return { heading: "This link is incomplete", sentence: `Part of its address is missing or mistyped. Open the ${what} again from its list, or start from Home.`, retry: false };
  }
  if (status === 403) return { heading: `You can't open this ${what}`, sentence: `${error.message.replace(/\.?$/, ".")} Ask an admin of the account if you need it.`, retry: false };
  if (status === 404) {
    return {
      heading: `${what.charAt(0).toUpperCase()}${what.slice(1)} not found`,
      sentence: severalAccounts
        ? "It may have been deleted, or it belongs to another of your accounts: switch accounts in the user menu."
        : "It may have been deleted, or the link is mistyped.",
      retry: false,
    };
  }
  return { heading: "Something went wrong", sentence: `Ystara couldn't load this ${what}. Try again in a moment; if it keeps happening, tell your admin.`, retry: true };
}
