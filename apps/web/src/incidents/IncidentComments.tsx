import {
  INCIDENT_COMMENT_MAX,
  type IncidentCommentItem,
  type IncidentDetail,
} from '@datasentinel/contracts';
import { useRef, useState } from 'react';
import { ApiError, apiFetch } from '../api/client.ts';
import { formatTime } from '../format.ts';
import './IncidentComments.css';

/** The "Comments" panel: plain-text comments, oldest first, and a form for
 * analysts and above. Comments are never edited or deleted. */
export function IncidentComments({
  workspaceId,
  incident,
  canPost,
  onUpdated,
}: {
  workspaceId: string;
  incident: IncidentDetail;
  canPost: boolean;
  onUpdated: (next: IncidentDetail) => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const running = useRef(false);

  async function post() {
    if (running.current) return;
    const trimmed = text.trim();
    if (trimmed === '') {
      setError('Write a comment.');
      return;
    }
    running.current = true;
    setPending(true);
    setError(null);
    try {
      const created = await apiFetch<IncidentCommentItem>(
        `/workspaces/${workspaceId}/incidents/${incident.id}/comments`,
        { method: 'POST', body: JSON.stringify({ text: trimmed }) },
      );
      onUpdated({ ...incident, comments: [...incident.comments, created] });
      setText('');
    } catch (e) {
      setError(
        e instanceof ApiError ? (e.detail ?? e.message) : 'The comment could not be posted.',
      );
    } finally {
      running.current = false;
      setPending(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="comments-title">
      <h2 id="comments-title" className="panel__title">
        Comments
      </h2>
      {incident.comments.length === 0 ? (
        <p>No comments yet.</p>
      ) : (
        <ul className="incident-comments">
          {incident.comments.map((c) => (
            <li key={c.id}>
              <p className="incident-comments__meta">
                {c.authorName ?? 'Former member'} · {formatTime(c.createdAt)}
              </p>
              <p className="incident-comments__text">{c.text}</p>
            </li>
          ))}
        </ul>
      )}
      {canPost && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void post();
          }}
        >
          <label className="incident-comment-form">
            Add a comment
            <textarea
              className="text-input"
              rows={3}
              maxLength={INCIDENT_COMMENT_MAX}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          {error !== null && <p role="alert">{error}</p>}
          <button
            type="submit"
            className="button button--primary"
            aria-disabled={pending || undefined}
          >
            Post comment
          </button>
        </form>
      )}
    </section>
  );
}
