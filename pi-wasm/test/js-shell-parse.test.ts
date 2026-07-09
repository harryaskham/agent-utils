import { describe, expect, it } from "vitest";
import { parse, tokenize } from "../src/exec/js-shell/parse";

describe("js-shell tokenize (S10)", () => {
  it("splits words on whitespace", () => {
    const r = tokenize("ls -la /work");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([
      { kind: "word", value: "ls" },
      { kind: "word", value: "-la" },
      { kind: "word", value: "/work" },
    ]);
  });

  it("keeps single-quoted content literal (incl. operators + spaces)", () => {
    const r = tokenize("echo 'a && b | c'");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([
      { kind: "word", value: "echo" },
      { kind: "word", value: "a && b | c" },
    ]);
  });

  it("handles double quotes with escaped quote + backslash", () => {
    const r = tokenize('echo "a \\"b\\" \\\\c"');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value[1]).toEqual({ kind: "word", value: 'a "b" \\c' });
  });

  it("recognizes operators &&, ||, ;, |, >, >>", () => {
    const r = tokenize("a && b || c ; d | e > f >> g");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const ops = r.value.filter((t) => t.kind === "op").map((t) => t.value);
      expect(ops).toEqual(["&&", "||", ";", "|", ">", ">>"]);
    }
  });

  it("produces an empty-string word for \"\"", () => {
    const r = tokenize('echo ""');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([
      { kind: "word", value: "echo" },
      { kind: "word", value: "" },
    ]);
  });

  it("errors on an unterminated quote", () => {
    expect(tokenize("echo 'oops").ok).toBe(false);
    expect(tokenize('echo "oops').ok).toBe(false);
  });
});

describe("js-shell parse (S10)", () => {
  it("parses a simple command", () => {
    const r = parse("ls -la /work");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.first.commands).toEqual([{ argv: ["ls", "-la", "/work"], redirects: [] }]);
      expect(r.value.rest).toEqual([]);
    }
  });

  it("parses a pipeline", () => {
    const r = parse("cat f | grep x | wc -l");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.first.commands.map((c) => c.argv[0])).toEqual(["cat", "grep", "wc"]);
    }
  });

  it("parses connectors with pipelines", () => {
    const r = parse("cd sub && ls || echo fail ; pwd");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.first.commands[0].argv).toEqual(["cd", "sub"]);
      expect(r.value.rest.map((n) => n.op)).toEqual(["&&", "||", ";"]);
      expect(r.value.rest[2].pipeline.commands[0].argv).toEqual(["pwd"]);
    }
  });

  it("parses redirects onto the owning command", () => {
    const r = parse("echo hi > out.txt");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.first.commands[0]).toEqual({
        argv: ["echo", "hi"],
        redirects: [{ op: ">", target: "out.txt" }],
      });
    }
  });

  it("tolerates a trailing connector", () => {
    const r = parse("echo hi ;");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.first.commands[0].argv).toEqual(["echo", "hi"]);
  });

  it("errors on an empty pipeline segment and a dangling redirect", () => {
    expect(parse("cat f | | wc").ok).toBe(false);
    expect(parse("echo hi >").ok).toBe(false);
  });

  it("returns an empty command line for whitespace only", () => {
    const r = parse("   ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.first.commands).toEqual([]);
  });
});
