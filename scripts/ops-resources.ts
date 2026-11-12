// Linux/cgroup-v2 production-stack sizing drill. Uses the public SDK through the TLS gateway.
// bun scripts/ops-resources.ts --origin … --ca … --manifest … --project … --env-file …
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connect,
  diskFile,
  hashStream,
  login,
  options,
  readManifest,
  sha256File,
  writeRandomFile,
} from "./ops-client.ts";

const args = options();
const gateway = args.gateway();
const manifest = await readManifest(args.get("manifest"));
const project = args.get("project", "hyori-cloud-rust");
const envFile = args.get("env-file", ".env.deployment");
const services = ["postgres", "rustfs", "backend", "web", "media-worker"];

const cgroups = services.map((service) => {
  const id = execFileSync(
    "docker",
    ["compose", "--env-file", envFile, "-p", project, "ps", "-q", service],
    { encoding: "utf8" },
  ).trim();

  const pid = execFileSync("docker", ["inspect", "-f", "{{.State.Pid}}", id], {
    encoding: "utf8",
  }).trim();

  const path = readFileSync(`/proc/${pid}/cgroup`, "utf8").trim().split("::")[1]!;

  return {
    service,
    path: `/sys/fs/cgroup${path}`,
    rawBytes: 0,
    workingBytes: 0,
    pids: 0,
    cpuPercent: 0,
    previousCpu: 0,
    previousAt: 0,
  };
});

function sample() {
  for (const entry of cgroups) {
    const raw = Number(readFileSync(join(entry.path, "memory.current"), "utf8"));
    const stat = readFileSync(join(entry.path, "memory.stat"), "utf8");
    const cache = Number(/^inactive_file (\d+)$/m.exec(stat)?.[1] ?? 0);

    const cpu = Number(
      /^usage_usec (\d+)$/m.exec(readFileSync(join(entry.path, "cpu.stat"), "utf8"))![1],
    );

    const now = performance.now();

    entry.rawBytes = Math.max(entry.rawBytes, raw);
    entry.workingBytes = Math.max(entry.workingBytes, raw - cache);
    entry.pids = Math.max(
      entry.pids,
      Number(readFileSync(join(entry.path, "pids.current"), "utf8")),
    );

    if (entry.previousAt)
      entry.cpuPercent = Math.max(
        entry.cpuPercent,
        (cpu - entry.previousCpu) / ((now - entry.previousAt) * 10),
      );
    entry.previousAt = now;
    entry.previousCpu = cpu;
  }
}

const directory = mkdtempSync(join(tmpdir(), "hyori-resource-drill-"));
const owner = await login(gateway, manifest.owner.email, manifest.owner.password);
const password = randomBytes(24).toString("hex");
const accounts = [];

for (let index = 0; index < 8; index++) {
  const email = `resource-${Date.now()}-${index}@hyori.test`;
  await owner.sdk.rpc.admin.createUser({ email, name: "Resource drill", password });
  accounts.push(email);
}

sample();

const sampler = setInterval(sample, 100);
const from = performance.now();

try {
  const path = join(directory, "large.bin");
  const expected = await writeRandomFile(path, 160 * 1024 * 1024 + 3);
  const largeName = `resource-${Date.now()}.bin`;

  const large = await owner.sdk.uploads.start({
    parentId: manifest.folders.Documents!,
    file: diskFile(path, largeName),
  }).result;

  const read = await hashStream((await owner.sdk.downloads.open({ id: large.id })).stream);
  assert.equal(read.sha256, expected);
  manifest.files.push({
    id: large.id,
    path: `Documents/${largeName}`,
    size: read.bytes,
    sha256: expected,
    versions: [],
  });
  console.log(`160 MiB upload and readback INTACT: ${read.bytes} B`);
  const photo = join(directory, "photo.jpg");
  execFileSync("magick", ["-size", "2400x1600", "plasma:fractal", "-quality", "88", photo]);
  const photoHash = await sha256File(photo);
  const ids: string[] = [];

  for (let index = 0; index < 12; index++) {
    const name = `resource-${Date.now()}-${index}.jpg`;

    const item = await owner.sdk.uploads.start({
      parentId: manifest.folders.Photos!,
      file: diskFile(photo, name, "image/jpeg"),
    }).result;

    ids.push(item.id);
    manifest.files.push({
      id: item.id,
      path: `Photos/${name}`,
      size: Bun.file(photo).size,
      sha256: photoHash,
      versions: [],
    });
  }

  const deadline = Date.now() + 180_000;

  for (;;) {
    const states = await Promise.all(ids.map((id) => owner.sdk.rpc.media.get({ id })));

    if (states.every((state) => state.status === "ready")) {
      for (const state of states) {
        assert.ok(state.url);
        const response = await owner.send(new URL(state.url, gateway.origin));
        assert.equal(response.status, 200);
        assert.ok((await response.arrayBuffer()).byteLength > 0);
      }

      break;
    }

    assert.ok(Date.now() < deadline, "12 thumbnails did not become ready");
    await Bun.sleep(500);
  }

  console.log("12 new 2400×1600 photo thumbnails READY and downloaded");
  await Promise.all(
    accounts.map(async (email) => {
      const session = connect(gateway);

      try {
        const user = await session.sdk.rpc.auth.login({ email, password });
        assert.equal(user.email, email);
      } finally {
        session.sdk.dispose();
      }
    }),
  );
  // Include every acknowledged file from this run in subsequent crash and restore verification.
  await Bun.write(args.get("manifest"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log("8 concurrent independent-account sign-ins PASSED");
} finally {
  clearInterval(sampler);
  sample();
  owner.sdk.dispose();
  rmSync(directory, { recursive: true, force: true });
  console.log(
    JSON.stringify(
      {
        seconds: (performance.now() - from) / 1000,
        sampleMs: 100,
        peaks: cgroups.map(({ service, rawBytes, workingBytes, pids, cpuPercent }) => ({
          service,
          rawMiB: rawBytes / 1048576,
          workingMiB: workingBytes / 1048576,
          pids,
          cpuPercent,
        })),
      },
      null,
      2,
    ),
  );
}
