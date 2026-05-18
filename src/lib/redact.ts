export type RedactionReport = {
  phone: number;
  email: number;
  address: number;
  name: number;
};

const ALLOWED_NAMES = new Set([
  "Me",
  "Them",
]);

const CAPITALIZED_ALLOWLIST = new Set([
  "I",
  "A",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
  "Vancouver",
]);

export function redactForExternalModel(input: string): { text: string; report: RedactionReport } {
  const report: RedactionReport = { phone: 0, email: 0, address: 0, name: 0 };
  let text = replaceCounted(input, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]", (count) => {
    report.email += count;
  });
  text = replaceCounted(text, /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/g, "[redacted-phone]", (count) => {
    report.phone += count;
  });
  text = replaceCounted(
    text,
    /\b\d{1,6}\s+[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,4}\s+(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Boulevard|Blvd|Lane|Ln|Court|Ct|Place|Pl|Way|Terrace|Trail)\b/g,
    "[redacted-address]",
    (count) => {
      report.address += count;
    },
  );
  text = replaceCounted(text, /\b[A-Z][a-z]{2,}\b/g, (match) => {
    if (ALLOWED_NAMES.has(match) || CAPITALIZED_ALLOWLIST.has(match)) return match;
    report.name += 1;
    return "[redacted-name]";
  });
  return { text, report };
}

function replaceCounted(input: string, pattern: RegExp, replacement: string, onCount: (count: number) => void): string;
function replaceCounted(input: string, pattern: RegExp, replacement: (match: string) => string): string;
function replaceCounted(
  input: string,
  pattern: RegExp,
  replacement: string | ((match: string) => string),
  onCount?: (count: number) => void,
) {
  let count = 0;
  const text = input.replace(pattern, (match) => {
    count += 1;
    return typeof replacement === "function" ? replacement(match) : replacement;
  });
  onCount?.(count);
  return text;
}
