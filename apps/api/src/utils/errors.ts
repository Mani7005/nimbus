export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred";
}

export function getCommandErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const commandError = error as { stderr?: unknown; message?: unknown };
    if (typeof commandError.stderr === "string" && commandError.stderr.trim()) {
      return commandError.stderr.trim();
    }
    if (typeof commandError.message === "string") {
      return commandError.message.trim();
    }
  }

  return "Command execution failed";
}
