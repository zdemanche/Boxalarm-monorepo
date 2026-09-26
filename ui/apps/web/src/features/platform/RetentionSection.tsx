import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/apiClient';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Button, Card, ConfirmDialog, Skeleton, TextInput } from '../../components/ui';
import { getRetentionConfig, putRetentionConfig, runDisposal } from './api';
import { LIFE_SAFETY_RECORD_CLASSES, type DisposalResult } from './types';

const RETENTION_QUERY_KEY = ['platform', 'retention'];

export function RetentionSection() {
  const auth = useAuth();
  const queryClient = useQueryClient();

  const retentionQuery = useQuery({
    queryKey: RETENTION_QUERY_KEY,
    queryFn: () => getRetentionConfig(auth),
  });

  const [years, setYears] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [formForbidden, setFormForbidden] = useState<unknown>(null);
  const [disposalResult, setDisposalResult] = useState<DisposalResult | null>(null);
  const [disposalError, setDisposalError] = useState<string | null>(null);
  const [disposalForbidden, setDisposalForbidden] = useState<unknown>(null);
  const [confirmDisposalOpen, setConfirmDisposalOpen] = useState(false);

  useEffect(() => {
    if (retentionQuery.data) {
      setYears(String(retentionQuery.data.retentionYears));
    }
  }, [retentionQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (retentionYears: number) => putRetentionConfig(auth, retentionYears),
    onSuccess: async () => {
      setFormError(null);
      setFormForbidden(null);
      await queryClient.invalidateQueries({ queryKey: RETENTION_QUERY_KEY });
    },
    onError: async (error: unknown) => {
      if (error instanceof ApiError && error.problem.status === 409) {
        setFormForbidden(null);
        setFormError('Retention was updated concurrently. Showing the latest value.');
        await queryClient.invalidateQueries({ queryKey: RETENTION_QUERY_KEY });
        return;
      }
      if (error instanceof ApiError && error.problem.status === 403) {
        setFormError(null);
        setFormForbidden(error);
        return;
      }
      setFormForbidden(null);
      setFormError('Could not save the retention period.');
    },
  });

  const disposalMutation = useMutation({
    mutationFn: () => runDisposal(auth),
    onSuccess: (result) => {
      setDisposalError(null);
      setDisposalForbidden(null);
      setDisposalResult(result);
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.problem.status === 403) {
        setDisposalError(null);
        setDisposalForbidden(error);
        return;
      }
      setDisposalForbidden(null);
      setDisposalError('Disposal could not be run. Try again.');
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormForbidden(null);
    const parsed = Number(years);
    if (!Number.isInteger(parsed) || parsed < 1) {
      setFormError('Retention period must be a positive whole number of years.');
      return;
    }
    saveMutation.mutate(parsed);
  }

  const retentionYears = retentionQuery.data?.retentionYears;

  return (
    <Card title="Records retention">
      {retentionQuery.isLoading ? (
        <Skeleton lines={2} />
      ) : retentionQuery.error ? (
        <ApiForbiddenGate error={retentionQuery.error} embedded>
          <p role="alert">Unable to load the retention configuration.</p>
        </ApiForbiddenGate>
      ) : (
        <form
          onSubmit={handleSubmit}
          style={{ display: 'grid', gap: 'var(--bx-space-sm)', maxWidth: 320 }}
        >
          <TextInput
            label="Retention period (years)"
            type="number"
            min={1}
            step={1}
            value={years}
            onChange={(e) => setYears(e.target.value)}
            error={formError ?? undefined}
          />
          {formForbidden ? (
            <ApiForbiddenGate error={formForbidden} embedded>
              <p role="alert">Could not save the retention period.</p>
            </ApiForbiddenGate>
          ) : null}
          <Button type="submit" loading={saveMutation.isPending} style={{ width: 'fit-content' }}>
            Save retention period
          </Button>
        </form>
      )}

      <h3 style={{ fontSize: 17, fontWeight: 600, marginTop: 'var(--bx-space-lg)' }}>
        Not subject to automatic disposal
      </h3>
      <ul>
        {LIFE_SAFETY_RECORD_CLASSES.map((recordClass) => (
          <li key={recordClass}>{recordClass}</li>
        ))}
      </ul>

      <Button
        type="button"
        variant="danger"
        onClick={() => setConfirmDisposalOpen(true)}
        loading={disposalMutation.isPending}
        disabled={retentionQuery.isLoading || Boolean(retentionQuery.error)}
        style={{ marginTop: 'var(--bx-space-md)' }}
      >
        Run disposal
      </Button>
      <ConfirmDialog
        open={confirmDisposalOpen}
        onOpenChange={setConfirmDisposalOpen}
        title={`Permanently dispose of records older than ${retentionYears ?? '?'} years?`}
        consequence="Records past the retention period are permanently destroyed (deleted or crypto-shredded) and an audit event is written. Life-safety record classes listed above are not touched."
        confirmLabel="Run disposal"
        onConfirm={() => disposalMutation.mutate()}
        danger
      />
      {retentionQuery.error ? (
        <p role="alert">
          The retention period could not be confirmed, so disposal is disabled until it loads
          successfully.
        </p>
      ) : null}
      {disposalForbidden ? (
        <ApiForbiddenGate error={disposalForbidden} embedded>
          <p role="alert">Disposal could not be run.</p>
        </ApiForbiddenGate>
      ) : null}
      {disposalError ? (
        <p role="alert" aria-live="assertive">
          {disposalError}
        </p>
      ) : null}
      {disposalResult ? (
        <p role="status">
          {disposalResult.hardDeleted} deleted, {disposalResult.cryptoShredded} crypto-shredded,{' '}
          {disposalResult.refused.length} refused.
        </p>
      ) : null}
    </Card>
  );
}
