import { Link } from 'react-router';
import { PageFrame } from '../components/PageFrame.tsx';

export function NotFoundPage() {
  return (
    <PageFrame
      title="Page not found"
      summary="This address does not match any page in DataSentinel."
    >
      <p>
        <Link to="/">Go to Overview</Link>
      </p>
    </PageFrame>
  );
}
