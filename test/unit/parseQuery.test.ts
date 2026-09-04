import { describe, it, expect } from "vitest";
import { parseList } from "../../server/utils/parseQuery";

describe("parseList", () => {
  it("returns undefined for missing / empty values", () => {
    expect(parseList(undefined)).toBeUndefined();
    expect(parseList("")).toBeUndefined();
    expect(parseList([])).toBeUndefined();
  });

  it("splits a comma-separated string (GET single key form)", () => {
    expect(parseList("quark,pan123, pan115")).toEqual([
      "quark",
      "pan123",
      "pan115",
    ]);
  });

  it("handles an array (GET repeated-key form, e.g. cloud_types=q&cloud_types=p)", () => {
    expect(parseList(["quark", "pan123", "pan115"])).toEqual([
      "quark",
      "pan123",
      "pan115",
    ]);
  });

  it("re-splits elements that themselves contain commas (mixed form)", () => {
    expect(parseList(["quark,pan123", "pan115"])).toEqual([
      "quark",
      "pan123",
      "pan115",
    ]);
  });

  it("drops empty / whitespace-only entries", () => {
    expect(parseList(["", "quark", ",", "  "])).toEqual(["quark"]);
  });

  it("accepts a single-element array", () => {
    expect(parseList(["baiduPan"])).toEqual(["baiduPan"]);
  });
});
