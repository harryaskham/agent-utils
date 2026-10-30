// Five-field cron schedules (minute hour day-of-month month day-of-week) in a time zone, as AHP
// 1.0's AutomationSchedule has them: the next occurrence is worked out once per firing, never by
// polling. Shared by TUI /cron (a timer to the next occurrence) and pi-daemon's Durable /cron (a
// stored sleep until it).
//
// Fields take `*`, numbers, ranges `a-b`, steps `*/n`, `a-b/n` and `a/n`, and lists `a,b`;
// months and days of the week also take names (jan…dec, sun…sat); a day of the week is 0-7,
// 0 and 7 both Sunday. As in Vixie cron, a day matches when the day of the month or the day of
// the week matches if both are restricted, else when the restricted one does. Macros: @yearly
// (@annually), @monthly, @weekly, @daily (@midnight), @hourly.
//
// Times are wall-clock times in the schedule's IANA time zone. A time a daylight-saving change
// skips does not occur; a time it repeats occurs once, the first time.

const MACROS = Object.freeze({
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
});
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, base: 1 },
  { name: "day of week", min: 0, max: 7, names: DAYS, base: 0 },
];
const MINUTE_MS = 60_000;
/** How far ahead a schedule is searched before it is taken to never fire (Feb 30). */
const SEARCH_YEARS = 8;

function value(text, field) {
  const lower = text.toLowerCase();
  const named = field.names?.indexOf(lower) ?? -1;
  if (named >= 0) return named + field.base;
  if (!/^\d+$/.test(text)) throw new Error(`cron ${field.name}: "${text}" is not a number${field.names ? " or name" : ""}`);
  const number = Number.parseInt(text, 10);
  if (number < field.min || number > field.max) throw new Error(`cron ${field.name}: ${number} is outside ${field.min}-${field.max}`);
  return number;
}

function parseField(text, field) {
  const allowed = new Set();
  for (const part of text.split(",")) {
    if (part === "") throw new Error(`cron ${field.name}: an empty list item`);
    const [range, stepText, extra] = part.split("/");
    if (extra !== undefined) throw new Error(`cron ${field.name}: "${part}" has two steps`);
    const step = stepText === undefined ? 1 : Number.parseInt(stepText, 10);
    if (stepText !== undefined && (!/^\d+$/.test(stepText) || step < 1)) throw new Error(`cron ${field.name}: step "${stepText}" must be a positive number`);
    let from;
    let to;
    if (range === "*") {
      from = field.min;
      to = field.max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      from = value(a, field);
      to = value(b, field);
      if (from > to) throw new Error(`cron ${field.name}: range "${range}" runs backwards`);
    } else {
      from = value(range, field);
      // `a/n`: from a to the end, every n.
      to = stepText === undefined ? from : field.max;
    }
    for (let at = from; at <= to; at += step) allowed.add(at);
  }
  return allowed;
}

/**
 * A parsed schedule: `{ expression, minutes, hours, days, months, weekdays, anyDay, anyWeekday }`
 * (sets), or a thrown Error saying what is wrong.
 */
export function parseCron(expression) {
  const source = String(expression ?? "").trim();
  const expanded = MACROS[source.toLowerCase()] ?? source;
  const parts = expanded.split(/\s+/).filter(Boolean);
  if (parts.length !== 5) throw new Error(`a cron schedule has five fields (minute hour day month weekday), or a macro such as @daily; got "${source}"`);
  const [minutes, hours, days, months, weekdays] = parts.map((part, index) => parseField(part, FIELDS[index]));
  // 7 is Sunday too.
  if (weekdays.has(7)) {
    weekdays.delete(7);
    weekdays.add(0);
  }
  return { expression: source, minutes, hours, days, months, weekdays, anyDay: parts[2] === "*", anyWeekday: parts[4] === "*" };
}

/** Whether `timeZone` is an IANA zone this runtime knows. */
export function validTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The runtime's own time zone. */
export function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const formatters = new Map();
/** The wall-clock fields of `instant` in `timeZone`, as a UTC timestamp of those fields. */
function wallOf(instant, timeZone) {
  let format = formatters.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    formatters.set(timeZone, format);
  }
  const parts = {};
  for (const part of format.formatToParts(new Date(instant))) parts[part.type] = part.value;
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute));
}

/** The first instant whose wall-clock time in `timeZone` is `wall` (a UTC timestamp of its fields), or undefined in a gap. */
function instantOf(wall, timeZone) {
  // The zone's offset near the time, then again at the guess (it may cross a change).
  const first = wall - (wallOf(wall, timeZone) - wall);
  const guess = wall - (wallOf(first, timeZone) - first);
  // A repeated hour: the earlier of the two.
  for (const candidate of [guess - 3_600_000, guess - 1_800_000, guess]) if (wallOf(candidate, timeZone) === wall) return candidate;
  return undefined;
}

function dayMatches(schedule, date) {
  const dom = schedule.days.has(date.getUTCDate());
  const dow = schedule.weekdays.has(date.getUTCDay());
  if (schedule.anyDay && schedule.anyWeekday) return true;
  if (schedule.anyDay) return dow;
  if (schedule.anyWeekday) return dom;
  return dom || dow;
}

/**
 * The first time after `after` (ms) that `schedule` (parsed, or an expression) fires in
 * `timeZone`, in ms; undefined when it never does (such as on February 30).
 */
export function nextCronAt(schedule, timeZone, after) {
  const spec = typeof schedule === "string" ? parseCron(schedule) : schedule;
  const zone = timeZone || "UTC";
  // Wall-clock time, a minute on from `after`'s, its seconds dropped.
  let wall = Math.floor(wallOf(after, zone) / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const limit = wall + SEARCH_YEARS * 366 * 24 * 60 * MINUTE_MS;
  while (wall <= limit) {
    const date = new Date(wall);
    if (!spec.months.has(date.getUTCMonth() + 1)) {
      wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
      continue;
    }
    if (!dayMatches(spec, date)) {
      wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
      continue;
    }
    if (!spec.hours.has(date.getUTCHours())) {
      wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours() + 1);
      continue;
    }
    if (!spec.minutes.has(date.getUTCMinutes())) {
      wall += MINUTE_MS;
      continue;
    }
    const instant = instantOf(wall, zone);
    if (instant !== undefined && instant > after) return instant;
    wall += MINUTE_MS;
  }
  return undefined;
}

/**
 * `/cron` arguments: `<5 fields or @macro> [tz=Zone|--tz Zone] <prompt>`. Returns
 * `{ expression, timeZone?, prompt }`, or throws saying what is wrong. The fields may be quoted.
 */
export function parseCronArgs(args) {
  let text = String(args ?? "").trim();
  let expression;
  const quoted = /^(["'])(.*?)\1\s*/.exec(text);
  if (quoted !== null) {
    expression = quoted[2].trim();
    text = text.slice(quoted[0].length);
  } else if (text.startsWith("@")) {
    expression = text.split(/\s+/)[0];
    text = text.slice(expression.length).trim();
  } else {
    const fields = text.split(/\s+/);
    expression = fields.slice(0, 5).join(" ");
    text = fields.slice(5).join(" ");
  }
  let timeZone;
  const zone = /^(?:tz=(\S+)|--tz\s+(\S+))\s*/.exec(text);
  if (zone !== null) {
    timeZone = zone[1] ?? zone[2];
    text = text.slice(zone[0].length);
  }
  const prompt = text.trim();
  parseCron(expression);
  if (timeZone !== undefined && !validTimeZone(timeZone)) throw new Error(`unknown time zone "${timeZone}" (an IANA name, such as Europe/London)`);
  if (prompt === "") throw new Error("a /cron needs a prompt or command after its schedule");
  return { expression, ...(timeZone === undefined ? {} : { timeZone }), prompt };
}
