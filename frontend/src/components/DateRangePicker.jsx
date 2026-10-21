import { useEffect, useRef, useState } from 'react';
import { addDays, formatDay, formatRangeLabel, parseDay } from '../utils/dateRanges.js';

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTH_TITLE = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });

// The 6x7 grid of days shown for one month, starting on the Sunday on
// or before the 1st.
function monthGrid(monthStart) {
  const first = addDays(monthStart, -parseDay(monthStart).getUTCDay());
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}

function shiftMonth(monthStart, delta) {
  const date = parseDay(monthStart);
  date.setUTCMonth(date.getUTCMonth() + delta);
  return formatDay(date);
}

// A button showing the chosen range that opens a one-month calendar.
// First click picks the start, second the end (clicking before the start
// restarts the range). Days after `maxDate` can't be picked.
export default function DateRangePicker({ value, onChange, maxDate }) {
  const [open, setOpen] = useState(false);
  const [pendingStart, setPendingStart] = useState(null);
  const [hoverDay, setHoverDay] = useState(null);
  const [viewMonth, setViewMonth] = useState(`${(value?.dateTo || maxDate).slice(0, 7)}-01`);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) close();
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  function close() {
    setOpen(false);
    setPendingStart(null);
    setHoverDay(null);
  }

  function toggleOpen() {
    if (open) return close();
    setViewMonth(`${(value?.dateTo || maxDate).slice(0, 7)}-01`);
    setOpen(true);
  }

  function pickDay(day) {
    if (!pendingStart || day < pendingStart) {
      setPendingStart(day);
      return;
    }
    onChange({ dateFrom: pendingStart, dateTo: day });
    close();
  }

  // While picking the end, preview the range up to the hovered day.
  const rangeFrom = pendingStart || value?.dateFrom;
  const rangeTo = pendingStart ? (hoverDay && hoverDay >= pendingStart ? hoverDay : pendingStart) : value?.dateTo;
  const monthPrefix = viewMonth.slice(0, 7);
  const canGoNext = shiftMonth(viewMonth, 1) <= maxDate;

  return (
    <div className="range-picker" ref={rootRef}>
      <button type="button" className="range-picker-trigger" onClick={toggleOpen} aria-expanded={open}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M3 10h18M8 3v4M16 3v4" />
        </svg>
        {value ? formatRangeLabel(value) : 'Pick dates'}
      </button>

      {open && (
        <div className="range-picker-pop" role="dialog" aria-label="Choose a date range">
          <div className="range-picker-head">
            <button type="button" onClick={() => setViewMonth(shiftMonth(viewMonth, -1))} aria-label="Previous month">‹</button>
            <span>{MONTH_TITLE.format(parseDay(viewMonth))}</span>
            <button type="button" onClick={() => setViewMonth(shiftMonth(viewMonth, 1))} disabled={!canGoNext} aria-label="Next month">›</button>
          </div>
          <div className="range-picker-grid">
            {WEEKDAYS.map((w) => <div key={w} className="range-picker-weekday">{w}</div>)}
            {monthGrid(viewMonth).map((day) => {
              const inRange = rangeFrom && rangeTo && day >= rangeFrom && day <= rangeTo;
              const isEdge = day === rangeFrom || day === rangeTo;
              const className = [
                'range-picker-day',
                day.slice(0, 7) !== monthPrefix && 'outside',
                inRange && 'in-range',
                inRange && isEdge && 'edge',
              ].filter(Boolean).join(' ');
              return (
                <button
                  key={day}
                  type="button"
                  className={className}
                  disabled={day > maxDate}
                  onClick={() => pickDay(day)}
                  onMouseEnter={() => setHoverDay(day)}
                >
                  {Number(day.slice(8))}
                </button>
              );
            })}
          </div>
          <div className="range-picker-hint">
            {pendingStart ? 'Now pick the end date' : 'Pick the start date'}
          </div>
        </div>
      )}
    </div>
  );
}
