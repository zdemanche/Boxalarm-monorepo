import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/apiClient';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Button, Card, ConfirmDialog } from '../../components/ui';
import { startExport, getExportStatus } from './api';

const EXPORT_POLL_INTERVAL_MS = 3_000;

export function ExportSection() {
  const auth = useAuth();
  const [jobId, setJobId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [startForbidden, setStartForbidden] = useState<unknown>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const startMutation = useMutation({
    mutationFn: () => startExport(auth),
    onSuccess: (result) => {
      setStartError(null);
      setStartForbidden(null);
      setJobId(result.jobId);
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.problem.status === 403) {
        setStartError(null);
        setStartForbidden(error);
        return;
      }
      setStartForbidden(null);
      setStartError('Could not start the export. Try again.');
    },
  });

  const statusQuery = useQuery({
    queryKey: ['platform', 'export', jobId],
    queryFn: () => getExportStatus(auth, jobId as string),
    enabled: jobId !== null,
    refetchInterval: (query) =>
      query.state.data?.status === 'PENDING' ? EXPORT_POLL_INTERVAL_MS : false,
  });

  function handleExport() {
    setJobId(null);
    startMutation.mutate();
  }

  const status = statusQuery.data?.status;

  return (
    <Card title="Full department export">
      <Button
        type="button"
        onClick={() => setConfirmOpen(true)}
        loading={startMutation.isPending}
        variant="danger"
      >
        Export department data
      </Button>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Export all of your department's data?"
        consequence="Every department record (personnel, apparatus, incidents, training, settings) is exported to downloadable files. This writes an audit event visible to the chief."
        confirmLabel="Export department data"
        onConfirm={handleExport}
        danger
      />
      {startForbidden ? (
        <ApiForbiddenGate error={startForbidden} embedded>
          <p role="alert">Could not start the export.</p>
        </ApiForbiddenGate>
      ) : null}
      {startError ? (
        <p role="alert" aria-live="assertive">
          {startError}
        </p>
      ) : null}
      {jobId && statusQuery.error ? (
        <ApiForbiddenGate error={statusQuery.error} embedded>
          <p role="alert">Could not check export status.</p>
        </ApiForbiddenGate>
      ) : jobId && status === 'FAILED' ? (
        <p role="alert">The export failed. Try again.</p>
      ) : jobId && status === 'COMPLETE' && statusQuery.data?.status === 'COMPLETE' ? (
        <ul>
          {statusQuery.data.files.map((file) => (
            <li key={file.table}>
              <a href={file.url}>{file.table}</a>
            </li>
          ))}
        </ul>
      ) : jobId ? (
        <p role="status">Export in progress…</p>
      ) : null}
    </Card>
  );
}
