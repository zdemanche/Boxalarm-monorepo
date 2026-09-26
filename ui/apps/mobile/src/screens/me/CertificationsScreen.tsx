import { palette, spacing, typography } from '@boxalarm/design-tokens';
import { useEffect, useState } from 'react';
import Config from 'react-native-config';
import { FlatList, Text, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useOptionalAuth } from '../../auth/AuthContext';
import { getCertifications } from '../../features/training/api';
import { ApiError } from '../../lib/apiClient';
import {
  certificationStatusColor,
  certificationStatusLabel,
} from '../../features/me/certificationStatus';
import { mockMeRepository } from '../../features/me/mockMeRepository';
import type { Certification } from '../../features/me/types';

export function CertificationsScreen() {
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const auth = useOptionalAuth();
  const apiBaseUrl = Config.API_BASE_URL;
  const [certifications, setCertifications] = useState<Certification[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSampleData, setIsSampleData] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoadError(null);
      if (auth?.isAuthenticated && apiBaseUrl && auth.memberId) {
        // A signed-in member never sees the mock certifications: a 401/403 or any other failure
        // is shown as an error, so a revoked member can't mistake sample data for their own
        // credentials (PR #321 review M6).
        try {
          const result = await getCertifications(auth, apiBaseUrl, auth.memberId);
          if (!cancelled) {
            setIsSampleData(false);
            setCertifications(result);
          }
        } catch (error) {
          if (cancelled) return;
          setCertifications([]);
          setLoadError(
            error instanceof ApiError &&
              (error.problem.status === 401 || error.problem.status === 403)
              ? 'You do not have access to these certifications.'
              : 'Certifications could not be loaded. Check your connection and try again.',
          );
        }
        return;
      }
      // Not signed in / no API configured (local dev, demo): sample data, labelled as such.
      const fallback = await mockMeRepository.getCertifications();
      if (!cancelled) {
        setIsSampleData(true);
        setCertifications(fallback);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [auth, apiBaseUrl]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      {loadError ? (
        <Text
          accessibilityRole="alert"
          style={{ color: tokens.error, fontSize: typography.size.sm, padding: spacing.lg }}
        >
          {loadError}
        </Text>
      ) : null}
      {isSampleData ? (
        <Text
          style={{
            color: tokens.foreground,
            opacity: 0.7,
            fontSize: typography.size.sm,
            paddingHorizontal: spacing.lg,
            paddingTop: spacing.lg,
          }}
        >
          Sample data. Sign in to see your certifications.
        </Text>
      ) : null}
      <FlatList
        data={certifications}
        keyExtractor={(item) => item.certId}
        contentContainerStyle={{ padding: spacing.lg }}
        renderItem={({ item }) => (
          <View
            style={{
              paddingVertical: spacing.md,
              borderBottomWidth: 1,
              borderBottomColor: tokens.foreground + '22',
            }}
          >
            <Text
              style={{
                color: tokens.foreground,
                fontSize: typography.size.base,
                fontWeight: '600',
              }}
            >
              {item.certType}
            </Text>
            <Text
              style={{
                color: tokens.foreground,
                opacity: 0.7,
                fontSize: typography.size.sm,
                marginTop: 2,
              }}
            >
              {item.issuingAuthority} · expires {item.expiryDate}
            </Text>
            <Text
              style={{
                color: certificationStatusColor(item.status, tokens),
                fontSize: typography.size.sm,
                fontWeight: '600',
                marginTop: spacing.xs,
              }}
            >
              {certificationStatusLabel(item.status)}
            </Text>
          </View>
        )}
      />
    </SafeAreaView>
  );
}
