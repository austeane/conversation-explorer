export const DISPLAY_TIME_ZONE = "America/Vancouver";

type Granularity = "ymd" | "ym" | "wday" | "hour";

const ymdFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: DISPLAY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const weekdayFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_TIME_ZONE,
  weekday: "short",
});

const hourFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: DISPLAY_TIME_ZONE,
  hour: "2-digit",
  hourCycle: "h23",
});

const localIsoFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: DISPLAY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const weekdayIndex: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function bucket(epochSec: number, granularity: "ymd" | "ym"): string;
export function bucket(epochSec: number, granularity: "wday" | "hour"): number;
export function bucket(epochSec: number, granularity: Granularity): string | number {
  const date = new Date(epochSec * 1000);
  if (granularity === "ymd") return formatYmd(date);
  if (granularity === "ym") return formatYmd(date).slice(0, 7);
  if (granularity === "wday") return weekdayIndex[weekdayFormatter.format(date)] ?? 0;
  return Number(hourFormatter.format(date));
}

export function localIso(epochSec: number): string {
  const parts = dateParts(localIsoFormatter, new Date(epochSec * 1000));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

export function dayBounds(ymd: string): { start: number; end: number } {
  return {
    start: lowerBoundLocalYmd(ymd),
    end: lowerBoundLocalYmd(addDays(ymd, 1)),
  };
}

export function monthBounds(ym: string): { start: number; end: number } {
  const [year, month] = ym.split("-").map(Number);
  const startYmd = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYmd = `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01`;
  return {
    start: lowerBoundLocalYmd(startYmd),
    end: lowerBoundLocalYmd(nextYmd),
  };
}

function formatYmd(date: Date) {
  const parts = dateParts(ymdFormatter, date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function lowerBoundLocalYmd(ymd: string): number {
  const center = Math.floor(Date.parse(`${ymd}T12:00:00Z`) / 1000);
  let lo = center - 48 * 60 * 60;
  let hi = center + 48 * 60 * 60;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (bucket(mid, "ymd") < ymd) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function addDays(ymd: string, days: number): string {
  const date = new Date(`${ymd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateParts(formatter: Intl.DateTimeFormat, date: Date): Record<string, string> {
  return Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
}
