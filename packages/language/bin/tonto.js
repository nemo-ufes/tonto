#!/usr/bin/env node
import { run } from '../out/cli/index.js';

// Being piped into something that stops reading -- `| head`, a pager quit --
// closes stdout underneath us. That is the reader's decision, not an error.
process.stdout.on('error', error => {
    if (error.code !== 'EPIPE') {
        throw error;
    }
});

process.exitCode = await run(process.argv.slice(2));
