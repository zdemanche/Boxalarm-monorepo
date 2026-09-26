import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Button, Card, Skeleton } from '../../components/ui';
import { downloadTranscript, getTranscript } from './api';
import type { TranscriptExportFormat } from './types';

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function TranscriptPanel({ memberId }: { memberId: string }) {
  const auth = useAuth();

  const transcriptQuery = useQuery({
    queryKey: ['training', 'transcript', memberId],
    queryFn: () => getTranscript(auth, memberId),
  });

  const [exportError, setExportError] = useState<string | null>(null);

  const onExport = async (format: TranscriptExportFormat) => {
    setExportError(null);
    try {
      const blob = await downloadTranscript(auth, memberId, format);
      triggerDownload(blob, `transcript-${memberId}.${format}`);
    } catch {
      setExportError(`The ${format.toUpperCase()} export failed. Try again.`);
    }
  };

  if (transcriptQuery.error) {
    return (
      <ApiForbiddenGate error={transcriptQuery.error} embedded>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  if (transcriptQuery.isLoading || !transcriptQuery.data) {
    return (
      <Card title="Transcript">
        <Skeleton lines={4} />
      </Card>
    );
  }

  const transcript = transcriptQuery.data;
  const hasHistory = transcript.certifications.length > 0 || transcript.attendance.length > 0;

  return (
    <Card title="Transcript">
      <div style={{ display: 'flex', gap: 'var(--bx-space-sm)' }}>
        <Button type="button" variant="secondary" onClick={() => void onExport('csv')}>
          Export CSV
        </Button>
        <Button type="button" variant="secondary" onClick={() => void onExport('pdf')}>
          Export PDF
        </Button>
      </div>
      {exportError ? <p role="alert">{exportError}</p> : null}

      {!hasHistory ? (
        <p>No training history on file.</p>
      ) : (
        <>
          <h3 style={{ fontSize: 15, fontWeight: 600 }}>Certifications</h3>
          <ul>
            {transcript.certifications.map((cert) => (
              <li key={cert.certId}>
                {cert.certType} — {cert.status} · expires {cert.expiryDate}
              </li>
            ))}
          </ul>

          <h3 style={{ fontSize: 15, fontWeight: 600 }}>Attendance</h3>
          <ul>
            {transcript.attendance.map((record) => (
              <li key={`${record.eventId}-${record.startAt}`}>
                {record.category} — {record.hours}h on{' '}
                {new Date(record.startAt).toLocaleDateString()}
              </li>
            ))}
          </ul>

          <h3 style={{ fontSize: 15, fontWeight: 600 }}>Hours by category</h3>
          <ul>
            {Object.entries(transcript.hoursByCategory).map(([category, hours]) => (
              <li key={category}>
                {category}: {hours}h
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
