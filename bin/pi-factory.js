#!/usr/bin/env node
// Node does not strip TypeScript inside node_modules. Register the runtime loader
// before importing the packaged source so installed and Git-tag installs work.
import { register } from 'tsx/esm/api';

register();
await import('../src/factory-cli.ts');
