import './Timeline.css';

export interface TimelineEvent {
  id: string;
  time: string;
  /** Who or what caused it, e.g. "Scheduler" or a person's name. */
  actor: string;
  text: string;
}

interface TimelineProps {
  /** Accessible name of the list, e.g. "Recent activity". */
  label: string;
  /** In display order, usually newest first. */
  events: readonly TimelineEvent[];
}

/** Check, pipeline, and incident events with a clear actor and time. */
export function Timeline({ label, events }: TimelineProps) {
  return (
    <ol className="timeline" aria-label={label}>
      {events.map((event) => (
        <li key={event.id} className="timeline__event">
          <p className="timeline__time">{event.time}</p>
          <p>{event.text}</p>
          <p className="timeline__actor">{event.actor}</p>
        </li>
      ))}
    </ol>
  );
}
