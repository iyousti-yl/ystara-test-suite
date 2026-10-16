import type { HTMLInputAutoCompleteAttribute, ReactNode } from "react";
import { ShellBar, ShellBarBranding, Title } from "@ui5/webcomponents-react";

/** The frame of the pages people see before they are signed in: a plain bar and one centred card. */
export function AuthFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="app">
      <ShellBar branding={<ShellBarBranding>Ystara Test Suite</ShellBarBranding>} />
      <main className="app-main">
        <div className="auth-card">
          <Title level="H3">{title}</Title>
          {children}
        </div>
      </main>
    </div>
  );
}

/**
 * A form of Fields. Enter in a field submits it: the browser does that only for a form with a
 * native submit button, and the visible button is a ui5-button, so a hidden native one is added.
 */
export function AuthForm({ onSubmit, children }: { onSubmit: () => void; children: ReactNode }) {
  return (
    <form
      className="auth-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}
      <button type="submit" hidden />
    </form>
  );
}

/**
 * A sign-in field. Plain <input> elements styled like UI5's, not ui5-input: password managers and
 * the browser's one-time-code fill only find fields outside shadow DOM, and `autoComplete` tells them
 * which is which (username, current-password, new-password, one-time-code).
 */
export function Field(props: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "email" | "password" | "text";
  autoComplete: HTMLInputAutoCompleteAttribute;
  invalid?: boolean;
  numeric?: boolean;
  placeholder?: string;
}) {
  return (
    <>
      <label htmlFor={props.id} className="auth-label">
        {props.label}
      </label>
      <input
        id={props.id}
        name={props.id}
        className={props.numeric ? "auth-input mono" : "auth-input"}
        type={props.type ?? "text"}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        autoComplete={props.autoComplete}
        inputMode={props.numeric ? "numeric" : undefined}
        maxLength={props.numeric ? 7 : undefined}
        placeholder={props.placeholder}
        aria-invalid={props.invalid || undefined}
        required
      />
    </>
  );
}

/** Where to go after signing in: only a path on this site, never another site's address. */
export function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}
