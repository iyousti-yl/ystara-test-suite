import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "tools/spike/output/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  // The web app: the rules of React hooks (call them unconditionally, list every dependency).
  { files: ["apps/web/**/*.{ts,tsx}"], ...reactHooks.configs.flat.recommended },
);
