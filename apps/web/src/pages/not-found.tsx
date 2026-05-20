import { Link } from 'react-router-dom';

export function NotFound() {
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center text-center">
      <h1 className="text-2xl font-semibold">Not found</h1>
      <p className="mt-2 text-sm text-slate-600">
        That page does not exist.{' '}
        <Link className="underline" to="/dashboard">
          Back to dashboard
        </Link>
        .
      </p>
    </div>
  );
}
