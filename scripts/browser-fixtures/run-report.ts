import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConsoleMessage, Page } from "playwright-core";

type Verdict = "pass" | "fail" | "unverified";

type Entry = {
  readonly scenario: string;
  readonly name: string;
  readonly verdict: Verdict;
  readonly detail?: string;
};

/** What a measurement can hold, so the report stays plain JSON. */
export type Observed =
  | string
  | number
  | boolean
  | null
  | readonly Observed[]
  | { readonly [key: string]: Observed };

const NOISE = [/Download the React DevTools/];

/** Keeps going after a failure so one bug doesn't hide the rest, and says exactly what ran. */
export type BrowserFailure = {
  readonly at: number;
  readonly scenario: string;
  readonly request: string;
  readonly reason: string;
};

export function createRunReport(
  directory: string,
  { captureFailures = true }: { captureFailures?: boolean } = {},
) {
  mkdirSync(directory, { recursive: true });

  const entries: Entry[] = [];
  const observations: Record<string, Observed> = {};
  const consoleProblems: string[] = [];
  const browserFailures: BrowserFailure[] = [];
  let scenario = "startup";
  let shotIndex = 0;
  let lastPage: Page | undefined;

  function record(name: string, verdict: Verdict, detail?: string) {
    entries.push({ scenario, name, verdict, detail });
    console.log(`  ${verdict.toUpperCase().padEnd(10)} ${name}${detail ? `: ${detail}` : ""}`);
  }

  async function failureShot(name: string) {
    if (!captureFailures || lastPage === undefined || lastPage.isClosed()) return;

    shotIndex += 1;
    observations[`failure ${shotIndex}: ${name}`] = {
      at: Date.now(),
      url: lastPage.url(),
    };

    const safe = name.replace(/[^a-z0-9]+/gi, "-").slice(0, 60);

    await lastPage
      .screenshot({
        path: join(directory, `${String(shotIndex).padStart(2, "0")}-FAILED-${safe}.png`),
      })
      .catch(() => undefined);
  }

  function watch(page: Page) {
    lastPage = page;
    page.on("console", (message: ConsoleMessage) => {
      if (message.type() !== "error" && message.type() !== "warning") return;

      const text = message.text();

      if (NOISE.some((pattern) => pattern.test(text))) return;
      consoleProblems.push(
        `[${scenario}] ${new Date().toISOString()} ${message.type()}: ${text.slice(0, 400)}`,
      );
    });
    page.on("pageerror", (error) => {
      consoleProblems.push(
        `[${scenario}] ${new Date().toISOString()} pageerror: ${error.message.slice(0, 400)}`,
      );
    });
    // Each failed request's own reason, which a console line alone doesn't tie to a request.
    page.on("requestfailed", (request) => {
      browserFailures.push({
        at: Date.now(),
        scenario,
        request: `${request.method()} ${new URL(request.url()).pathname}`,
        reason: request.failure()?.errorText ?? "unknown",
      });
    });
    page.on("download", (download) => {
      void download.failure().then((reason) => {
        if (reason === null) return;

        browserFailures.push({
          at: Date.now(),
          scenario,
          request: `download ${new URL(download.url()).pathname}`,
          reason,
        });
      });
    });
  }

  return {
    directory,
    record,
    watch,
    consoleProblems,
    browserFailures,
    observe(name: string, value: Observed) {
      observations[name] = value;
      console.log(`  OBSERVED   ${name}: ${JSON.stringify(value)}`);
    },
    unverified(name: string, why: string) {
      record(name, "unverified", why);
    },
    /** `captureFailure: false` keeps a subject off disk even if the check fails on it. */
    async check(
      name: string,
      run: () => void | Promise<void>,
      { captureFailure = true }: { captureFailure?: boolean } = {},
    ) {
      try {
        await run();
        record(name, "pass");

        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message.split("\n")[0] : String(error);

        // Include the caller: rowMenu alone cannot distinguish opening a file from downloading it.
        // Keep source locations, not locator arguments or protected document content.
        const steps =
          error instanceof Error &&
          error.stack?.match(/browser-fixtures\/[\w/-]+\.ts:\d+:\d+/g)?.slice(0, 4);

        record(name, "fail", steps ? `${message} (${steps.join(" ← ")})` : message);

        if (captureFailure) await failureShot(name);

        return false;
      }
    },
    async scenario(
      name: string,
      run: () => Promise<void>,
      { captureFailure = true }: { captureFailure?: boolean } = {},
    ) {
      scenario = name;
      console.log(`\n${name}`);

      try {
        await run();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);

        record("scenario stopped early", "fail", detail.split("\n").slice(0, 3).join(" "));

        if (captureFailure) await failureShot(`${name} stopped`);
      }
    },
    async shot(page: Page, name: string) {
      shotIndex += 1;

      const path = join(directory, `${String(shotIndex).padStart(2, "0")}-${name}.png`);

      await page.screenshot({ path, animations: "disabled" });

      return path;
    },
    finish(extra: Record<string, Observed>) {
      const failed = entries.filter((entry) => entry.verdict === "fail");
      const unverified = entries.filter((entry) => entry.verdict === "unverified");

      const report = {
        ...extra,
        counts: {
          pass: entries.filter((entry) => entry.verdict === "pass").length,
          fail: failed.length,
          unverified: unverified.length,
        },
        entries,
        observations,
        consoleProblems,
      };

      writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2));
      console.log(
        `\n${report.counts.pass} passed, ${failed.length} failed, ${unverified.length} unverified`,
      );
      console.log(`Artifacts: ${directory}`);

      return failed.length;
    },
  };
}

export type RunReport = ReturnType<typeof createRunReport>;
