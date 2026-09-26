import { FormEvent, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { Button, Card, StatusChip, TextInput } from '../../components/ui';
import { setServiceStatus } from './api';
import { serviceStatusRole } from './StatusBadge';
import type { ApparatusDetail } from './types';

function formatElapsed(elapsedSeconds: number): string {
  const days = Math.floor(elapsedSeconds / 86400);
  if (days <= 0) return 'today';
  return `${days} day${days === 1 ? '' : 's'}`;
}

export function ServiceStatusControls({ unit }: { unit: ApparatusDetail }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const canControl = auth.roles.includes('APPARATUS') || auth.roles.includes('CHIEF');
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (input: { status: 'IN_SERVICE' | 'OUT_OF_SERVICE'; reason?: string }) =>
      setServiceStatus(auth, unit.unitId, input.status, input.reason),
    onSuccess: () => {
      setReason('');
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ['apparatus', unit.unitId] });
      void queryClient.invalidateQueries({ queryKey: ['apparatus'] });
    },
    onError: (error: Error) => setFormError(error.message),
  });

  return (
    <Card title="Service status">
      <p role="status">
        <StatusChip status={serviceStatusRole(unit.status)}>
          {unit.status === 'IN_SERVICE' ? 'In service' : 'Out of service'}
        </StatusChip>
      </p>
      {unit.status === 'OUT_OF_SERVICE' && unit.outOfService ? (
        <p>
          {unit.outOfService.reason} since {formatElapsed(unit.outOfService.elapsedSeconds)} ago
        </p>
      ) : null}

      {!canControl ? (
        <p>Changing service status is limited to the apparatus officer and the chief.</p>
      ) : unit.status === 'IN_SERVICE' ? (
        <form
          aria-label="Place out of service"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (reason.trim().length === 0) {
              setFormError('reason is required when placing a unit out of service');
              return;
            }
            mutation.mutate({ status: 'OUT_OF_SERVICE', reason: reason.trim() });
          }}
          style={{ display: 'grid', gap: 'var(--bx-space-sm)', maxWidth: 480, marginTop: 16 }}
        >
          <TextInput
            label="Reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            error={formError ?? undefined}
          />
          <Button type="submit" style={{ maxWidth: 240 }}>
            Place out of service
          </Button>
        </form>
      ) : (
        <Button
          type="button"
          onClick={() => mutation.mutate({ status: 'IN_SERVICE' })}
          style={{ marginTop: 16 }}
        >
          Return to service
        </Button>
      )}
    </Card>
  );
}
