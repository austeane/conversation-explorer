import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { tokenize } from "~/lib/conversation/tokenize";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("tokenizer parity", () => {
  it("keeps TypeScript and Python tokenization aligned", () => {
    const corpus = [
      "I’m going, but 'excited'!",
      "Sick outfit; not a hard-drive issue.",
      "Don't split quoted words or 123s.",
      "this-token-is-way-too-long-for-the-default-max-length-because-it-never-stops",
    ];

    const python = JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          [
            "import json, sys",
            "sys.path.insert(0, 'scripts')",
            "from _shared import tokenize",
            "corpus = json.loads(sys.argv[1])",
            "print(json.dumps([tokenize(text) for text in corpus]))",
          ].join("; "),
          JSON.stringify(corpus),
        ],
        { cwd: root, encoding: "utf8" },
      ),
    ) as string[][];

    expect(python).toEqual(corpus.map((text) => tokenize(text)));
  });
});
