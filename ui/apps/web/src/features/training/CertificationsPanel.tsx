import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { canManageTraining } from '../../auth/roles';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Button, Card, ConfirmDialog, Skeleton, TextInput } from '../../components/ui';
import {
  createCertification,
  listCertifications,
  revokeCertification,
  uploadCertificationAttachment,
} from './api';
import type { Certification, CreateCertificationInput } from './types';

const emptyForm: CreateCertificationInput = {
  certType: '',
  issueDate: '',
  expiryDate: '',
  issuingAuthority: '',
};

interface PendingUpload {
  certId: string;
  uploadUrl: string;
  file: File;
}

export function CertificationsPanel({ memberId }: { memberId: string }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const isTraining = canManageTraining(auth.roles);
  const queryKey = ['training', 'certifications', memberId];

  const [form, setForm] = useState<CreateCertificationInput>(emptyForm);
  const [file, setFile] = useState<File | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingUpload, setPendingUpload] = useState<PendingUpload | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<Certification | null>(null);

  const certsQuery = useQuery({
    queryKey,
    queryFn: () => listCertifications(auth, memberId),
  });

  const attemptUpload = async (upload: PendingUpload) => {
    try {
      await uploadCertificationAttachment(upload.uploadUrl, upload.file);
      setPendingUpload(null);
      setUploadError(null);
    } catch {
      setPendingUpload(upload);
      setUploadError('Attachment upload failed. You can retry without creating a duplicate.');
    }
  };

  const createMutation = useMutation({
    mutationFn: (input: CreateCertificationInput) => createCertification(auth, memberId, input),
    onSuccess: async (created: Certification) => {
      setForm(emptyForm);
      setFormError(null);
      await queryClient.invalidateQueries({ queryKey });
      if (created.uploadUrl && file) {
        await attemptUpload({ certId: created.certId, uploadUrl: created.uploadUrl, file });
      }
      setFile(null);
    },
    onError: (error: Error) => {
      setFormError(error.message);
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (certId: string) => revokeCertification(auth, memberId, certId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    createMutation.mutate({ ...form, attachmentFilename: file?.name });
  };

  if (certsQuery.error) {
    return (
      <ApiForbiddenGate error={certsQuery.error} embedded>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  return (
    <Card title="Certifications" style={{ marginTop: 'var(--bx-space-lg)' }}>
      {certsQuery.isLoading ? (
        <Skeleton lines={3} />
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {(certsQuery.data ?? []).map((cert) => (
            <li
              key={cert.certId}
              style={{
                padding: 'var(--bx-space-sm) 0',
                borderBottom: '1px solid var(--bx-border-decorative)',
              }}
            >
              <strong>{cert.certType}</strong> — {cert.status} · expires {cert.expiryDate} ·{' '}
              {cert.issuingAuthority}
              {cert.attachmentS3Key ? (
                <>
                  {' '}
                  · <span>attachment: {cert.attachmentS3Key.split('/').pop()}</span>
                </>
              ) : null}
              {isTraining && cert.status !== 'REVOKED' ? (
                <>
                  {' '}
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    onClick={() => setRevokeTarget(cert)}
                  >
                    Revoke
                  </Button>
                </>
              ) : null}
            </li>
          ))}
          {(certsQuery.data ?? []).length === 0 ? <li>No certifications on file.</li> : null}
        </ul>
      )}

      {pendingUpload ? (
        <div role="alert" style={{ marginTop: 'var(--bx-space-sm)' }}>
          <p>{uploadError}</p>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void attemptUpload(pendingUpload)}
          >
            Retry upload
          </Button>
        </div>
      ) : null}

      {isTraining ? (
        <form
          onSubmit={onSubmit}
          aria-label="Add certification"
          style={{
            marginTop: 'var(--bx-space-lg)',
            display: 'grid',
            gap: 'var(--bx-space-md)',
            maxWidth: 480,
          }}
        >
          <TextInput
            label="Certification type"
            value={form.certType}
            onChange={(e) => setForm((prev) => ({ ...prev, certType: e.target.value }))}
            required
          />
          <TextInput
            label="Issue date"
            type="date"
            value={form.issueDate}
            onChange={(e) => setForm((prev) => ({ ...prev, issueDate: e.target.value }))}
            required
          />
          <TextInput
            label="Expiry date"
            type="date"
            value={form.expiryDate}
            onChange={(e) => setForm((prev) => ({ ...prev, expiryDate: e.target.value }))}
            required
          />
          <TextInput
            label="Issuing authority"
            value={form.issuingAuthority}
            onChange={(e) => setForm((prev) => ({ ...prev, issuingAuthority: e.target.value }))}
            required
          />
          <label style={{ display: 'grid', gap: 4 }}>
            Attachment (optional)
            <input
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              style={{ minHeight: 44 }}
            />
          </label>
          {formError ? (
            <p role="alert" aria-live="assertive">
              {formError}
            </p>
          ) : null}
          <Button type="submit" loading={createMutation.isPending}>
            Add certification
          </Button>
        </form>
      ) : null}

      {/* Revoke is irreversible: confirm, naming the certification (PR #321 review m2/m3).
          The dialog shows a failed revoke inline instead of closing blind. */}
      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title={`Revoke ${revokeTarget?.certType ?? 'certification'}?`}
        consequence={`${revokeTarget?.certType ?? 'This certification'} (${revokeTarget?.issuingAuthority ?? ''}) will be marked revoked for this member. This cannot be undone.`}
        confirmLabel="Revoke certification"
        danger
        onConfirm={async () => {
          if (revokeTarget) await revokeMutation.mutateAsync(revokeTarget.certId);
        }}
      />
    </Card>
  );
}
