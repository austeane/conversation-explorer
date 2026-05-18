import { describe, expect, it } from "vitest";
import { redactForExternalModel } from "../src/lib/redact";

describe("external model redaction", () => {
  it("scrubs contact details and likely non-allowed names", () => {
    const email = ["jamie", "example.invalid"].join("@");
    const phone = ["604", "555", "1212"].join("-");
    const result = redactForExternalModel(`Me texted Jamie at ${email} from 123 Main Street, call ${phone}.`);
    expect(result.text).toContain("Me");
    expect(result.text).toContain("[redacted-name]");
    expect(result.text).toContain("[redacted-email]");
    expect(result.text).toContain("[redacted-address]");
    expect(result.text).toContain("[redacted-phone]");
    expect(result.report.name).toBeGreaterThanOrEqual(1);
    expect(result.report.email).toBe(1);
    expect(result.report.address).toBe(1);
    expect(result.report.phone).toBe(1);
  });

  it("leaves Me and Them unredacted", () => {
    const result = redactForExternalModel("Me and Them talked on Friday in Vancouver.");
    expect(result.text).toContain("Me");
    expect(result.text).toContain("Them");
    expect(result.text).not.toContain("[redacted-name]");
  });
});
