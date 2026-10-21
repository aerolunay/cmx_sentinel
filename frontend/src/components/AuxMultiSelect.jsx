import { useEffect, useRef, useState } from 'react';
import { AUX_COLORS, formatAuxLabel } from '../utils/metrics.js';

// Multi-select dropdown of aux states with a "Select all" row. Works on
// the HIDDEN set rather than the selected one, so "all" also covers any
// state that shows up later without having to be ticked first.
// `counts` maps state -> how many agents are in it right now.
export default function AuxMultiSelect({ options, hidden, onChange, counts }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const selectAllRef = useRef(null);

  const selectedCount = options.filter((code) => !hidden.has(code)).length;
  const allSelected = selectedCount === options.length;
  const noneSelected = selectedCount === 0;

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = !allSelected && !noneSelected;
  }, [allSelected, noneSelected, open]);

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  function toggle(code) {
    const next = new Set(hidden);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    onChange(next);
  }

  function toggleAll() {
    onChange(allSelected ? new Set(options) : new Set());
  }

  let label = 'All states';
  if (noneSelected) label = 'No states';
  else if (!allSelected) {
    const picked = options.filter((code) => !hidden.has(code));
    label = picked.length === 1 ? formatAuxLabel(picked[0]) : `${picked.length} states`;
  }

  return (
    <div className="aux-select" ref={rootRef}>
      <button
        type="button"
        className={`aux-select-trigger${allSelected ? '' : ' filtered'}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
          <path d="M3 5h18l-7 8v6l-4 2v-8z" />
        </svg>
        {label}
      </button>

      {open && (
        <div className="aux-select-pop" role="listbox" aria-multiselectable="true" aria-label="Filter by aux state">
          <label className="aux-select-option aux-select-all">
            <input ref={selectAllRef} type="checkbox" checked={allSelected} onChange={toggleAll} />
            Select all
          </label>
          {options.map((code) => (
            <label key={code} className="aux-select-option">
              <input type="checkbox" checked={!hidden.has(code)} onChange={() => toggle(code)} />
              <span className="aux-select-swatch" style={{ background: AUX_COLORS[code] || '#6b7280' }} />
              <span className="aux-select-name">{formatAuxLabel(code)}</span>
              <span className="aux-select-count">{counts[code] || 0}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
