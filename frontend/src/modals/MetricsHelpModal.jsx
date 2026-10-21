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
            Productive Hrs % = Productive time ÷ (Login hours − Break allowance) × 100
          </div>
          <ul>
            <li><strong>Productive time</strong> - Production, Admin, Adhoc, Coaching, Meeting and Training.</li>
            <li>
              <strong>Login hours</strong> - all aux time logged <em>inside</em> the agent's scheduled hours, so it can
              never be more than the schedule. Overtime only counts once it has been added to the schedule.
            </li>
            <li>
              <strong>Break allowance</strong> - based on the login hours:
              <table className="metrics-help-colors" style={{ margin: '6px 0' }}>
                <thead><tr><th>Login hours</th><th>Allowance</th></tr></thead>
                <tbody>
                  <tr><td>6h or less</td><td>0.5h</td></tr>
                  <tr><td>over 6h, up to 9h</td><td>1h</td></tr>
                  <tr><td>over 9h, up to 12h</td><td>1.5h</td></tr>
                  <tr><td>over 12h</td><td>2h</td></tr>
                </tbody>
              </table>
            </li>
            <li>Never shown above 100%. With no schedule loaded for the day it shows <strong>N/A</strong> - the time is kept and is calculated as soon as a schedule is added.</li>
          </ul>
          <div className="metrics-example">
            <div className="metrics-example-title">Example - full 9h shift</div>
            Shift 8:00 AM - 5:00 PM. Inside it the agent logs Production 6.5h, Meeting 0.5h, Lunch 1h, Break 0.5h, Idle 0.5h (9h in total).
            <div className="metrics-calc">(6.5 + 0.5) ÷ (9 − 1) = 7 ÷ 8 = <strong>87.5%</strong></div>
          </div>
          <div className="metrics-example" style={{ marginTop: 8 }}>
            <div className="metrics-example-title">Example - stayed late without overtime</div>
            Same 9h shift, but the agent stays logged in until 7:00 PM. Only the 9 scheduled hours count, so the
            allowance stays 1h and the extra 2 hours are left out of both sides. If 2h of overtime had been added to
            the schedule, login hours would be 11h and the allowance 1.5h: 11 − 1.5 = 9.5h denominator.
          </div>
          <div className="metrics-example" style={{ marginTop: 8 }}>
            <div className="metrics-example-title">Example - early in the shift</div>
            2h in, all of it Production: 2 ÷ (2 − 0.5) would be 133%, so it shows <strong>100%</strong>.
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
            Agent A: 7.2h productive ÷ 8h (90%). Agent B: 1h productive ÷ 2h (50%) - each after their own break allowance.
            <div className="metrics-calc">(7.2 + 1) ÷ (8 + 2) = <strong>82%</strong> - not (90 + 50) ÷ 2 = 70%</div>
            Days without a schedule are left out of both numbers entirely instead of counting as 0%.
          </div>
        </section>

        <section>
          <h3>Live view hourly charts</h3>
          <p>
            These use all recorded aux time in each clock hour, scheduled or not, and no break allowance, so they
            can differ from the Today cards.
          </p>
          <ul>
            <li><strong>Average aux time per agent</strong> - each aux code's total minutes in the hour ÷ the number of agents who recorded any time in that hour.</li>
            <li><strong>Productive Share</strong> - productive minutes ÷ all recorded minutes in the hour, across those agents.</li>
          </ul>
          <div className="metrics-example">
            <div className="metrics-example-title">Example - 9 AM to 10 AM</div>
            3 agents record Production 150m, Break 15m and Idle 15m between them.
            <div className="metrics-calc">Production 150 ÷ 3 = <strong>50m</strong> · Break 15 ÷ 3 = <strong>5m</strong> · Idle 15 ÷ 3 = <strong>5m</strong></div>
            <div className="metrics-calc">Productive Share = 150 ÷ 180 = <strong>83.3%</strong></div>
            The current hour is still in progress, so its bar is shorter until the hour ends.
          </div>
        </section>

        <section>
          <h3>Colors</h3>
          <table className="metrics-help-colors">
            <thead>
              <tr><th /><th>Productive Hrs</th><th>Adherence</th></tr>
            </thead>
            <tbody>
              <tr><td><span className="metrics-swatch" style={{ background: '#1e3a8a' }} />Dark blue</td><td>98% +</td><td>98% +</td></tr>
              <tr><td><span className="metrics-swatch" style={{ background: '#166534' }} />Green</td><td>95 - 97.99%</td><td>95 - 97.99%</td></tr>
              <tr><td><span className="metrics-swatch" style={{ background: '#c2660a' }} />Orange</td><td>90 - 94.99%</td><td>90 - 94.99%</td></tr>
              <tr><td><span className="metrics-swatch" style={{ background: '#b91c1c' }} />Red</td><td>below 90%</td><td>below 90%</td></tr>
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
