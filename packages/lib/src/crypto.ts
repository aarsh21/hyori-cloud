import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function newId(): string {
  return randomBytes(16).toString("hex");
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function constantEqual(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(digest(left), "hex"), Buffer.from(digest(right), "hex"));
}

let activeDerivations = 0;
const derivationWaiters: (() => void)[] = [];

async function derive(password: string, salt: string): Promise<Buffer> {
  // Bound expensive KDF memory across requests rather than trusting account-keyed rate limits alone.
  if (activeDerivations >= 2) {
    if (derivationWaiters.length >= 32) throw new Error("Password verification capacity reached");
    await new Promise<void>((resolve) => derivationWaiters.push(resolve));
  } else activeDerivations++;

  try {
    return await new Promise<Buffer>((resolve, reject) =>
      scrypt(
        password,
        salt,
        64,
        { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
        (error, key) => (error ? reject(error) : resolve(key)),
      ),
    );
  } finally {
    const next = derivationWaiters.shift();

    if (next) next();
    else activeDerivations--;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomToken();

  return `scrypt$32768$${salt}$${(await derive(password, salt)).toString("hex")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, cost, salt, expected] = encoded.split("$");

  if (
    algorithm !== "scrypt" ||
    cost !== "32768" ||
    !salt ||
    !expected ||
    !/^[0-9a-f]{128}$/.test(expected)
  )
    return false;

  return timingSafeEqual(await derive(password, salt), Buffer.from(expected, "hex"));
}
