#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destinationArg = process.argv[2];
if (!destinationArg) {
	throw new Error("Usage: craft-stage-runtime.mjs <destination>");
}

const destinationRoot = path.resolve(process.cwd(), destinationArg);
const packageJsonPath = path.join(packageRoot, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
if (!Array.isArray(packageJson.files)) {
	throw new Error(`Expected a files allowlist in ${packageJsonPath}`);
}
const runtimeEntries = ["package.json", ...packageJson.files];
const optionalEntries = new Set(["prebuilt/windows"]);

rmSync(destinationRoot, { recursive: true, force: true });
mkdirSync(destinationRoot, { recursive: true });

for (const entry of runtimeEntries) {
	const source = path.join(packageRoot, entry);
	if (!existsSync(source)) {
		if (optionalEntries.has(entry)) continue;
		throw new Error(`Missing required pi-computer-use runtime entry: ${entry}`);
	}
	const destination = path.join(destinationRoot, entry);
	mkdirSync(path.dirname(destination), { recursive: true });
	cpSync(source, destination, { recursive: true });
}
