import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isGrantable, isUsed, PERMISSION_CATALOG } from "../src/shared/permission-catalog";
import { ACTIONS, MODULES, type Action, type Module } from "../src/shared/permissions";

// The catalog behind Roles & Permissions must describe the permissions the code
// actually checks: no check outside it, no checkbox that does nothing, and the
// sidebar and route guards of the web app on the same modules. Reads source
// files only; no database.

const API_SRC = resolve(__dirname, "../src");
const WEB_SRC = resolve(__dirname, "../../stslv-web/src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);

    if (statSync(path).isDirectory()) return name === "test" ? [] : sourceFiles(path);

    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Every literal "MODULE:ACTION" the code checks, with the files that check it. */
function checkedPermissions(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const patterns = [
    /authorize\("([A-Z_]+)", "([A-Z]+)"\)/g,
    /has\("([A-Z_]+):([A-Z]+)"\)/g,
    /can\('([A-Z_]+)', '([A-Z]+)'\)/g,
  ];
  const files = [...sourceFiles(API_SRC), ...(existsSync(WEB_SRC) ? sourceFiles(WEB_SRC) : [])];

  for (const file of files) {
    const text = readFileSync(file, "utf8");

    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const key = `${match[1]}:${match[2]}`;
        found.set(key, [...(found.get(key) ?? []), file]);
      }
    }
  }

  return found;
}

const entries = PERMISSION_CATALOG.flatMap((section) => section.modules.map((entry) => ({ ...entry, retired: section.retired === true })));
const entryOf = (module: string) => entries.find((entry) => entry.module === module);

describe("permission catalog", () => {
  it("describes every permission module exactly once", () => {
    expect(entries.map((entry) => entry.module).sort()).toEqual([...MODULES].sort());
  });

  it("covers every permission the API and the web app check", () => {
    const missing = [...checkedPermissions().entries()]
      .filter(([key]) => {
        const [module, action] = key.split(":") as [Module, Action];
        return !(MODULES as readonly string[]).includes(module) || !isUsed(module, action);
      })
      .map(([key, files]) => `${key} (${files.length} place(s), e.g. ${files[0]})`);

    expect(missing).toEqual([]);
  });

  it("offers no action that nothing checks", () => {
    const checked = checkedPermissions();
    // Attachments check their record type's module for VIEW and EDIT through a template string.
    const dynamic = new Set(["AMC_CONTRACTS:VIEW", "AMC_CONTRACTS:EDIT"]);
    const unused = entries.flatMap((entry) =>
      (Object.keys(entry.actions) as Action[]).map((action) => `${entry.module}:${action}`).filter((key) => !checked.has(key) && !dynamic.has(key))
    );

    expect(unused).toEqual([]);
  });

  it("grants nothing new on retired modules, or on actions that are not used", () => {
    expect(isGrantable("AMC_CONTRACTS", "DELETE")).toBe(true);
    expect(isGrantable("AMC_EXECUTION", "APPROVE")).toBe(true);
    expect(isGrantable("DASHBOARD", "CREATE")).toBe(false);
    expect(isGrantable("USERS", "APPROVE")).toBe(true);
    expect(isGrantable("INVOICES", "APPROVE")).toBe(false);
    // SETTINGS keeps only the Settings page (holidays); the master lists have their own modules.
    expect(isGrantable("SETTINGS", "EXPORT")).toBe(false);
    expect(isGrantable("MONTHLY_CALENDAR", "EDIT")).toBe(false);
    expect(isGrantable("PROJECTS", "VIEW")).toBe(false);
    expect(isGrantable("REPORTS", "VIEW")).toBe(false);
    expect(ACTIONS.some((action) => isUsed("REPORTS", action))).toBe(false);
  });
});

describe.skipIf(!existsSync(WEB_SRC))("web app guards match the catalog", () => {
  const pagesOf = (module: string) => entryOf(module)?.pages.map((page) => page.path) ?? [];

  it("puts each sidebar item on the module that governs its page", () => {
    const navigation = readFileSync(join(WEB_SRC, "layout/navigation.ts"), "utf8");
    const items = [...navigation.matchAll(/\{ label: '([^']+)', path: '([^']+)', module: '([A-Z_]+)'(, adminOnly: true)?/g)];

    expect(items.length).toBeGreaterThan(15);

    const wrong = items
      .filter(([, , path, module, adminOnly]) => !adminOnly && !pagesOf(module!).includes(path!))
      .map(([, label, path, module]) => `${label} ${path} on ${module}`);

    expect(wrong).toEqual([]);
  });

  it("guards each page route with the module that governs it", () => {
    const app = readFileSync(join(WEB_SRC, "App.tsx"), "utf8");
    const routes = [...app.matchAll(/path="([^"]+)"\s+element=\{\s+<RequirePermission module="([A-Z_]+)">/g)];

    expect(routes.length).toBeGreaterThan(15);

    const wrong = routes.filter(([, path, module]) => !pagesOf(module!).includes(path!)).map(([, path, module]) => `${path} on ${module}`);

    expect(wrong).toEqual([]);
  });

  it("asks for the further modules a combined page shows, in the sidebar and the route", () => {
    const navigation = readFileSync(join(WEB_SRC, "layout/navigation.ts"), "utf8");
    const app = readFileSync(join(WEB_SRC, "App.tsx"), "utf8");

    for (const entry of entries) {
      for (const page of entry.pages.filter((candidate) => candidate.alsoRequires)) {
        const navItem = navigation.split("\n").find((line) => line.includes(`path: '${page.path}'`));
        const routeBlock = app.slice(app.indexOf(`path="${page.path}"`), app.indexOf("/>", app.indexOf(`path="${page.path}"`)));

        for (const module of [entry.module, ...page.alsoRequires!]) {
          expect(navItem, `${page.path} sidebar`).toContain(`'${module}'`);
          expect(routeBlock, `${page.path} route`).toContain(`module="${module}"`);
        }
      }
    }
  });
});
