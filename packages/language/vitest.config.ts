import { defineConfig } from 'vitest/config';

// Windows runners take several times as long to start a session; a test that
// times out keeps running, and the command-line tests' captured output then
// gathers what it goes on printing.
export default defineConfig({ test: { testTimeout: 30_000 } });
