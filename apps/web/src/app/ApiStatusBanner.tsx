import type { DependencyName } from '@datasentinel/contracts';
import { StatusMark } from '../components/StatusMark.tsx';
import { useApiHealth } from './useApiHealth.ts';
import { useOnlineStatus } from './useOnlineStatus.ts';

/** Service names as users know them, not as the system is built. */
const serviceName: Record<DependencyName, string> = {
  database: 'database',
  redis: 'job queue',
  storage: 'file storage',
};

/** A strip above the page when the API is unreachable or not ready. Quiet
 * when all is well, and while offline (the offline banner explains that). */
export function ApiStatusBanner({
  baseUrl = import.meta.env.VITE_API_BASE_URL,
}: {
  baseUrl?: string;
}) {
  const health = useApiHealth(baseUrl);
  const online = useOnlineStatus();
  const show = online && (health.state === 'unreachable' || health.state === 'degraded');

  return (
    <div
      className="shell-banner"
      role="status"
      data-active={show || undefined}
      data-tone={health.state === 'unreachable' ? 'critical' : 'warning'}
    >
      {show && health.state === 'unreachable' && (
        <>
          <StatusMark tone="critical" label="Can't reach the DataSentinel API." />
          <span>Screens show sample data only. This check repeats every 30 seconds.</span>
        </>
      )}
      {show && health.state === 'degraded' && (
        <>
          <StatusMark
            tone="warning"
            label={`Some services aren't ready: ${health.down.map((d) => serviceName[d]).join(', ')}.`}
          />
          <span>New checks and uploads may fail until they recover.</span>
        </>
      )}
    </div>
  );
}
