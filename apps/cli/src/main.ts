#!/usr/bin/env node

import { MASSION_CLI_NAME } from "./index.js";

export function cliName(): typeof MASSION_CLI_NAME {
  return MASSION_CLI_NAME;
}
