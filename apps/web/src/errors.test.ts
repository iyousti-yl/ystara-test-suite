import { describe, expect, it } from "vitest";
import { answerError, ApiError, connectionFailure, errorMessage, fieldName, pageProblem, SignInEnded, TIMED_OUT, UNREACHABLE } from "./errors";

describe("an answer that isn't OK", () => {
  it("is a sign-in that ended when a call made while signed in gets 401, but a refusal while signing in", () => {
    expect(answerError("/pipelines/1", 401, "Unauthorized", { error: "Sign in to continue" })).toBeInstanceOf(SignInEnded);
    const wrong = answerError("/auth/login", 401, "Unauthorized", { error: "The email or password isn't right" });
    expect(wrong).not.toBeInstanceOf(SignInEnded);
    expect(wrong.message).toBe("The email or password isn't right");
    expect(answerError("/auth/code", 401, "Unauthorized", { error: "That code isn't right" })).not.toBeInstanceOf(SignInEnded);
  });

  it("says Ystara can't be reached when a gateway answers for it, and otherwise names the status", () => {
    expect(answerError("/tenants", 502, "Bad Gateway", undefined).message).toBe(UNREACHABLE);
    expect(answerError("/tenants", 504, "", "<html>timeout</html>").message).toBe(UNREACHABLE);
    expect(answerError("/tenants", 503, "Service Unavailable", { error: "The database is restarting" }).message).toBe("The database is restarting");
    expect(answerError("/tenants", 500, "Internal Server Error", undefined).message).toBe(
      "Something went wrong in Ystara (500 Internal Server Error). Try again in a moment.",
    );
  });

  it("is one plain sentence when no answer came at all, or not in time", () => {
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    expect(connectionFailure(timeout)).toMatchObject({ status: 0, message: TIMED_OUT });
    expect(connectionFailure(new TypeError("Failed to fetch"))).toMatchObject({ status: 0, message: UNREACHABLE });
  });
});

describe("a refused form", () => {
  it("names each field it refused, without the API's \"Invalid request\"", () => {
    const data = {
      error: "Invalid request",
      issues: [
        { code: "too_big", type: "string", maximum: 100, path: ["name"], message: "String must contain at most 100 character(s)" },
        { code: "custom", path: ["tokenUrl"], message: "Use the token URL shown on the App Integration page" },
        { code: "invalid_string", validation: "regex", path: ["spaces", 2], message: "Space IDs contain only letters, digits and underscores" },
      ],
    };
    expect(errorMessage(data)).toBe(
      "Name: Use at most 100 characters; Token URL: Use the token URL shown on the App Integration page; Spaces: Space IDs contain only letters, digits and underscores",
    );
  });

  it("puts Zod's wording the way a person says it", () => {
    const issue = (i: object) => errorMessage({ error: "Invalid request", issues: [i] });
    expect(issue({ code: "too_small", type: "string", minimum: 1, path: ["clientId"], message: "String must contain at least 1 character(s)" })).toBe("Client ID: Fill this in");
    expect(issue({ code: "invalid_type", received: "undefined", path: ["password"], message: "Required" })).toBe("Password: Fill this in");
    expect(issue({ code: "invalid_string", validation: "email", path: ["email"], message: "Invalid email" })).toBe("Email: Enter an email address");
    expect(issue({ code: "too_big", type: "array", maximum: 20, path: ["spaces"], message: "Array must contain at most 20 element(s)" })).toBe("Spaces: At most 20");
  });

  it("keeps the API's own sentence when there are no issues, and has none for an answer without one", () => {
    expect(errorMessage({ error: "Only admins can do this" })).toBe("Only admins can do this");
    expect(errorMessage({ error: "Invalid request", issues: [{ code: "custom", path: [], message: "Say why you reject it" }] })).toBe("Say why you reject it");
    expect(errorMessage("<html>")).toBeUndefined();
    expect(errorMessage(undefined)).toBeUndefined();
  });

  it("writes a field's name in words", () => {
    expect(fieldName(["tokenUrl"])).toBe("Token URL");
    expect(fieldName(["clientId"])).toBe("Client ID");
    expect(fieldName(["row_drop_percent"])).toBe("Row drop percent");
    expect(fieldName(["spaces", 0])).toBe("Spaces");
    expect(fieldName([0])).toBeUndefined();
  });
});

describe("a page that couldn't load", () => {
  it("says why, by the answer's status", () => {
    expect(pageProblem(new ApiError(404, "Pipeline not found"), "pipeline", false)).toEqual({
      heading: "Pipeline not found",
      sentence: "It may have been deleted, or the link is mistyped.",
      retry: false,
    });
    expect(pageProblem(new ApiError(404, "Pipeline not found"), "pipeline", true).sentence).toBe(
      "It may have been deleted, or it belongs to another of your accounts: switch accounts in the user menu.",
    );
    expect(pageProblem(new ApiError(400, "Invalid request"), "snapshot", false)).toMatchObject({ heading: "This link is incomplete", retry: false });
    expect(pageProblem(new ApiError(403, "Only admins can do this"), "tenant", false)).toEqual({
      heading: "You can't open this tenant",
      sentence: "Only admins can do this. Ask an admin of the account if you need it.",
      retry: false,
    });
  });

  it("offers to try again only when that may help", () => {
    expect(pageProblem(new ApiError(0, UNREACHABLE), "scan", false)).toEqual({ heading: "Ystara can't be reached", sentence: UNREACHABLE, retry: true });
    expect(pageProblem(new ApiError(500, "Boom"), "scan", false)).toMatchObject({ heading: "Something went wrong", retry: true });
    expect(pageProblem(new SignInEnded(), "scan", false)).toMatchObject({ heading: "Your sign-in ended", retry: false });
  });
});
