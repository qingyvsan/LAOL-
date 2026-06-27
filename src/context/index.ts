// ============================================================
// Context Provider System — Barrel Export
// ============================================================

export { ContextManager } from "./manager";
export type { ContextProvider, ProviderFactory } from "./provider";

// Individual providers
export { TypeScriptProvider } from "./providers/typescript-provider";
export { ESLintProvider } from "./providers/eslint-provider";
export { TestProvider } from "./providers/test-provider";
export { GitProvider } from "./providers/git-provider";
export { CustomProvider } from "./providers/custom-provider";
export { PythonProvider } from "./providers/python-provider";
export { CodebaseProvider } from "./providers/codebase-provider";
