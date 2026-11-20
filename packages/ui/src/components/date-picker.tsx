"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { cn } from "@hyori-cloud/ui/lib/utils";
import { CalendarDaysIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import * as React from "react";

/**
 * A shared month-grid picker for local calendar days, in the `YYYY-MM-DD` form a date input takes.
 * Choosing a day selects it and closes. Clearing belongs to the owner: a picker that can empty its
 * own value would make quick choices like "No end date" impossible to express.
 */

// 2026-11-01 is a Sunday, so this anchor fixes the week's order the way `Date.getDay` counts it.
const WEEK_ANCHOR = new Date(2026, 10, 1);

const dayLabelFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "long" });
const triggerLabelFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const monthLabelFormat = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "narrow" });
const weekdayLongFormat = new Intl.DateTimeFormat(undefined, { weekday: "long" });

const WEEKDAYS = Array.from({ length: 7 }, (_, index) =>
  weekdayFormat.format(new Date(WEEK_ANCHOR.getFullYear(), WEEK_ANCHOR.getMonth(), 1 + index)),
);

function toLocalDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${date.getFullYear()}-${month}-${day}`;
}

function dayNumber(day: string): number {
  return Number(day.slice(8));
}

function monthOf(day: string): string {
  return day.slice(0, 7);
}

/** The same numbered day one or more months away, clamped when the month is shorter. */
function monthStep(day: string, months: number): string {
  const date = new Date(`${day}T00:00`);
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const length = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();

  target.setDate(Math.min(dayNumber(day), length));

  return toLocalDay(target);
}

function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T00:00`);
  date.setDate(date.getDate() + days);

  return toLocalDay(date);
}

/** Six weeks from the first of the month, padded to whole weeks, so the grid never resizes. */
function monthGrid(month: string): (string | null)[][] {
  const first = new Date(`${month}-01T00:00`);
  const weeks: (string | null)[][] = [];
  let week: (string | null)[] = Array.from({ length: first.getDay() }, () => null);
  const cursor = new Date(first);

  while (monthOf(toLocalDay(cursor)) === month) {
    week.push(toLocalDay(cursor));
    cursor.setDate(cursor.getDate() + 1);

    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }

  if (week.length > 0) {
    while (week.length < 7) week.push(null);
    weeks.push(week);
  }

  return weeks;
}

function DatePicker({
  label,
  value,
  min,
  onValueChange,
  className,
}: {
  /** Names the field for assistive technology; the trigger shows the date itself. */
  label: string;
  /** The local day currently chosen, or nothing chosen yet. */
  value: string | null;
  /** Days before this can't be chosen. */
  min?: string;
  onValueChange: (day: string) => void;
  className?: string;
}) {
  const today = toLocalDay(new Date());
  const [open, setOpen] = React.useState(false);
  const [viewMonth, setViewMonth] = React.useState(() => monthOf(value ?? min ?? today));
  const [focusedDay, setFocusedDay] = React.useState(() => value ?? min ?? today);
  const gridRef = React.useRef<HTMLDivElement>(null);

  if (value !== null && monthOf(value) !== viewMonth) {
    // The owner changed the day out from under the grid; follow it rather than showing a month
    // the chosen day isn't in.
    setViewMonth(monthOf(value));
    setFocusedDay(value);
  }

  React.useEffect(() => {
    if (!open) return;

    gridRef.current
      ?.querySelector<HTMLButtonElement>("button[tabindex='0']")
      ?.focus({ preventScroll: true });
  }, [open, viewMonth]);

  function choose(day: string) {
    onValueChange(day);
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    const column = new Date(`${focusedDay}T00:00`).getDay();
    let next: string | undefined;

    switch (event.key) {
      case "ArrowLeft":
        next = shiftDay(focusedDay, -1);
        break;
      case "ArrowRight":
        next = shiftDay(focusedDay, 1);
        break;
      case "ArrowUp":
        next = shiftDay(focusedDay, -7);
        break;
      case "ArrowDown":
        next = shiftDay(focusedDay, 7);
        break;
      case "Home":
        next = shiftDay(focusedDay, -column);
        break;
      case "End":
        next = shiftDay(focusedDay, 6 - column);
        break;
      case "PageUp":
        next = monthStep(focusedDay, -1);
        break;
      case "PageDown":
        next = monthStep(focusedDay, 1);
        break;
      default:
        return;
    }

    event.preventDefault();
    setFocusedDay(next);
    setViewMonth(monthOf(next));
  }

  const weeks = monthGrid(viewMonth);

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        type="button"
        aria-label={`${label}, ${value === null ? "no day chosen" : dayLabelFormat.format(new Date(`${value}T00:00`))}`}
        className={cn(
          "inline-flex h-8 min-w-0 items-center justify-between gap-1.5 rounded-lg border border-input bg-card px-2.5 text-[13px] whitespace-nowrap shadow-(--shadow-control) transition-[background-color,border-color,box-shadow] duration-150 outline-none select-none hover:bg-accent focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 coarse:h-11",
          className,
        )}
      >
        <CalendarDaysIcon aria-hidden className="size-3.5 text-muted-foreground" />
        {value === null ? (
          <span className="text-muted-foreground">Pick a date</span>
        ) : (
          <span className="tabular-nums">
            {triggerLabelFormat.format(new Date(`${value}T00:00`))}
          </span>
        )}
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner className="isolate z-50 outline-none" sideOffset={4}>
          <PopoverPrimitive.Popup
            className={cn(
              "origin-(--transform-origin) rounded-lg bg-popover p-3 text-popover-foreground shadow-(--shadow-popover) ring-1 ring-foreground/8 transition-[opacity,scale] duration-140 ease-(--ease-out) outline-none data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-ending-style:duration-100 data-starting-style:scale-[0.97] data-starting-style:opacity-0",
              className,
            )}
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <PopoverPrimitive.Title className="text-[13px] font-medium">
                {monthLabelFormat.format(new Date(`${viewMonth}-01T00:00`))}
              </PopoverPrimitive.Title>
              <span className="flex gap-1">
                <MonthButton
                  label="Previous month"
                  onClick={() => {
                    const previous = monthStep(focusedDay, -1);

                    setViewMonth(monthOf(previous));
                    setFocusedDay(previous);
                  }}
                >
                  <ChevronLeftIcon aria-hidden strokeWidth={1.75} className="size-3.5" />
                </MonthButton>
                <MonthButton
                  label="Next month"
                  onClick={() => {
                    const next = monthStep(focusedDay, 1);

                    setViewMonth(monthOf(next));
                    setFocusedDay(next);
                  }}
                >
                  <ChevronRightIcon aria-hidden strokeWidth={1.75} className="size-3.5" />
                </MonthButton>
              </span>
            </div>
            <div
              ref={gridRef}
              role="grid"
              aria-label={label}
              onKeyDown={onKeyDown}
              className="flex flex-col gap-1 outline-none"
            >
              <div role="row" className="flex gap-1">
                {WEEKDAYS.map((weekday, index) => (
                  <span
                    key={weekday + index}
                    role="columnheader"
                    aria-label={weekdayLongFormat.format(
                      new Date(WEEK_ANCHOR.getFullYear(), WEEK_ANCHOR.getMonth(), 1 + index),
                    )}
                    className="grid size-8 place-items-center text-[11px] text-muted-foreground"
                  >
                    {weekday}
                  </span>
                ))}
              </div>
              {weeks.map((week, weekIndex) => (
                <div key={weekIndex} role="row" className="flex gap-1">
                  {week.map((day, dayIndex) => {
                    if (day === null)
                      return <span key={dayIndex} role="gridcell" className="size-8" />;

                    const chosen = day === value;
                    const disabled = min !== undefined && day < min;

                    return (
                      <div key={day} role="gridcell" aria-selected={chosen} className="contents">
                        <button
                          type="button"
                          tabIndex={day === focusedDay ? 0 : -1}
                          aria-disabled={disabled}
                          aria-label={dayLabelFormat.format(new Date(`${day}T00:00`))}
                          onClick={() => {
                            if (!disabled) choose(day);
                          }}
                          onFocus={() => setFocusedDay(day)}
                          className={cn(
                            "grid size-8 place-items-center rounded-md text-[13px] tabular-nums outline-none select-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 aria-disabled:cursor-not-allowed aria-disabled:opacity-40",
                            day === today &&
                              "font-medium underline decoration-foreground/25 underline-offset-2",
                            chosen &&
                              "bg-primary text-primary-foreground hover:bg-primary focus-visible:ring-primary/50",
                          )}
                        >
                          {dayNumber(day)}
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function MonthButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="grid size-7 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      {children}
    </button>
  );
}

export { DatePicker };
