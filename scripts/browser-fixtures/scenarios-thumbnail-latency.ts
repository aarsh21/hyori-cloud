import { copyFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { uploadFiles } from "./page-actions.ts";
import type { CoreRun } from "./scenarios-core.ts";
import { ownerPage } from "./scenarios-core.ts";
import { chooseSources, createFolder, tileSelector, waitForTrayIdle } from "./scenarios-photos.ts";

const BATCHES = [1, 8, 24];
const SAMPLE_MS = 1000;
const BATCH_DEADLINE_MS = 300_000;

function percentile(values: readonly number[], share: number) {
  const sorted = values.toSorted((first, second) => first - second);

  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0;
}

const seconds = (milliseconds: number) => Number((milliseconds / 1000).toFixed(1));

function shownTiles(page: Page, names: readonly string[]) {
  return page.evaluate(
    (selectors) =>
      selectors.flatMap(({ name, selector }) => {
        const image = document.querySelector(selector)?.querySelector("img");

        return image?.complete === true && image.naturalWidth > 0 ? [name] : [];
      }),
    names.map((name) => ({ name, selector: tileSelector(name) })),
  );
}

async function measureBatch(run: CoreRun, page: Page, size: number, label: string) {
  const { media, stack } = run;

  const waitingJobs = () =>
    Number(
      stack.sql("SELECT count(*) FROM hyori_media_jobs WHERE state IN ('queued','processing')"),
    );

  const original = media.png(`latency-source-${label}.png`, size, "1600x1200");

  const names = Array.from({ length: size }, (_, index) => `latency-${label}-${index}.png`);

  const files = names.map((name) => {
    const copy = join(media.directory, name);

    copyFileSync(original, copy);

    return copy;
  });

  const waitingBefore = waitingJobs();
  const quoted = names.map((name) => `'${name}'`).join(",");

  await uploadFiles(page, files);
  await waitForTrayIdle(run, page, files.length);
  await page.getByRole("link", { name: "Photos" }).first().click();

  const readyAt = new Map<string, number>();
  const shownAt = new Map<string, number>();
  const deadline = Date.now() + BATCH_DEADLINE_MS;

  while (shownAt.size < names.length && Date.now() < deadline) {
    const now = Date.now();

    // A read of the backend's own state to tell its stage apart. Nothing is driven from here.
    const ready = stack.sql(
      `SELECT i.name FROM hyori_media_jobs j JOIN hyori_items i ON i.object_key=j.source_key WHERE j.state='ready' AND i.name IN (${quoted})`,
    );

    for (const name of ready.split("\n").filter(Boolean)) {
      if (!readyAt.has(name)) readyAt.set(name, now);
    }

    for (const name of await shownTiles(page, names)) {
      if (!shownAt.has(name)) shownAt.set(name, now);
    }

    await page.waitForTimeout(SAMPLE_MS);
  }

  const queuedAt = new Map(
    stack
      .sql(
        `SELECT i.name, extract(epoch from j.created_at)*1000 FROM hyori_media_jobs j JOIN hyori_items i ON i.object_key=j.source_key WHERE i.name IN (${quoted})`,
      )
      .split("\n")
      .filter(Boolean)
      .map((row) => {
        const [name = "", at = "0"] = row.split("|");

        return [name, Number(at)] as const;
      }),
  );

  const commitToReady = names.flatMap((name) => {
    const ready = readyAt.get(name);
    const queued = queuedAt.get(name);

    return ready === undefined || queued === undefined ? [] : [ready - queued];
  });

  const readyToShown = names.flatMap((name) => {
    const ready = readyAt.get(name);
    const shown = shownAt.get(name);

    return ready === undefined || shown === undefined ? [] : [Math.max(0, shown - ready)];
  });

  const readyTimes = [...readyAt.values()].toSorted((first, second) => first - second);
  const spanMs = (readyTimes.at(-1) ?? 0) - (readyTimes[0] ?? 0);

  return {
    files: size,
    jobsAlreadyWaiting: waitingBefore,
    ready: readyAt.size,
    shown: shownAt.size,
    commitToServerReadySeconds: {
      p50: seconds(percentile(commitToReady, 0.5)),
      max: seconds(percentile(commitToReady, 1)),
    },
    serverReadyToVisibleTileSeconds: {
      p50: seconds(percentile(readyToShown, 0.5)),
      max: seconds(percentile(readyToShown, 1)),
    },
    secondsBetweenReadyJobs:
      readyTimes.length > 1 ? seconds(spanMs / (readyTimes.length - 1)) : null,
  };
}

/**
 * How long real thumbnails take on this fixture, by stage and queue depth, sampled once a second.
 * It's an observation of a disposable stack on tmpfs on this one machine: not a NAS figure, a budget
 * or a promise. Its own file and scenario keep it from reading as acceptance evidence.
 */
export async function runThumbnailLatencyObservation(run: CoreRun, artifacts: string) {
  const { report } = run;

  if (run.worker === null) {
    report.unverified("thumbnail ready latency", "needs --worker");

    return;
  }

  await report.scenario("Thumbnail ready latency (observation only)", async () => {
    const { context, page } = await ownerPage(run, { viewport: { width: 1280, height: 2400 } });

    await createFolder(page, "Pictures");

    const results = [];

    for (const [index, size] of BATCHES.entries()) {
      if (index === 0) {
        const first = run.media.png("latency-setup.png", 0, "320x240");

        await uploadFiles(page, first);
        await waitForTrayIdle(run, page, 1);
        await chooseSources(run, page, "latency-setup.png");
      }

      await page.getByRole("link", { name: "Files" }).first().click();
      await page.getByRole("link", { name: /^Pictures/ }).click();
      results.push(await measureBatch(run, page, size, `batch${index}`));
    }

    const observation = {
      caveat: "Disposable fixture on tmpfs, sampled once a second. No NAS, budget or speed claim.",
      fixture: {
        cpu: cpus()[0]?.model ?? "unknown",
        hostThreads: cpus().length,
        hostMemoryGb: Math.round(totalmem() / 1024 ** 3),
        workerLimits: "1 CPU, 512 MiB, 64 PIDs, 96 MiB scratch",
        storage: "RustFS and PostgreSQL on tmpfs",
        source: "PNG, 1600x1200, test pattern with noise",
      },
      worker: run.worker,
      results,
    };

    report.observe("thumbnail ready latency", observation);
    writeFileSync(join(artifacts, "thumbnail-latency.json"), JSON.stringify(observation, null, 2));
    await context.close();
  });
}
