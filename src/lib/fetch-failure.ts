function collectErrorText(error: unknown) {
  const parts: string[] = [];

  if (error instanceof Error) {
    parts.push(error.message);
  }

  if (error && typeof error === "object" && "cause" in error) {
    const cause = (error as { cause?: unknown }).cause;

    if (cause instanceof Error) {
      parts.push(cause.message);
    } else if (cause && typeof cause === "object") {
      if ("code" in cause && typeof (cause as { code?: unknown }).code === "string") {
        parts.push((cause as { code: string }).code);
      }

      if (
        "message" in cause &&
        typeof (cause as { message?: unknown }).message === "string"
      ) {
        parts.push((cause as { message: string }).message);
      }
    }
  }

  return parts.join(" :: ");
}

export function describeFetchFailure(sourceId: string, error: unknown) {
  const details = collectErrorText(error);

  if (/ENOTFOUND|getaddrinfo|resolve host|dns/i.test(details)) {
    return `Source ${sourceId} could not be reached because DNS resolution failed in the current runtime.`;
  }

  if (/timed out|timeout|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(details)) {
    return `Source ${sourceId} could not be reached before the request timeout elapsed.`;
  }

  if (/ECONNREFUSED/i.test(details)) {
    return `Source ${sourceId} could not be reached because the connection was refused.`;
  }

  if (/ECONNRESET|socket hang up/i.test(details)) {
    return `Source ${sourceId} could not be reached because the connection was interrupted.`;
  }

  if (/fetch failed/i.test(details)) {
    return `Source ${sourceId} could not be reached because outbound network access is unavailable in the current runtime.`;
  }

  return `Source ${sourceId} could not be reached.`;
}

export function mapUpstreamStatusCode(statusCode: number) {
  if (statusCode === 429 || statusCode >= 500) {
    return 503;
  }

  return 502;
}

export function isLikelyRuntimeNetworkIssue(message: string) {
  return /dns resolution failed|outbound network access is unavailable|request timeout elapsed|connection was refused|connection was interrupted/i.test(
    message,
  );
}
