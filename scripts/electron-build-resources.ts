/**
 * Cross-platform resources copy script
 */

import { existsSync, cpSync } from "fs";
import { join } from "path";
import { copyBundledSubprocessResources, type Arch, type Platform } from "./build/common";

const ROOT_DIR = join(import.meta.dir, "..");
const ELECTRON_DIR = join(ROOT_DIR, "apps/electron");

const srcDir = join(ELECTRON_DIR, "resources");
const destDir = join(ELECTRON_DIR, "dist/resources");

function resolvePlatform(): Platform {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "linux") return "linux";
  if (process.platform === "win32") return "win32";
  throw new Error(`Unsupported platform: ${process.platform}`);
}

function resolveArch(): Arch {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x64";
  throw new Error(`Unsupported architecture: ${process.arch}`);
}

if (existsSync(srcDir)) {
  cpSync(srcDir, destDir, { recursive: true, force: true });
  copyBundledSubprocessResources({
    platform: resolvePlatform(),
    arch: resolveArch(),
    upload: false,
    uploadLatest: false,
    uploadScript: false,
    rootDir: ROOT_DIR,
    electronDir: ELECTRON_DIR,
  }, destDir);
  console.log("📦 Copied resources to dist");
} else {
  console.log("⚠️ No resources directory found");
}
