// How the dashboard's Productive Hrs % and Schedule Adherence % are
// worked out - kept in sync with /api/reports/efficiency and
// /api/reports/live-agents (backend/routes/reportRoutes.js).
export default function MetricsHelpModal({ onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box metrics-help" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="How the numbers are calculated">
        <h2>How the numbers are calculated</h2>

        <p className="metrics-help-note">
          Both numbers are <strong>running totals as of right now</strong>. Scheduled time only counts once it has
          started, so the rest of today's shift and any future day's schedule are never in the denominator. The aux an
          agent is currently in counts up to the current minute.
        </p>

        <section>
          <h3>Productive Hrs %</h3>
          <div className="metrics-formula">
            Productive Hrs % = Productive time ÷ Counted time × 100
          </div>
          <ul>
            <li><strong>Productive time</strong> - Production, Admin, Adhoc, Coaching, Meeting and Training.</li>
            <li><strong>Counted time</strong> - all aux time logged <em>inside</em> the agent's scheduled hours. On a day with no schedule loaded, all logged time counts.</li>
          </ul>
          <div className="metrics-example">
            <div className="metrics-example-title">Example</div>
            Shift 8:00 AM - 5:00 PM. Inside it the agent logs Production 6h, Meeting 0.5h, Lunch 1h, Break 0.5h, Idle 0.5h.
            <div className="metrics-calc">(6 + 0.5) ÷ (6 + 0.5 + 1 + 0.5 + 0.5) = 6.5 ÷ 8.5 = <strong>76.5%</strong></div>
            Time logged before 8:00 AM or after 5:00 PM is left out of both sides.
          </div>
        </section>

        <section>
          <h3>Schedule Adherence %</h3>
          <div className="metrics-formula">
            Adherence % = (Logged time inside schedule + Credited reconnect gaps) ÷ Scheduled time elapsed so far × 100
          </div>
          <ul>
            <li><strong>Scheduled time elapsed</strong> - scheduled minutes from the shift start up to now (or the full shift once it has ended).</li>
            <li><strong>Credited reconnect gaps</strong> - time between one desktop login ending and the next one starting (reconnects, switching PCs) counts as adherent, unless the agent was in Idle when they logged out.</li>
            <li>Starting late or leaving early is never credited.</li>
          </ul>
          <div className="metrics-example">
            <div className="metrics-example-title">Example - checked at 12:00 PM</div>
            Shift 8:00 AM - 5:00 PM, so 4h of it has elapsed (the remaining 5h don't count yet). The agent logs in at
            8:15 AM and drops off from 10:00 to 10:10 AM while in Production.
            <div className="metrics-calc">(3h 35m logged + 10m credited) ÷ 4h = 3.75 ÷ 4 = <strong>93.8%</strong></div>
            The 15 minutes late at the start are not credited.
          </div>
        </section>

        <section>
          <h3>Several agents or days</h3>
          <p>
            Hours are added up first and divided once - percentages are never averaged, so a long day weighs more
            than a short one.
          </p>
          <div className="metrics-example">
            <div className="metrics-example-title">Example</div>
            Agent A: 7.2h productive of 8h (90%). Agent B: 1h productive of 2h (50%).
            <div className="metrics-calc">(7.2 + 1) ÷ (8 + 2) = <strong>82%</strong> - not (90 + 50) ÷ 2 = 70%</div>
            Days without a schedule are left out of adherence entirely instead of counting as 0%.
          </div>
        </section>

        <section>
          <h3>Colors</h3>
          <table className="metrics-help-colors">
            <thead>
              <tr><th /><th>Productive Hrs</th><th>Adherence</th></tr>
            </thead>
            <tbody>
              <tr><td><span className="metrics-swatch" style={{ background: '#1e3a8a' }} />Dark blue</td><td>88% +</td><td>95% +</td></tr>
              <tr><td><span className="metrics-swatch" style={{ background: '#166534' }} />Green</td><td>85 - 87.9%</td><td>90 - 94.9%</td></tr>
              <tr><td><span className="metrics-swatch" style={{ background: '#c2660a' }} />Orange</td><td>80 - 84.9%</td><td>80 - 89.9%</td></tr>
              <tr><td><span className="metrics-swatch" style={{ background: '#b91c1c' }} />Red</td><td>below 80%</td><td>below 80%</td></tr>
            </tbody>
          </table>
        </section>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Got it</button>
        </div>
      </div>
    </div>
  );
}
