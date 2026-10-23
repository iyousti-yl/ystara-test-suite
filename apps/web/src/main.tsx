import "./fonts";
import { applyBrand } from "./brand";
import "./locale";
import "./theme";
import "./icons";
import "./app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@ui5/webcomponents-react";
import { RouterProvider } from "react-router";
import { ApiError, ME, SignInEnded } from "./api";
import { trackActivity } from "./activity";
import { router } from "./App";
import { signInEnded } from "./session";

/**
 * Entry point: fonts, the youlytics brand and the theme first, then the data cache, UI5 and the router.
 * A 401 on any call made while signed in means the sign-in ended (an hour without use, signed out
 * elsewhere, or removed from the account): "Your sign-in ended" opens over the page (session.ts), which
 * keeps what was typed on it. A refused call (4xx) isn't tried again; one that got no answer, or a
 * server error, is tried once more.
 */
applyBrand();
trackActivity(window);
const onError = (error: Error) => {
  if (error instanceof SignInEnded && queryClient.getQueryData(ME)) signInEnded();
};
const queryClient: QueryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 1, refetchOnWindowFocus: false },
  },
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
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
