import { formatVisitDate, formatVisitTime } from '../utils/clinic.js';

// The clinic visits table - read-only on the Reports page; onEdit (Med /
// Clinic users only) adds an Edit button per row, e.g. to fill in the
// time released once the employee leaves.
export default function ClinicVisitsTable({ visits, onEdit }) {
  return (
    <div className="report-table-wrap">
      <table className="report-table clinic-visits-table">
        <thead>
          <tr>
            <th>Date of Visit</th>
            <th>Employee ID</th>
            <th>Employee Name</th>
            <th>Time of Visit</th>
            <th>Chief Complaint</th>
            <th>Treatment / Intervention</th>
            <th>Time Released</th>
            <th>Seen By</th>
            {onEdit && <th aria-label="Actions" />}
          </tr>
        </thead>
        <tbody>
          {visits.map((v) => (
            <tr key={v.visitId}>
              <td>{formatVisitDate(v.visitDate)}</td>
              <td>{v.employeeId}</td>
              <td>
                {v.employeeName}
                {v.groupName && <div className="clinic-visit-group">{v.groupName}</div>}
              </td>
              <td>{formatVisitTime(v.timeOfVisit)}</td>
              <td className="clinic-visit-text">{v.chiefComplaint}</td>
              <td className="clinic-visit-text">{v.treatment || <em style={{ color: '#999' }}>-</em>}</td>
              <td>{v.timeReleased ? formatVisitTime(v.timeReleased) : <em style={{ color: '#999' }}>Not yet</em>}</td>
              <td>{v.seenBy}</td>
              {onEdit && (
                <td>
                  <button type="button" className="btn-secondary" onClick={() => onEdit(v)}>Edit</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
