const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MS_PER_HOUR = MS_PER_MINUTE * MINUTES_PER_HOUR;
const MS_PER_DAY = MS_PER_HOUR * HOURS_PER_DAY;
// Up to two days, hours read better than "in 1 day" for something that ends tomorrow evening.
const DAYS_SHOWN_IN_HOURS = 2;
const HOURS_SHOWN_UP_TO = DAYS_SHOWN_IN_HOURS * HOURS_PER_DAY;

const plural = (count: number, unit: string): string => `${count} ${unit}${count === 1 ? '' : 's'}`;

/**
 * How long until `end`, rounded down so it never promises more time than is left: "in 21 hours", "in 3 days",
 * "in 5 minutes" (rounded up there, so the last minute still reads "in 1 minute"), or "now" once it has passed.
 */
export function describeTimeLeft(end: Date, now: Date = new Date()): string {
    const msLeft = end.getTime() - now.getTime();
    if (msLeft <= 0) return 'now';
    if (msLeft < MS_PER_HOUR) return `in ${plural(Math.ceil(msLeft / MS_PER_MINUTE), 'minute')}`;
    const hours = Math.floor(msLeft / MS_PER_HOUR);
    if (hours < HOURS_SHOWN_UP_TO) return `in ${plural(hours, 'hour')}`;
    return `in ${plural(Math.floor(msLeft / MS_PER_DAY), 'day')}`;
}

/** The moment itself in the viewer's locale, short: "Oct 23, 14:30" (or "23 Oct, 14:30"). */
export function formatShortDateTime(date: Date): string {
    return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
