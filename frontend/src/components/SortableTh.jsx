// Shared clickable header cell for sortable tables (Agents, Users, and
// any future table). Shows an arrow next to whichever column is
// currently sorted; clicking a column sorts it ascending, clicking the
// SAME column again flips to descending - clicking a different column
// always starts fresh at ascending, same convention as most sortable
// tables/spreadsheets.
export default function SortableTh({ label, sortKey, sort, onSort, ...thProps }) {
  const isActive = sort.key === sortKey;
  const arrow = isActive ? (sort.dir === 'asc' ? ' \u25B2' : ' \u25BC') : '';
  return (
    <th
      onClick={() => onSort(sortKey)}
      style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
      title={`Sort by ${label}`}
      aria-sort={isActive ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      {...thProps}
    >
      {label}{arrow}
    </th>
  );
}

/**
 * Toggle helper for the (key, dir) sort state SortableTh expects -
 * pass as the onSort handler along with the sort/setSort pair from
 * useState({ key: null, dir: 'asc' }).
 */
export function toggleSort(sort, setSort, key) {
  setSort((prev) =>
    prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }
  );
}
