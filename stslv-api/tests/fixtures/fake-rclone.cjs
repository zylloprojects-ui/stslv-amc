#!/usr/bin/env node
// A stand-in for rclone's Google Drive commands, for tests only (src/ops/backup/rclone-store.ts). It keeps "My Drive"
// in a folder (FAKE_RCLONE_ROOT/mydrive), folder IDs in FAKE_RCLONE_ROOT/ids.json ({ "<id>": "<path in mydrive>" })
// and the trash in FAKE_RCLONE_ROOT/trash. Supports: lsjson, copyto, deletefile, mkdir, about.
// Fault injection: FAKE_RCLONE_FAIL=auth|quota|rate [FAKE_RCLONE_FAIL_ON=<command>]; FAKE_RCLONE_CORRUPT=1 (uploads
// arrive altered); FAKE_RCLONE_LOG=<file> (one line per call).
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = process.env.FAKE_RCLONE_ROOT;
const DRIVE = path.join(ROOT, "mydrive");
const TRASH = path.join(ROOT, "trash");
const ids = () => JSON.parse(fs.readFileSync(path.join(ROOT, "ids.json"), "utf8"));

const args = process.argv.slice(2);
if (process.env.FAKE_RCLONE_LOG) fs.appendFileSync(process.env.FAKE_RCLONE_LOG, `${args.filter((a) => !a.includes("config")).join(" ")}\n`);
const VALUED = new Set(["--config", "--retries", "--low-level-retries", "--retries-sleep", "--stats", "--log-level", "--drive-root-folder-id", "--hash-type"]);
// Like real rclone, an unknown flag is an error: every flag here was checked against rclone 1.76 ("rclone help
// flags" and the command's --help) on the VPS, 2026-11-18. ("--retry-sleep" had slipped through a lenient stand-in;
// the real flag is --retries-sleep.)
const SWITCHES = new Set(["--use-json-log", "--dirs-only", "--files-only", "--no-modtime", "--hash", "--json", "--immutable", "--no-update-modtime", "--drive-use-trash"]);
const flags = new Map();
const positional = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  const name = arg.split("=")[0];
  if (VALUED.has(arg)) flags.set(arg, args[++i]);
  else if (SWITCHES.has(name) || arg === "-R") flags.set(name, true);
  else if (arg.startsWith("-")) {
    process.stderr.write(`Error: unknown flag: ${name}\nUsage:\n  rclone [flags]\n`);
    process.exit(1);
  } else positional.push(arg);
}
const [command, ...rest] = positional;

function fail(message, code = 1) {
  process.stderr.write(`${new Date().toISOString()} ERROR : ${message}\n`);
  process.exit(code);
}

const failure = process.env.FAKE_RCLONE_FAIL;
if (failure && (!process.env.FAKE_RCLONE_FAIL_ON || process.env.FAKE_RCLONE_FAIL_ON === command)) {
  if (failure === "auth") fail('Failed to create file system: couldn\'t fetch token: invalid_grant: maybe token expired? - try refreshing with "rclone config reconnect" {"refresh_token":"SHOULD-BE-REDACTED"}');
  if (failure === "quota") fail("googleapi: Error 403: The user's Drive storage quota has been exceeded., storageQuotaExceeded");
  if (failure === "rate") fail("googleapi: Error 403: User Rate Limit Exceeded, userRateLimitExceeded");
}

const isRemote = (p) => /^[A-Za-z0-9_.-]+:/.test(p) && !/^[A-Za-z]:[\\/]/.test(p);
function local(remotePath) {
  const inner = remotePath.slice(remotePath.indexOf(":") + 1);
  const rootId = flags.get("--drive-root-folder-id");
  const base = rootId ? path.join(DRIVE, ids()[rootId] ?? `__missing_${rootId}`) : DRIVE;
  if (rootId && !ids()[rootId]) fail("directory not found", 3);
  return path.join(base, ...inner.split("/").filter(Boolean));
}
const idOf = (full) => Object.entries(ids()).find(([, rel]) => path.join(DRIVE, rel) === full)?.[0];
const md5 = (file) => crypto.createHash("md5").update(fs.readFileSync(file)).digest("hex");

function entry(full, rel) {
  const info = fs.statSync(full);
  const out = { Path: rel, Name: path.basename(full), Size: info.isDirectory() ? -1 : info.size, ModTime: info.mtime.toISOString(), IsDir: info.isDirectory() };
  const id = idOf(full);
  if (id) out.ID = id;
  if (flags.get("--hash") && !info.isDirectory()) out.Hashes = { md5: md5(full) };
  return out;
}

switch (command) {
  case "lsjson": {
    const target = local(rest[0]);
    if (!fs.existsSync(target)) fail("directory not found", 3);
    const out = [];
    const walk = (dir, prefix) => {
      for (const name of fs.readdirSync(dir).sort()) {
        const full = path.join(dir, name);
        const rel = prefix ? `${prefix}/${name}` : name;
        const isDir = fs.statSync(full).isDirectory();
        if ((isDir && !flags.get("--files-only")) || (!isDir && !flags.get("--dirs-only"))) out.push(entry(full, rel));
        if (isDir && flags.get("-R")) walk(full, rel);
      }
    };
    if (fs.statSync(target).isDirectory()) walk(target, "");
    else out.push(entry(target, path.basename(target)));
    // Drive allows several folders with one name: FAKE_RCLONE_EXTRA_TOP adds such entries to My Drive's top level.
    if (target === DRIVE && process.env.FAKE_RCLONE_EXTRA_TOP) out.push(...JSON.parse(process.env.FAKE_RCLONE_EXTRA_TOP));
    process.stdout.write(JSON.stringify(out));
    break;
  }
  case "copyto": {
    const [src, dst] = rest;
    const from = isRemote(src) ? local(src) : src;
    const to = isRemote(dst) ? local(dst) : dst;
    if (!fs.existsSync(from)) fail("object not found", 3);
    if (fs.existsSync(to) && flags.get("--immutable") && md5(to) !== md5(from)) fail("Source and destination exist but do not match: immutable file modified");
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    if (process.env.FAKE_RCLONE_CORRUPT && isRemote(dst)) fs.appendFileSync(to, "x");
    break;
  }
  case "deletefile": {
    const target = local(rest[0]);
    if (!fs.existsSync(target)) fail("object not found", 3);
    fs.mkdirSync(TRASH, { recursive: true });
    fs.renameSync(target, path.join(TRASH, `${Date.now()}-${path.basename(target)}`));
    break;
  }
  case "mkdir":
    fs.mkdirSync(local(rest[0]), { recursive: true });
    break;
  case "about":
    process.stdout.write(JSON.stringify({ total: 16106127360, used: 1073741824, free: Number(process.env.FAKE_RCLONE_FREE ?? 15032385536), trashed: 0 }));
    break;
  default:
    fail(`unknown command ${command}`, 2);
}
