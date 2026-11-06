#!/usr/bin/env node
// Live contract check: compares the four public GPT Image 2.6 schemas and the
// pricing-row structure with the constants shipped in this package.
// It never compares amounts, so a price change is not a contract break.
import { checkLiveContract } from "./lib/api.mjs";

const result = await checkLiveContract();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 2;
