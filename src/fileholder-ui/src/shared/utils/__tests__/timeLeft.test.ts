import { describe, it, expect } from 'vitest';
import { describeTimeLeft } from '../timeLeft';

const NOW = new Date('2026-10-22T12:00:00Z');
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MS_PER_HOUR = MINUTES_PER_HOUR * MS_PER_MINUTE;
const MS_PER_DAY = HOURS_PER_DAY * MS_PER_HOUR;

const SOME_MINUTES = 5;
const SOME_HOURS = 22;
const TWO = 2;
const DAYS_PER_WEEK = 7;

const FIVE_MINUTES = SOME_MINUTES * MS_PER_MINUTE;
const JUST_UNDER_22_HOURS = SOME_HOURS * MS_PER_HOUR - MS_PER_MINUTE;
const LAST_HOUR_OF_TWO_DAYS = TWO * MS_PER_DAY - MS_PER_HOUR;
const TWO_DAYS = TWO * MS_PER_DAY;
const ONE_WEEK = DAYS_PER_WEEK * MS_PER_DAY;

const after = (ms: number): Date => new Date(NOW.getTime() + ms);

describe('describeTimeLeft', () => {
    it.each([
        ['already passed', -MS_PER_MINUTE, 'now'],
        ['the last seconds', 1, 'in 1 minute'],
        ['minutes', FIVE_MINUTES, 'in 5 minutes'],
        ['an hour', MS_PER_HOUR, 'in 1 hour'],
        ['hours, rounded down', JUST_UNDER_22_HOURS, 'in 21 hours'],
        ['up to two days in hours', LAST_HOUR_OF_TWO_DAYS, 'in 47 hours'],
        ['days after that', TWO_DAYS, 'in 2 days'],
        ['a week', ONE_WEEK, 'in 7 days'],
    ])('%s', (_case, msLeft, expected) => {
        expect(describeTimeLeft(after(msLeft), NOW)).toBe(expected);
    });
});
