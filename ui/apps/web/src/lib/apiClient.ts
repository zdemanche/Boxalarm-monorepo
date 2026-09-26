import { demoRequest } from './demoFixtures';

export interface AuthTokenSource {
  getAccessToken: () => Promise<string | null>;
  renewSilently: () => Promise<string | null>;
}

/** RFC 7807 field-level validation entry (backend `validationProblem` / config `FieldError`). */
export interface ProblemFieldError {
  field: string;
  message: string;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  traceId: string;
  /** RFC 7807 extension member. Untrusted server JSON: read it through problemFieldErrors(). */
  errors?: unknown;
}

/** The well-formed `{ field, message }` entries of a problem's `errors` array; anything else
 * is dropped rather than rendered. */
export function problemFieldErrors(problem: ProblemDetails): ProblemFieldError[] {
  if (!Array.isArray(problem.errors)) return [];
  return problem.errors.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as { field?: unknown; message?: unknown };
    if (typeof record.field !== 'string' || typeof record.message !== 'string') return [];
    return [{ field: record.field, message: record.message }];
  });
}

export class ApiError extends Error {
  constructor(public readonly problem: ProblemDetails) {
    super(problem.title);
  }
}

export interface ApiRequestOptions extends Omit<RequestInit, 'headers'> {
  headers?: Record<string, string>;
}

const API_BASE = '/api/v1/';

export async function apiRequest(
  path: string,
  tokens: AuthTokenSource,
  options: ApiRequestOptions = {},
): Promise<Response> {
  if (import.meta.env.VITE_DEMO === 'true') {
    const response = await demoRequest(path, options);
    if (!response.ok) {
      const problem = (await response.json()) as ProblemDetails;
      throw new ApiError(problem);
    }
    return response;
  }

  const send = (token: string | null) =>
    fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        ...options.headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

  let response = await send(await tokens.getAccessToken());

  if (response.status === 401) {
    const renewedToken = await tokens.renewSilently();
    if (renewedToken) {
      response = await send(renewedToken);
    }
  }

  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as ProblemDetails | null;
    throw new ApiError(
      problem ?? {
        type: 'about:blank',
        title: response.statusText,
        status: response.status,
        traceId: 'unknown',
      },
    );
  }

  return response;
}
