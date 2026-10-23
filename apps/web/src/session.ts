import { useSyncExternalStore } from "react";

/**
 * Whether the sign-in of whoever works in this tab ended while they were at it:
 * a call answered 401 after /auth/me had said who they are (main.tsx). The page
 * stays on screen, with what was typed on it, and components/SignInAgain.tsx
 * opens over it until they have signed in again (or signed out).
 */
let ended = false;
const listeners = new Set<() => void>();

const changed = () => listeners.forEach((listener) => listener());

export function signInEnded() {
  if (ended) return;
  ended = true;
  changed();
}

/** Signed in again, signed in anew, or signed out: nothing to ask any more. */
export function signInSettled() {
  if (!ended) return;
  ended = false;
  changed();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useSignInEnded = () => useSyncExternalStore(subscribe, () => ended);
