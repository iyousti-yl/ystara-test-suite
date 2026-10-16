import "./fonts";
import "./locale";
import "./theme";
import "./icons";
import "./app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@ui5/webcomponents-react";
import { RouterProvider } from "react-router";
import { isUnauthorized, ME } from "./api";
import { router } from "./App";

/**
 * Entry point: fonts and theme first, then the data cache, UI5 and the router.
 * A 401 on any call means the sign-in ended (expired, signed out elsewhere, or
 * removed from the account): asking for /auth/me again lets App.tsx show the sign-in page.
 */
const signInEnded = (error: Error) => {
  if (isUnauthorized(error)) void queryClient.invalidateQueries({ queryKey: ME });
};
const queryClient: QueryClient = new QueryClient({
  defaultOptions: { queries: { retry: (count, error) => !isUnauthorized(error) && count < 1, refetchOnWindowFocus: false } },
  queryCache: new QueryCache({ onError: (error, query) => query.queryKey[0] !== ME[0] && signInEnded(error) }),
  mutationCache: new MutationCache({ onError: signInEnded }),
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <RouterProvider router={router} />
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
