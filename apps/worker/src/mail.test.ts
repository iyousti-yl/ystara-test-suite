import { describe, expect, it } from "vitest";
import { mailTransport } from "./mail.js";

describe("the mail server's settings", () => {
  it("insist on TLS before the password goes out, except on this machine or in the Docker network", () => {
    expect(mailTransport("smtp://alerts%40example.com:p%40ss@smtp.example.com:587")).toMatchObject({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: "alerts@example.com", pass: "p@ss" },
    });
    expect(mailTransport("smtps://u:p@smtp.example.com")).toMatchObject({ port: 465, secure: true, requireTLS: false });
    expect(mailTransport("smtp://mailpit:1025")).toMatchObject({ host: "mailpit", requireTLS: false, auth: undefined });
    expect(mailTransport("smtp://127.0.0.1:1025").requireTLS).toBe(false);
  });

  it("give up on a silent server", () => {
    expect(mailTransport("smtp://smtp.example.com").socketTimeout).toBe(60_000);
  });

  it("refuse another scheme", () => {
    expect(() => mailTransport("http://smtp.example.com")).toThrow(/smtp:\/\/ or smtps:\/\//);
  });
});
