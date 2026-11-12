import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { z } from "zod";

test("browser CI covers every registered non-editor scenario", () => {
  const source = ts.createSourceFile(
    "test-rust-browser.ts",
    readFileSync(new URL("./test-rust-browser.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

  const registered = new Set<string>();

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const selector = ts.isIdentifier(callee) && callee.text === "selected";

      const explicit =
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "only" &&
        callee.name.text === "includes";

      const argument = node.arguments[0];

      if ((selector || explicit) && argument !== undefined && ts.isStringLiteral(argument)) {
        if (argument.text !== "editors") registered.add(argument.text);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(source);

  const workflow = z
    .object({
      jobs: z.object({
        browser: z.object({ steps: z.array(z.object({ run: z.string().optional() })) }),
      }),
    })
    .parse(
      Bun.YAML.parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")),
    );

  const commands = workflow.jobs.browser.steps.map((step) => step.run ?? "").join("\n");
  const list = /for scenarios in ([\s\S]*?); do/.exec(commands)?.[1];

  expect(registered.size).toBeGreaterThan(0);
  expect(list, "browser scenario loop must have an explicit coverage list").toBeDefined();

  const covered = new Set(list?.split(/[,\s\\]+/).filter(Boolean));

  expect([...covered].sort(), "update browser CI when scenario registrations change").toEqual(
    [...registered].sort(),
  );
});
