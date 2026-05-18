import { describe, expect, it } from "vitest";
import { bucket, dayBounds, localIso, monthBounds } from "~/lib/conversation/time";

function epoch(iso: string) {
  return Date.parse(iso) / 1000;
}

describe("Vancouver time bucketing", () => {
  it("does not use the host machine timezone for date buckets", () => {
    expect(bucket(epoch("2024-01-01T07:00:00Z"), "ymd")).toBe("2023-12-31");
    expect(bucket(epoch("2024-01-01T07:00:00Z"), "ym")).toBe("2023-12");
  });

  it("handles the spring DST gap", () => {
    expect(bucket(epoch("2024-03-10T09:30:00Z"), "hour")).toBe(1);
    expect(bucket(epoch("2024-03-10T10:30:00Z"), "hour")).toBe(3);
  });

  it("keeps weekday indexes aligned with Sunday zero", () => {
    expect(bucket(epoch("2024-01-01T20:00:00Z"), "wday")).toBe(1);
    expect(bucket(epoch("2024-01-07T20:00:00Z"), "wday")).toBe(0);
  });

  it("returns Vancouver day and month epoch bounds", () => {
    expect(dayBounds("2024-01-01")).toEqual({
      start: epoch("2024-01-01T08:00:00Z"),
      end: epoch("2024-01-02T08:00:00Z"),
    });
    expect(monthBounds("2024-03")).toEqual({
      start: epoch("2024-03-01T08:00:00Z"),
      end: epoch("2024-04-01T07:00:00Z"),
    });
  });

  it("formats local ISO strings for ETL date columns", () => {
    expect(localIso(epoch("2024-01-01T07:30:15Z"))).toBe("2023-12-31T23:30:15");
  });
});
