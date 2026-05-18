import { describe, expect, it } from "vitest";
import { phaseFor, phaseOptionFromSeason } from "~/lib/conversation/phases";

describe("conversation phases", () => {
  it("turns materialized season rows into URL date bounds", () => {
    expect(
      phaseOptionFromSeason({
        id: 2,
        label: "Season 3",
        start_ym: "2024-02",
        end_ym: "2024-03",
        method: "monthly-mixture-dp-v1",
      }),
    ).toMatchObject({
      id: "2",
      from: "2024-02-01",
      to: "2024-03-31",
    });
  });

  it("resolves an epoch to the matching Vancouver month phase", () => {
    const phases = [
      { id: "0", start_ym: "2023-12", end_ym: "2023-12" },
      { id: "1", start_ym: "2024-01", end_ym: "2024-03" },
    ];

    expect(phaseFor(Date.UTC(2024, 0, 1, 7, 0, 0) / 1000, phases)).toBe("0");
    expect(phaseFor(Date.UTC(2024, 0, 1, 8, 0, 0) / 1000, phases)).toBe("1");
  });
});

