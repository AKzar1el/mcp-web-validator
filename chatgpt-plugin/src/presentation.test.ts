import { describe, expect, it } from "vitest";
import { contentForOverview, type ResultOverview } from "./presentation";

const attackCases = [
  ["# fake heading", "\\# fake heading"],
  ["> fake quote", "&gt; fake quote"],
  ["[click](https://evil.example)", "\\[click\\]\\(https://evil\\.example\\)"],
  ["![image](https://evil.example/x)", "\\!\\[image\\]\\(https://evil\\.example/x\\)"],
  ["<script>alert(1)</script>", "&lt;script&gt;alert\\(1\\)&lt;/script&gt;"],
  ["`inline code`", "\\`inline code\\`"],
  ["``` fenced code block ```", "\\`\\`\\` fenced code block \\`\\`\\`"],
  ["*emphasis*", "\\*emphasis\\*"],
  ["**bold**", "\\*\\*bold\\*\\*"],
  ["- fake list item", "\\- fake list item"],
  ["1. fake list item", "1\\. fake list item"],
  ["| fake | table |", "\\| fake \\| table \\|"],
  ["back\\slash", "back\\\\slash"],
  ["[brackets] (parentheses)", "\\[brackets\\] \\(parentheses\\)"],
  ["multiline\ntext", "multiline text"],
] as const;

const overview: ResultOverview = {
  kind: "html",
  status: "needs_attention",
  title: "HTML validation",
  headline: "HTML validation needs attention.",
  detail: "The detailed result is available in structured content.",
  total: 1,
  shown: 1,
  truncated: false,
  counts: [],
  next_action: "Fix the first finding, then run validation again.",
};

describe("contentForOverview", () => {
  it("keeps untrusted Markdown inert without changing structured findings", () => {
    const structuredContent = {
      issues: [{
        severity: "error" as const,
        message: "[click](https://evil.example)",
        label: "https://example.test/`location`/[brackets]",
      }],
    };
    const originalStructuredContent = structuredClone(structuredContent);

    const text = contentForOverview(overview, structuredContent.issues)[0]?.text ?? "";

    expect(structuredContent).toEqual(originalStructuredContent);
    expect(text).toContain("**Fix first**");
    expect(text).toContain("**Next step:**");
    expect(text.match(/^- \*\*Error/gm)).toHaveLength(1);
    expect(text).not.toContain("[click](https://evil.example)");
    expect(text).toContain("\\[click\\]\\(https://evil\\.example\\)");
    expect(text).toContain("``https://example.test/`location`/[brackets]``");
  });

  it.each(attackCases)("escapes %s in a finding", (message, escaped) => {
    const text = contentForOverview(overview, [{ severity: "error", message }])[0]?.text ?? "";

    expect(text).toContain(escaped);
    expect(text.match(/^- \*\*Error/gm)).toHaveLength(1);
  });
});
