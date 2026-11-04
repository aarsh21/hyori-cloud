import { createServer } from "node:net";
import { z } from "zod";

const BoundAddress = z.object({ port: z.number().int().min(1).max(65535) });

export async function availablePort(): Promise<number> {
  const server = createServer();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    return BoundAddress.parse(server.address()).port;
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
